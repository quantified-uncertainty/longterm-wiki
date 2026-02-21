import postgres, { type Row } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";

export type Sql = ReturnType<typeof postgres>;

/**
 * Callable tagged-template type for SQL queries.
 * TransactionSql extends Omit<Sql, ...> which drops Sql's call signatures
 * (a TypeScript limitation). This interface restores just the tagged-template
 * callable so we can use `tx` in begin() callbacks without type errors.
 */
export interface SqlQuery {
  <T extends readonly (object | undefined)[] = Row[]>(
    template: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ): Promise<T & postgres.RowList<T>>;
}

let sql: Sql | null = null;
let drizzleDb: PostgresJsDatabase<typeof schema> | null = null;

export function getDb() {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    sql = postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return sql;
}

export function getDrizzleDb() {
  if (!drizzleDb) {
    drizzleDb = drizzle(getDb(), { schema });
  }
  return drizzleDb;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function initDb() {
  const db = getDrizzleDb();
  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, "../drizzle"),
  });
}

export async function closeDb() {
  if (sql) {
    await sql.end();
    sql = null;
    drizzleDb = null;
  }
}
