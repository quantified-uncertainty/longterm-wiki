/**
 * Shared helper for /bulk endpoints that return all rows in a single response.
 *
 * Companion to `paginatedQuery`. /bulk endpoints exist for build-data and other
 * server-side consumers that want every row at once — pagination is pure
 * overhead in that context (N round-trips, repeated COUNT(*), deepest-page
 * OFFSET cliff). See QUA-1040 / QUA-1000.
 *
 * Usage:
 *   .get("/bulk", async (c) => {
 *     const db = getDrizzleDb();
 *     const { rows, total } = await bulkQuery({
 *       query: db.select(joinedSelect).from(table).leftJoin(...).orderBy(...),
 *       formatRow,
 *     });
 *     return c.json({ myRecords: rows, total });
 *   })
 *
 * The helper:
 *   - Awaits the query (no COUNT, no LIMIT/OFFSET).
 *   - Maps rows through optional `formatRow`.
 *   - Logs a soft warning if the result exceeds `softLimit` (default 50k) so
 *     unbounded growth is visible before it becomes a memory/payload problem.
 *
 * The caller builds the c.json() response itself (computed property keys
 * preserve Hono RPC type inference).
 */

import { logger } from "../../logger.js";

export interface BulkQueryOptions<TRow, TFormatted = TRow> {
  /** The data query (no .limit()/.offset() — fetches all rows). */
  query: PromiseLike<TRow[]>;
  /** Optional row formatter. If omitted, raw rows are returned. */
  formatRow?: (row: TRow) => TFormatted;
  /** Identifier used in soft-limit warnings. Defaults to "<unknown>". */
  routeName?: string;
  /** Row count above which a warning is logged. Default 50_000. */
  softLimit?: number;
}

export interface BulkQueryResult<T> {
  rows: T[];
  total: number;
}

/**
 * Execute a query that returns every row, with no pagination and no separate
 * COUNT.
 */
export async function bulkQuery<TRow, TFormatted = TRow>(
  opts: BulkQueryOptions<TRow, TFormatted>,
): Promise<BulkQueryResult<TFormatted>> {
  const rawRows = await opts.query;
  const rows = opts.formatRow
    ? rawRows.map(opts.formatRow)
    : (rawRows as unknown as TFormatted[]); // as-any-ok: TRow === TFormatted when no formatRow provided

  const softLimit = opts.softLimit ?? 50_000;
  if (rows.length > softLimit) {
    logger.warn(
      { route: opts.routeName ?? "<unknown>", rows: rows.length, softLimit },
      "bulk endpoint returned more rows than soft limit — consider adding filtering or paginating downstream callers",
    );
  }

  return { rows, total: rows.length };
}
