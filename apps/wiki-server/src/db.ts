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

  // Citation quotes — one record per (page_id, footnote)
  await db`
    CREATE TABLE IF NOT EXISTS citation_quotes (
      id              BIGSERIAL PRIMARY KEY,
      page_id         TEXT NOT NULL,
      footnote        INTEGER NOT NULL,
      url             TEXT,
      resource_id     TEXT,
      claim_text      TEXT NOT NULL,
      claim_context   TEXT,
      source_quote    TEXT,
      source_location TEXT,
      quote_verified  BOOLEAN NOT NULL DEFAULT false,
      verification_method TEXT,
      verification_score  REAL,
      verified_at     TIMESTAMPTZ,
      source_title    TEXT,
      source_type     TEXT,
      extraction_model TEXT,
      accuracy_verdict TEXT,
      accuracy_issues  TEXT,
      accuracy_score   REAL,
      accuracy_checked_at TIMESTAMPTZ,
      accuracy_supporting_quotes TEXT,
      verification_difficulty TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(page_id, footnote)
    )
  `;

  await db`CREATE INDEX IF NOT EXISTS idx_cq_page_id ON citation_quotes(page_id)`;
  await db`CREATE INDEX IF NOT EXISTS idx_cq_url ON citation_quotes(url)`;
  await db`CREATE INDEX IF NOT EXISTS idx_cq_verified ON citation_quotes(quote_verified)`;
  await db`CREATE INDEX IF NOT EXISTS idx_cq_accuracy ON citation_quotes(accuracy_verdict)`;

  // Citation content — cached source text, keyed by URL
  await db`
    CREATE TABLE IF NOT EXISTS citation_content (
      url              TEXT PRIMARY KEY,
      page_id          TEXT NOT NULL,
      footnote         INTEGER NOT NULL,
      fetched_at       TIMESTAMPTZ NOT NULL,
      http_status      INTEGER,
      content_type     TEXT,
      page_title       TEXT,
      full_text_preview TEXT,
      content_length   INTEGER,
      content_hash     TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await db`CREATE INDEX IF NOT EXISTS idx_cc_page_id ON citation_content(page_id)`;
}

export async function closeDb() {
  if (sql) {
    await sql.end();
    sql = null;
  }
}
