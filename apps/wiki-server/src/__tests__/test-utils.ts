import { vi } from "vitest";
import { Hono } from "hono";

/**
 * Extract column names from SELECT or RETURNING clauses in Drizzle-generated SQL.
 * Returns array of column names (snake_case) or null for expression positions.
 */
export function extractColumns(query: string): (string | null)[] {
  const q = query.trim();

  // Try RETURNING first (at end of INSERT/UPDATE)
  let clauseMatch = q.match(/returning\s+(.+?)$/is);
  if (!clauseMatch) {
    // Try SELECT
    clauseMatch = q.match(/^select\s+(.+?)\s+from\s/is);
  }
  if (!clauseMatch) return [];

  const clause = clauseMatch[1];

  // Split by commas, respecting parentheses
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of clause) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  // Extract the last top-level quoted identifier from each part
  return parts.map((part) => {
    let d = 0;
    let lastTopLevel: string | null = null;
    let i = 0;
    while (i < part.length) {
      if (part[i] === "(") {
        d++;
        i++;
      } else if (part[i] === ")") {
        d--;
        i++;
      } else if (part[i] === '"' && d === 0) {
        const close = part.indexOf('"', i + 1);
        if (close > i) {
          lastTopLevel = part.substring(i + 1, close);
          i = close + 1;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
    return lastTopLevel;
  });
}

/**
 * Create a thenable result that supports .values() for Drizzle's query builder.
 *
 * Drizzle's postgres-js adapter calls:
 * - client.unsafe(query, params) for raw SQL -> expects row objects
 * - client.unsafe(query, params).values() for query builder -> expects positional arrays
 */
export function createQueryResult(rows: unknown[], query: string): any {
  const promise = Promise.resolve(rows);
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    [Symbol.toStringTag]: "Promise",
    count: rows.length,
    values: () => {
      const cols = extractColumns(query);
      const arrayRows = rows.map((row: any) => {
        if (cols.length > 0 && cols.some((c) => c !== null)) {
          return cols.map((col, i) => {
            if (col !== null) return row[col];
            return Object.values(row)[i];
          });
        }
        return Object.values(row);
      });
      return createQueryResult(arrayRows, query);
    },
  };
}

/** Dispatch function type: maps SQL query + params to result rows. */
export type SqlDispatcher = (query: string, params: unknown[]) => unknown[];

/**
 * Build a mock SQL client compatible with both postgres.js tagged templates
 * and Drizzle's `unsafe()` query builder calls.
 *
 * @param dispatch - function that takes (query, params) and returns result rows
 */
export function createBaseMockSql(dispatch: SqlDispatcher) {
  // Tagged-template handler (for raw SQL like health check sequence query)
  const mockSql: any = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const query = strings.join("$").trim();
    const rows = dispatch(query, values);
    // Wrap in a postgres-compatible result (array-like thenable with .count)
    const result: any = [...rows];
    result.count = rows.length;
    return result;
  };

  // Drizzle calls client.unsafe(query, params).values() for query builder operations
  mockSql.unsafe = (query: string, params: unknown[] = []) => {
    return createQueryResult(dispatch(query, params), query);
  };

  // Transaction support: Drizzle calls client.begin(fn) with a transaction client
  mockSql.begin = async (fn: (tx: typeof mockSql) => Promise<any>) => {
    return await fn(mockSql);
  };

  // Reserve/release connection (drizzle internals)
  mockSql.reserve = () => Promise.resolve(mockSql);
  mockSql.release = () => {};

  // Drizzle's postgres-js driver reads client.options.parsers/serializers
  mockSql.options = { parsers: {}, serializers: {} };

  return mockSql;
}

/**
 * Set up the vi.mock for "../db.js" using the given dispatch function.
 * Returns a promise that resolves when the mock is ready.
 *
 * Usage in test files:
 *   vi.mock("../db.js", () => mockDbModule(myDispatcher));
 */
export async function mockDbModule(dispatch: SqlDispatcher) {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("../schema.js");
  const mockSql = createBaseMockSql(dispatch);
  const mockDrizzle = drizzle(mockSql, { schema });
  return {
    getDb: () => mockSql,
    getDrizzleDb: () => mockDrizzle,
    initDb: vi.fn(),
    closeDb: vi.fn(),
  };
}

/** POST JSON helper for tests. */
export function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
