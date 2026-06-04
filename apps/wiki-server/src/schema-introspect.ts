/**
 * Drizzle schema introspection — structural source of truth for docs/diagrams.
 *
 * Reads the live `schema.ts` table definitions via Drizzle's `getTableConfig`
 * and projects them into plain, serializable POJOs. Lives in `apps/wiki-server`
 * (not `crux/`) on purpose: `drizzle-orm` only resolves inside the wiki-server
 * package, so introspection must happen here. The output is dependency-free so
 * `crux/generate/generate-db-schema-docs.ts` can import it and emit MDX without
 * pulling Drizzle into the crux module graph.
 *
 * Consumers: `crux generate db-schema-docs` (writes the reference page) and
 * `crux/validate/validate-generated-db-docs.ts` (drift gate). Keeping this the
 * single introspection entry point means the generated docs cannot disagree
 * with the schema — they are derived from the same `pgTable` objects the app
 * runs against.
 */

import { is } from "drizzle-orm";
import {
  getTableConfig,
  PgTable,
  PgMaterializedView,
  PgView,
  getMaterializedViewConfig,
  getViewConfig,
} from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

export interface ColumnInfo {
  name: string;
  /** Postgres SQL type, e.g. "text", "integer", "timestamp with time zone". */
  sqlType: string;
  notNull: boolean;
  primaryKey: boolean;
  hasDefault: boolean;
}

export interface ForeignKeyInfo {
  /** Local column names participating in the FK. */
  columns: string[];
  /** Referenced table name (the SQL table name, not the export name). */
  refTable: string;
  /** Referenced column names, aligned with `columns`. */
  refColumns: string[];
  onDelete?: string;
}

export interface TableInfo {
  /** The `export const <name>` identifier in schema.ts. */
  exportName: string;
  /** The Postgres table name (snake_case). */
  tableName: string;
  columns: ColumnInfo[];
  /** Names of primary-key columns (covers both single- and composite-key tables). */
  primaryKeyColumns: string[];
  foreignKeys: ForeignKeyInfo[];
}

export interface OtherExportInfo {
  exportName: string;
  /** SQL object name where derivable. */
  objectName: string;
  kind: "materialized-view" | "view";
}

export interface SchemaIntrospection {
  tables: TableInfo[];
  /** Materialized views / views — counted in summaries, not in the ER diagram. */
  otherExports: OtherExportInfo[];
}

function collectPrimaryKeyColumns(cfg: ReturnType<typeof getTableConfig>): string[] {
  const cols = new Set<string>();
  for (const col of cfg.columns) {
    if (col.primary) cols.add(col.name);
  }
  for (const pk of cfg.primaryKeys) {
    for (const col of pk.columns) cols.add(col.name);
  }
  return [...cols];
}

function projectTable(exportName: string, table: PgTable): TableInfo {
  const cfg = getTableConfig(table);
  const pkColumns = new Set(collectPrimaryKeyColumns(cfg));

  const columns: ColumnInfo[] = cfg.columns.map((col) => ({
    name: col.name,
    sqlType: col.getSQLType(),
    notNull: col.notNull,
    primaryKey: pkColumns.has(col.name),
    hasDefault: col.hasDefault ?? col.default !== undefined,
  }));

  const foreignKeys: ForeignKeyInfo[] = cfg.foreignKeys.map((fk) => {
    const ref = fk.reference();
    return {
      columns: ref.columns.map((c) => c.name),
      refTable: getTableConfig(ref.foreignTable).name,
      refColumns: ref.foreignColumns.map((c) => c.name),
      onDelete: fk.onDelete,
    };
  });

  return {
    exportName,
    tableName: cfg.name,
    columns,
    primaryKeyColumns: [...pkColumns],
    foreignKeys,
  };
}

/**
 * Introspect every exported Drizzle object in schema.ts.
 * Results are sorted deterministically (by table name) so generated output is
 * byte-stable across runs — required for the drift gate to diff cleanly.
 */
export function introspectSchema(): SchemaIntrospection {
  const tables: TableInfo[] = [];
  const otherExports: OtherExportInfo[] = [];

  for (const [exportName, value] of Object.entries(schema)) {
    if (is(value, PgTable)) {
      tables.push(projectTable(exportName, value as PgTable));
    } else if (is(value, PgMaterializedView)) {
      otherExports.push({
        exportName,
        objectName: getMaterializedViewConfig(value as PgMaterializedView).name,
        kind: "materialized-view",
      });
    } else if (is(value, PgView)) {
      otherExports.push({
        exportName,
        objectName: getViewConfig(value as PgView).name,
        kind: "view",
      });
    }
  }

  tables.sort((a, b) => a.tableName.localeCompare(b.tableName));
  otherExports.sort((a, b) => a.objectName.localeCompare(b.objectName));

  return { tables, otherExports };
}
