/**
 * Structured in-memory test database for wiki-server tests.
 *
 * Replaces fragile SQL string-matching dispatch functions with a structured
 * approach that parses INSERT column lists from the actual Drizzle-generated
 * SQL. This means new columns added via migrations are handled automatically
 * — no more hard-coded PARAMS_PER_ROW constants.
 *
 * Usage:
 *   const testDb = new TestDb();
 *   vi.mock("../db.js", () => mockDbModule(testDb.dispatch));
 *
 * The dispatch function routes SQL to the appropriate handler:
 *   - INSERT: extracts column names from SQL, maps params to columns, stores rows
 *   - SELECT: matches table + WHERE/ORDER BY/LIMIT patterns
 *   - DELETE: removes matching rows
 *   - COUNT/GROUP BY: aggregates over stored rows
 */

import type { SqlDispatcher } from "./test-utils.js";

// ---------------------------------------------------------------------------
// SQL parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the table name from an INSERT INTO statement.
 * Handles quoted ("claims") and unquoted table names.
 */
function extractInsertTable(sql: string): string | null {
  const m = sql.match(/insert\s+into\s+"?(\w+)"?/i);
  return m ? m[1] : null;
}

/**
 * Extract the column names from an INSERT INTO ... (col1, col2, ...) statement.
 * Drizzle generates: INSERT INTO "table" ("col1","col2",...) VALUES (...)
 */
