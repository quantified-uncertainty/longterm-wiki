import postgres, { type Row } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "./schema.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ component: "db" });

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
      connection: {
        statement_timeout: 30000, // Kill queries after 30s to prevent pool exhaustion
      },
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
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  logger.info("Running migrations...");
  const startMs = Date.now();

  // Use a dedicated single-connection client for migrations — no statement_timeout.
  // DDL (ALTER TABLE, CREATE INDEX) can be blocked by concurrent transactions and
  // needs more than the 30s timeout configured on the main pool.
  const migrationSql = postgres(url, { max: 1, connect_timeout: 10 });
  const migrationDb = drizzle(migrationSql, { schema });

  try {
    await migrate(migrationDb, {
      migrationsFolder: path.resolve(__dirname, "../drizzle"),
    });
    logger.info({ durationMs: Date.now() - startMs }, "Migrations completed");
  } catch (err) {
    logger.error({ err }, "Migration failed");
    throw err;
  } finally {
    await migrationSql.end();
  }
}

export async function closeDb() {
  if (sql) {
    await sql.end();
    sql = null;
    drizzleDb = null;
  }
}
