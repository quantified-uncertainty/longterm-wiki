/**
 * Reusable query utilities for server-side table endpoints.
 *
 * Builds on paginationQuery() / escapeIlike() from utils.ts.
 * Use these helpers to add search, sort, and filter to any
 * paginated Hono route.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { escapeIlike } from "./utils.js";

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
