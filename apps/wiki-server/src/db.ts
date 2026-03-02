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
        // Kill queries after 30s to prevent pool exhaustion.
        // Note: use a non-zero number here. postgres.js filters out falsy values
        // (including 0), so `statement_timeout: 0` would silently not be sent.
        statement_timeout: 30000,
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
  //
  // Why: DDL (ALTER TABLE) requires ACCESS EXCLUSIVE locks. During deploys, old
  // pods hold connections with active queries, so lock acquisition can take 30s+.
  // The PostgreSQL *role* also has statement_timeout=30s server-side, which applies
  // regardless of JS client config — we must explicitly override it here.
  //
  // Gotcha: postgres.js filters falsy values (`.filter(([, v]) => v)` in
  // connection.js:1004), so `statement_timeout: 0` (number) is silently dropped.
  // We use string values and a Record<string, string> type to work around both
  // the falsy-filtering and the TS types (which declare these as `number`).
  //
  // Settings:
  //   statement_timeout: '0'       — No per-statement limit; DDL must complete once locked
  //   lock_timeout: '60000'        — 60s cap on lock wait; must be < smoke test timeout
  //                                  so we get a clear error rather than silent hang
  //   idle_in_transaction_session_timeout: '600000' — 10min bound on total migration txn
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
    // Log actual session settings to verify connection params are applied.
    // This is critical for debugging: postgres.js silently drops falsy values,
    // and server-level role settings can override client-level ones.
    const settings = await migrationSql`
      SELECT current_setting('statement_timeout') AS statement_timeout,
             current_setting('lock_timeout') AS lock_timeout,
             current_setting('idle_in_transaction_session_timeout') AS idle_in_txn_timeout
    `;
    logger.info({ settings: settings[0] }, "Migration client session settings");

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

/**
 * Verify that columns created by manual migration scripts actually exist.
 * Migrations 0048/0049 are no-ops (SELECT 1) because ALTER TABLE deadlocks
 * during rolling deploys. The actual DDL must be applied via psql. This check
 * catches the case where someone sets up a fresh environment and forgets to
 * run the manual script.
 */
export async function verifySchema() {
  const db = getDb();
  interface ColumnRow { column_name: string }
  const result = await db<ColumnRow[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'wiki_pages' AND column_name IN ('slug', 'integer_id')
    ORDER BY column_name
  `;
  const columns = result.map((r) => r.column_name);
  if (!columns.includes('slug') || !columns.includes('integer_id')) {
    const missing = ['slug', 'integer_id'].filter(c => !columns.includes(c));
    throw new Error(
      `Missing columns in wiki_pages: ${missing.join(', ')}. ` +
      `Migrations 0048/0049 are no-ops — run the manual migration:\n` +
      `  psql "$DATABASE_URL" -f apps/wiki-server/scripts/phase4a-manual-migration.sql`
    );
  }
}

export async function closeDb() {
  if (sql) {
    await sql.end();
    sql = null;
    drizzleDb = null;
  }
}
