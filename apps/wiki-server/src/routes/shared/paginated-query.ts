/**
 * Shared helper for paginated list queries.
 *
 * Most tablebase routes have GET /all and GET /by-entity/:entityId endpoints
 * that follow the same pattern:
 *   1. Query rows with LIMIT/OFFSET
 *   2. Query total count with matching WHERE
 *   3. Format rows
 *
 * This helper runs data + count queries in parallel and returns the formatted
 * results. The route handler constructs the final response object itself
 * (required for Hono RPC type inference to work with computed property keys).
 *
 * Usage:
 *   .get("/all", zv("query", AllQuery), async (c) => {
 *     const { limit, offset } = c.req.valid("query");
 *     const db = getDrizzleDb();
 *     const { rows, total } = await paginatedQuery({
 *       query: db.select().from(myTable).orderBy(...).limit(limit).offset(offset),
 *       countQuery: db.select({ count: count() }).from(myTable),
 *       formatRow,
 *     });
 *     return c.json({ myRecords: rows, total, limit, offset });
 *   })
 */

interface PaginatedQueryOptions<TRow, TFormatted = TRow> {
  /** The data query (with .limit() and .offset() already applied) */
  query: PromiseLike<TRow[]>;
  /** The count query — must return [{ count: number }] */
  countQuery: PromiseLike<{ count: number }[]>;
  /** Optional row formatter. If omitted, raw rows are returned. */
  formatRow?: (row: TRow) => TFormatted;
}

interface PaginatedQueryResult<T> {
  rows: T[];
  total: number;
}

/**
 * Execute data + count queries in parallel and return formatted rows + total.
 *
 * Runs both queries concurrently for efficiency. The caller builds the
 * c.json() response, preserving Hono RPC type inference.
 */
export async function paginatedQuery<TRow, TFormatted = TRow>(
  opts: PaginatedQueryOptions<TRow, TFormatted>,
): Promise<PaginatedQueryResult<TFormatted>> {
  const [rawRows, countResult] = await Promise.all([
    opts.query,
    opts.countQuery,
  ]);

  const total = countResult[0]?.count ?? 0;
  const rows = opts.formatRow
    ? rawRows.map(opts.formatRow)
    : (rawRows as unknown as TFormatted[]); // as-any-ok: TRow === TFormatted when no formatRow provided; generic constraint ensures type safety

  return { rows, total };
}