function extractInsertColumns(sql: string): string[] {
  // Match the parenthesized column list after the table name
  const m = sql.match(/insert\s+into\s+"?\w+"?\s*\(([^)]+)\)/i);
  if (!m) return [];
  return m[1].split(",").map((c) => c.trim().replace(/"/g, ""));
}

/**
 * Parse the VALUES clause to determine which columns get params vs defaults.
 * Returns an array where each element is either:
 *   - 'default' (the column uses DEFAULT)
 *   - a number (the 1-based param index, e.g., 1 for $1)
 *
 * For multi-row inserts, returns the pattern for the first row.
 * Example: "(default, $1, $2, default)" → ['default', 1, 2, 'default']
 */
function parseValuesClause(sql: string): Array<'default' | number> {
  // Find the first "values (" ... ")" after the column list
  const valuesIdx = sql.toLowerCase().indexOf("values");
  if (valuesIdx < 0) return [];

  // Get the first parenthesized group after "values"
  const afterValues = sql.slice(valuesIdx + 6).trim();
  const openParen = afterValues.indexOf("(");
  if (openParen < 0) return [];

  // Find the matching closing paren
  let depth = 0;
  let closeParen = -1;
  for (let i = openParen; i < afterValues.length; i++) {
    if (afterValues[i] === "(") depth++;
    if (afterValues[i] === ")") {
      depth--;
      if (depth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  if (closeParen < 0) return [];

  const valuesContent = afterValues.slice(openParen + 1, closeParen);
  return valuesContent.split(",").map((v) => {
    const trimmed = v.trim().toLowerCase();
    if (trimmed === "default") return 'default' as const;
    // Extract param number from $N
    const m = trimmed.match(/\$(\d+)/);
    return m ? parseInt(m[1], 10) : ('default' as const);
  });
}

/**
 * Extract the table name from a DELETE FROM statement.
 */
function extractDeleteTable(sql: string): string | null {
  const m = sql.match(/delete\s+from\s+"?(\w+)"?/i);
  return m ? m[1] : null;
}

/**
 * Extract the primary table name from a SELECT ... FROM statement.
 */
function extractSelectTable(sql: string): string | null {
  const m = sql.match(/from\s+"?(\w+)"?/i);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// TestDb class
// ---------------------------------------------------------------------------

export class TestDb {
  /** Row storage by table name. Each row is a Record<string, unknown>. */
  private tables = new Map<string, Map<number, Record<string, unknown>>>();

  /** Auto-increment sequences by table name. */
  private sequences = new Map<string, number>();

  /** The dispatch function bound to this instance. Pass to mockDbModule(). */
  public dispatch: SqlDispatcher;

  constructor() {
    // Bind dispatch so it can be passed as a standalone function
    this.dispatch = this.handleQuery.bind(this);
  }

  /** Reset all tables and sequences. Call in beforeEach(). */
  reset(): void {
    this.tables.clear();
    this.sequences.clear();
  }

  /** Get all rows for a table (for test assertions). */
  getTable(tableName: string): Map<number, Record<string, unknown>> {
    return this.tables.get(tableName) ?? new Map();
  }

  /** Get the next auto-increment ID for a table. */
  private nextId(tableName: string): number {
    const current = this.sequences.get(tableName) ?? 0;
    const next = current + 1;
    this.sequences.set(tableName, next);
    return next;
  }

  /** Parse a JSONB param that may arrive as a JSON string from Drizzle. */
  private parseJsonbParam(val: unknown): unknown {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val ?? null;
  }

  // -----------------------------------------------------------------------
  // Main query dispatcher
  // -----------------------------------------------------------------------

  private handleQuery(query: string, params: unknown[]): unknown[] {
    const q = query.toLowerCase();
    // Debug: uncomment to see all SQL queries
    // console.log("[TestDb] SQL:", query.slice(0, 200), "| params:", params.length);

    // ---- Entity IDs health check ----
    if (q.includes("count(*)") && q.includes("entity_ids")) {
      return [{ count: 0 }];
    }
    if (q.includes("last_value")) {
      return [{ last_value: 0, is_called: false }];
    }

    // ---- Ref-check: SELECT id FROM table WHERE id IN (...) ----
    if (q.includes("as id from") && q.includes("where") && q.includes(" in ")) {
      return params.map((p) => ({ id: p }));
    }

    // ---- INSERT ----
    if (q.startsWith("insert")) {
      return this.handleInsert(query, params);
    }

    // ---- DELETE ----
    if (q.startsWith("delete")) {
      return this.handleDelete(query, params);
    }

    // ---- SELECT with COUNT / aggregation ----
    if (q.includes("count(*)")) {
      return this.handleCount(query, params);
    }

    // ---- SELECT (data queries) ----
    if (q.startsWith("select") || q.includes("from")) {
      return this.handleSelect(query, params);
    }

    return [];
  }

  // -----------------------------------------------------------------------
  // INSERT handler
  // -----------------------------------------------------------------------

  private handleInsert(query: string, params: unknown[]): unknown[] {
    const tableName = extractInsertTable(query);
    if (!tableName) return [];

    const columns = extractInsertColumns(query);
    if (columns.length === 0) return [];

    const valuesPattern = parseValuesClause(query);

    // Ensure table exists
    if (!this.tables.has(tableName)) {
      this.tables.set(tableName, new Map());
    }
    const table = this.tables.get(tableName)!;

    // Count how many params map to a single row (excludes DEFAULT slots)
    const paramsPerRow = valuesPattern.filter((v) => v !== 'default').length;
    const rowCount = paramsPerRow > 0 ? Math.max(1, Math.floor(params.length / paramsPerRow)) : 1;

    const results: Record<string, unknown>[] = [];
    const now = new Date();

    // JSONB columns that need parsing
    const jsonbColumns = new Set([
      "related_entities",
      "resource_ids",
      "qualifiers",
      "topics_json",
      "entities_json",
      "tags",
      "key_points",
      "key_claims",
      "custom_fields",
      "related_entries",
      "sources",
      "clusters",
    ]);

    // Build the mapping of which columns consume params vs use defaults.
    // For each column, track whether it takes a param (true) or uses DEFAULT (false).
    const columnIsParam: boolean[] = columns.map((_, j) => valuesPattern[j] !== 'default');

    // Global param cursor — each non-default column consumes the next param
    let paramCursor = 0;

    for (let i = 0; i < rowCount; i++) {
      const id = this.nextId(tableName);
      const row: Record<string, unknown> = {};

      for (let j = 0; j < columns.length; j++) {
        const col = columns[j];

        if (!columnIsParam[j]) {
          // Apply default values
          if (col === 'id') {
            row[col] = id;
          } else if (col === 'created_at' || col === 'updated_at' || col === 'added_at') {
            row[col] = now;
          } else {
            // Other defaults (e.g., claim_verified_at, source_checked_at) → null
            row[col] = null;
          }
        } else {
          // Consume the next param
          let val = params[paramCursor++];

          // Parse JSONB columns
          if (jsonbColumns.has(col)) {
            val = this.parseJsonbParam(val);
          }

          row[col] = val ?? null;
        }
      }

      // Ensure id is set
      if (row.id === undefined || row.id === null) {
        row.id = id;
      }

      table.set(id, row);
      results.push(row);
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // DELETE handler
  // -----------------------------------------------------------------------

  private handleDelete(query: string, params: unknown[]): unknown[] {
    const tableName = extractDeleteTable(query);
    if (!tableName) return [];

    const table = this.tables.get(tableName);
    if (!table) return [];

    const q = query.toLowerCase();
    const deleted: Record<string, unknown>[] = [];

    // DELETE ... WHERE entity_id = $1
    if (q.includes("entity_id")) {
      const entityId = params[0] as string;
      for (const [id, row] of table) {
        if (row.entity_id === entityId) {
          deleted.push(row);
          table.delete(id);
        }
      }
      return deleted;
    }

    // DELETE ... WHERE id IN (...) — for delete-by-ids
    if (q.includes(" in (")) {
      const ids = new Set(params.map(Number));
      for (const [id, row] of table) {
        if (ids.has(id)) {
          deleted.push(row);
          table.delete(id);
        }
      }
      return deleted;
    }

    // DELETE ... WHERE entity_id = $1 AND section = $2
    if (q.includes("section")) {
      const entityId = params[0] as string;
      const section = params[1] as string;
      for (const [id, row] of table) {
        if (row.entity_id === entityId && row.section === section) {
          deleted.push(row);
          table.delete(id);
        }
      }
      return deleted;
    }

    return deleted;
  }

  // -----------------------------------------------------------------------
  // COUNT / aggregation handler
  // -----------------------------------------------------------------------

  private handleCount(query: string, params: unknown[]): unknown[] {
    const q = query.toLowerCase();
    const tableName = extractSelectTable(query);
    if (!tableName) return [{ count: 0 }];

    const table = this.tables.get(tableName);
    const rows = table ? Array.from(table.values()) : [];

    // ---- GROUP BY queries ----
    if (q.includes("group by")) {
      // Determine the grouping column.
      // Drizzle generates: GROUP BY "table"."column" — we want the column name.
      const groupMatch = q.match(/group\s+by\s+(?:"?\w+"?\.)?"?(\w+)"?/i);
      if (!groupMatch) return [];
      const groupCol = groupMatch[1];

      const counts: Record<string, number> = {};
      for (const r of rows) {
        const key = (r[groupCol] as string) ?? "uncategorized";
        counts[key] = (counts[key] || 0) + 1;
      }
      return Object.entries(counts)
        .map(([key, count]) => ({ [groupCol]: key, count }))
        .sort((a, b) => b.count - a.count);
    }

    // ---- EXISTS subquery for claim_sources ----
    if (q.includes("exists") && q.includes("claim_sources")) {
      const sourceTable = this.tables.get("claim_sources");
      const claimIdsWithSources = new Set(
        sourceTable
          ? Array.from(sourceTable.values()).map((s) => Number(s.claim_id))
          : []
      );
      return [{ count: claimIdsWithSources.size }];
    }

    // ---- COUNT with WHERE clause (no GROUP BY) ----
    if (q.includes("where")) {
      // Extract WHERE portion
      const whereClause = q.split("where")[1] ?? "";

      // Special cases for IS NOT NULL checks
      if (whereClause.includes("related_entities") && whereClause.includes("is not null")) {
        let count = 0;
        for (const r of rows) {
          const re = r.related_entities;
          if (re && Array.isArray(re) && re.length > 0) count++;
        }
        return [{ count }];
      }

      if (whereClause.includes("fact_id") && whereClause.includes("is not null")) {
        let count = 0;
        for (const r of rows) {
          if (r.fact_id) count++;
        }
        return [{ count }];
      }

      if (whereClause.includes("value_numeric") && whereClause.includes("is not null")) {
        let count = 0;
        for (const r of rows) {
          if (r.value_numeric != null || r.value_low != null || r.value_high != null) count++;
        }
        return [{ count }];
      }

      if (whereClause.includes("property") && whereClause.includes("is not null")) {
        let count = 0;
        for (const r of rows) {
          if (r.property != null) count++;
        }
        return [{ count }];
      }

      // claim_mode = 'attributed'
      if (whereClause.includes("claim_mode") && !whereClause.includes("is not null")) {
        let count = 0;
        for (const r of rows) {
          if (r.claim_mode === "attributed") count++;
        }
        return [{ count }];
      }

      // Generic filter by equality params
      let count = 0;
      for (const r of rows) {
        let match = true;
        let paramIdx = 0;
        if (whereClause.includes("entity_type")) {
          if (r.entity_type !== params[paramIdx]) match = false;
          paramIdx++;
        }
        if (whereClause.includes("claim_type")) {
          if (r.claim_type !== params[paramIdx]) match = false;
          paramIdx++;
        }
        if (whereClause.includes("claim_category")) {
          if (r.claim_category !== params[paramIdx]) match = false;
          paramIdx++;
        }
        if (match) count++;
      }
      return [{ count }];
    }

    // ---- Simple COUNT(*) (total) ----
    return [{ count: rows.length }];
  }

  // -----------------------------------------------------------------------
  // SELECT handler
  // -----------------------------------------------------------------------

  private handleSelect(query: string, params: unknown[]): unknown[] {
    const q = query.toLowerCase();
    const tableName = extractSelectTable(query);
    if (!tableName) return [];

    const table = this.tables.get(tableName);
    if (!table) return [];
    const allRows = Array.from(table.values());

    // ---- claim_sources: SELECT WHERE claim_id = $1 ----
    if (tableName === "claim_sources") {
      if (q.includes("where") && q.includes("claim_id")) {
        // Check for IN (...) clause
        if (q.includes("in (")) {
          const ids = params.map(Number);
          return allRows.filter((s) => ids.includes(Number(s.claim_id)));
        }
        // Single claim_id match
        const claimId = Number(params[0]);
        return allRows.filter((s) => Number(s.claim_id) === claimId);
      }
      return allRows;
    }

    // ---- claims: SELECT WHERE entity_id = $1 OR related_entities @> ... ----
    if (
      tableName === "claims" &&
      q.includes("where") &&
      q.includes("order by") &&
      !q.includes("limit") &&
      (q.includes('"entity_id" =') || q.includes("related_entities @>"))
    ) {
      const entityId = params[0] as string;
      return allRows
        .filter((r) => {
          if (r.entity_id === entityId) return true;
          const re = r.related_entities;
          if (Array.isArray(re) && re.includes(entityId)) return true;
          return false;
        })
        .sort((a, b) => {
          const typeCompare = (a.claim_type as string).localeCompare(b.claim_type as string);
          if (typeCompare !== 0) return typeCompare;
          return (a.id as number) - (b.id as number);
        });
    }

    // ---- claims: SELECT WHERE id = $1 LIMIT 1 (get by ID) ----
    if (
      tableName === "claims" &&
      q.includes("where") &&
      q.includes("limit") &&
      !q.includes("order by")
    ) {
      const whereClause = q.split("where")[1] || "";
      if (whereClause.includes('"id"')) {
        const id = params[0] as number;
        const row = table.get(id);
        return row ? [row] : [];
      }
    }

    // ---- claims: SELECT with ORDER BY + LIMIT (paginated /all) ----
    if (
      tableName === "claims" &&
      q.includes("order by") &&
      q.includes("limit")
    ) {
      let sorted = [...allRows].sort((a, b) => (a.id as number) - (b.id as number));

      // Filter by WHERE conditions
      const whereIdx = q.indexOf(" where ");
      const orderByIdx = q.indexOf("order by", whereIdx >= 0 ? whereIdx : 0);
      const whereClause =
        whereIdx >= 0 ? q.slice(whereIdx, orderByIdx >= 0 ? orderByIdx : undefined) : "";

      if (whereClause) {
        let filterCount = 0;
        if (whereClause.includes("entity_type")) filterCount++;
        if (whereClause.includes("claim_type")) filterCount++;
        if (whereClause.includes("claim_category")) filterCount++;

        sorted = sorted.filter((r) => {
          let match = true;
          let paramIdx = 0;
          if (whereClause.includes("entity_type")) {
            if (r.entity_type !== params[paramIdx]) match = false;
            paramIdx++;
          }
          if (whereClause.includes("claim_type")) {
            if (r.claim_type !== params[paramIdx]) match = false;
            paramIdx++;
          }
          if (whereClause.includes("claim_category")) {
            if (r.claim_category !== params[paramIdx]) match = false;
            paramIdx++;
          }
          return match;
        });

        const limit = (params[filterCount] as number) || 50;
        const offset = (params[filterCount + 1] as number) || 0;
        return sorted.slice(offset, offset + limit);
      }

      const limit = (params[0] as number) || 50;
      const offset = (params[1] as number) || 0;
      return sorted.slice(offset, offset + limit);
    }

    return allRows;
  }
}
