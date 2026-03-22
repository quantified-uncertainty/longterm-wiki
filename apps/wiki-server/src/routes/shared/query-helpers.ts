/**
 * Reusable query utilities for server-side table endpoints.
 *
 * Builds on paginationQuery() / escapeIlike() from utils.ts.
 * Use these helpers to add search, sort, and filter to any
 * paginated Hono route.
 */
import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { escapeIlike } from "./utils.js";
import { entities } from "../../schema.js";
import { STABLE_ID_PATTERN } from "./entity-ref.js";
import {
  buildPrefixTsquery,
  normalizeSearchQuery,
  TRIGRAM_SIMILARITY_THRESHOLD,
  TRIGRAM_FALLBACK_THRESHOLD,
} from "../../search-utils.js";

/**
 * Build an ILIKE OR search condition across multiple columns.
 * Returns undefined if searchTerm is empty (caller can skip the condition).
 */
export function buildSearchCondition(
  columns: PgColumn[],
  searchTerm: string,
): SQL | undefined {
  const trimmed = searchTerm.trim();
  if (!trimmed) return undefined;
  const pattern = `%${escapeIlike(trimmed)}%`;
  const conditions = columns.map((col) => sql`${col} ILIKE ${pattern}`);
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return sql`(${sql.join(conditions, sql` OR `)})`;
}

/**
 * Build a tsvector full-text search condition using search_vector column.
 *
 * Uses prefix-matching tsquery (e.g. "AI align" → "AI:* & align:*") for
 * search-as-you-type behavior. Falls back to ILIKE on specified columns
 * when no valid tsquery can be built (e.g. all-punctuation input).
 *
 * @param searchVectorExpr - SQL expression for the tsvector column (e.g. `sql.raw("e.search_vector")`)
 * @param searchTerm - User's raw search input
 * @param ilikeFallbackColumns - Columns to ILIKE-search when tsquery is empty
 * @returns SQL condition or undefined if searchTerm is empty
 */
export function buildTsvectorSearchCondition(
  searchVectorExpr: SQL,
  searchTerm: string,
  ilikeFallbackColumns: PgColumn[],
): SQL | undefined {
  const trimmed = searchTerm.trim();
  if (!trimmed) return undefined;

  const normalized = normalizeSearchQuery(trimmed);
  const tsquery = buildPrefixTsquery(normalized);

  if (tsquery) {
    return sql`${searchVectorExpr} @@ to_tsquery('english', ${tsquery})`;
  }

  // Fallback to ILIKE if tsquery could not be built
  return buildSearchCondition(ilikeFallbackColumns, trimmed);
}

/**
 * Build a tsvector relevance rank expression with title-match boosting.
 *
 * Returns a SQL expression that computes:
 *   ts_rank_cd(search_vector, tsquery, 1) + title_boost
 *
 * The title boost uses exact match (+1000), starts-with (+100), and
 * word-boundary (+10) bonuses to ensure exact title matches rank first.
 *
 * @param searchVectorColumn - SQL expression for the tsvector column (e.g. `sql.raw("e.search_vector")`)
 * @param titleColumn - SQL expression for the title column (e.g. `entities.title` or `sql.raw("t.title")`)
 * @param searchTerm - User's raw search input
 * @returns SQL expression for relevance ranking, or undefined if no valid tsquery
 */
export function buildTsvectorRankExpr(
  searchVectorColumn: SQL,
  titleColumn: SQL | PgColumn,
  searchTerm: string,
): SQL | undefined {
  const normalized = normalizeSearchQuery(searchTerm.trim());
  const tsquery = buildPrefixTsquery(normalized);
  if (!tsquery) return undefined;

  // Title-match boost: exact match (+1000), starts-with (+100), word boundary (+10)
  // This mirrors the logic in titleMatchBoostExpr() from search-utils.ts but
  // is expressed as a Drizzle SQL template for type safety.
  const titleBoost = sql`(
    CASE
      WHEN lower(${titleColumn}) = lower(${searchTerm}) THEN 1000
      WHEN position('(' || upper(${searchTerm}) || ')' in ${titleColumn}) > 0 THEN 500
      WHEN starts_with(lower(${titleColumn}), lower(${searchTerm}) || ' ') THEN 100
      WHEN position(' ' || lower(${searchTerm}) in lower(${titleColumn})) > 0 THEN 10
      ELSE 0
    END
  )`;

  return sql`ts_rank_cd(${searchVectorColumn}, to_tsquery('english', ${tsquery}), 1) + ${titleBoost}`;
}

/**
 * Build a trigram similarity fallback condition for when tsvector search
 * returns too few results (typo tolerance).
 *
 * @param titleColumn - SQL expression or column for the title
 * @param searchTerm - User's raw search input
 * @param threshold - Minimum similarity score (default: TRIGRAM_SIMILARITY_THRESHOLD)
 * @returns SQL condition
 */
export function buildTrigramFallbackCondition(
  titleColumn: SQL | PgColumn,
  searchTerm: string,
  threshold: number = TRIGRAM_SIMILARITY_THRESHOLD,
): SQL {
  return sql`similarity(${titleColumn}, ${searchTerm}) > ${threshold}`;
}

/**
 * Build a trigram similarity score expression for ORDER BY.
 */
export function buildTrigramRankExpr(
  titleColumn: SQL | PgColumn,
  searchTerm: string,
): SQL {
  return sql`similarity(${titleColumn}, ${searchTerm})`;
}

export { TRIGRAM_FALLBACK_THRESHOLD, TRIGRAM_SIMILARITY_THRESHOLD };

/**
 * Parse a sort string like "amount:desc" into field and direction.
 * Falls back to defaults if the field is not in the whitelist.
 */
export function parseSort(
  sortStr: string | undefined,
  allowedFields: readonly string[],
  defaultField: string,
  defaultDir: "asc" | "desc" = "desc",
): { field: string; dir: "asc" | "desc" } {
  if (!sortStr) return { field: defaultField, dir: defaultDir };
  const [field, dir] = sortStr.split(":");
  if (!allowedFields.includes(field)) {
    return { field: defaultField, dir: defaultDir };
  }
  return {
    field,
    dir: dir === "asc" || dir === "desc" ? dir : defaultDir,
  };
}

/** Standard paginated response metadata. */
export interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * Resolve an entity identifier to a stableId.
 * Accepts either a stableId (10-char alphanumeric, returned as-is) or a slug
 * (looked up in the entities table). Returns the original value if no match.
 */
export async function resolveEntityStableId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PostgresJsDatabase<any>,
  entityId: string,
): Promise<string> {
  // StableIds are exactly 10 alphanumeric chars with at least one uppercase
  if (STABLE_ID_PATTERN.test(entityId)) return entityId;
  // Looks like a slug — try to resolve
  const [entity] = await db
    .select({ stableId: entities.stableId })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  return entity?.stableId ?? entityId;
}

/** Build pagination metadata from a total count, page number, and page size. */
export function paginationMeta(
  total: number,
  page: number,
  pageSize: number,
): PaginationMeta {
  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}
