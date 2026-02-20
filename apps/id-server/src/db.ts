import postgres, { type Row } from "postgres";

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

export async function initDb() {
  const db = getDb();

  await db`
    CREATE TABLE IF NOT EXISTS entity_ids (
      numeric_id  INTEGER PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Sequence starts at 1 but seed.ts will advance it to max(existing) + 1.
  // Using IF NOT EXISTS so this is safe to re-run.
  await db`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE sequencename = 'entity_id_seq') THEN
        CREATE SEQUENCE entity_id_seq START WITH 1;
      END IF;
    END
    $$
  `;
}

export async function closeDb() {
  if (sql) {
    await sql.end();
    sql = null;
  }
}
