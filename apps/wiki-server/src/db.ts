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

  // Dedicated single-connection client for migrations with relaxed timeouts.
  // DDL (ALTER TABLE) requires ACCESS EXCLUSIVE locks that can be blocked by
  // the production server's connections during rolling deploys.
  //
  // Gotcha: postgres.js filters falsy values in connection params, so
  // statement_timeout: 0 (number) is silently dropped. Use string '0'.
  const migrationConnection: Record<string, string> = {
    statement_timeout: '0',
    lock_timeout: '60000',
    idle_in_transaction_session_timeout: '600000',
  };
  const migrationSql = postgres(url, {
    max: 1,
    connect_timeout: 10,
    connection: migrationConnection,
  });
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
