import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { zv, escapeIlike, clampedLimit } from "../shared/utils.js";
import { parseSort, TRIGRAM_FALLBACK_THRESHOLD } from "../shared/query-helpers.js";
import {
  buildPrefixTsquery,
  normalizeSearchQuery,
  TRIGRAM_SIMILARITY_THRESHOLD,
} from "../../search-utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const SORT_ALLOWED = [
  "name",
  "role",
  "employer",
  "bornYear",
  "netWorth",
] as const;

const PeopleQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(200).optional(),
  sort: z.string().max(50).optional(),
  affiliation: z.string().max(200).optional(),
});

// ---- Typed row interface for raw SQL results ----

interface PersonRawRow {
  [key: string]: unknown;
  id: string;
  slug: string;
  name: string;
  wikiId: string | null;
  description: string | null;
  role: string | null;
  employerId: string | null;
  employerName: string | null;
  bornYear: number | null;
  netWorth: number | null;
}

interface CountRow {
  [key: string]: unknown;
  total: number;
}

interface AffiliationRow {
  [key: string]: unknown;
  employerName: string;
  count: number;
}

function formatPersonRow(r: PersonRawRow) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    wikiId: r.wikiId,
    description: r.description,
    role: r.role,
    employerId: r.employerId,
    employerName: r.employerName,
    bornYear: r.bornYear != null ? Number(r.bornYear) : null,
    netWorth: r.netWorth != null ? Number(r.netWorth) : null,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const peopleApp = new Hono()

  // ---- GET / (paginated people listing with search, sort, filter) ----
  .get("/", zv("query", PeopleQuery), async (c) => {
    const { limit, offset, q, sort, affiliation } = c.req.valid("query");
    const db = getDrizzleDb();

    // Build dynamic WHERE fragments
    const extraConditions: ReturnType<typeof sql>[] = [];
    let searchMode: "fts" | "trigram" | "ilike" | null = null;

    if (q) {
      const trimmedQ = q.trim();
      const normalized = normalizeSearchQuery(trimmedQ);
      const tsquery = buildPrefixTsquery(normalized);

      if (tsquery) {
        // Primary: tsvector full-text search on things.search_vector
        // Also search role and employer facts via ILIKE for completeness
        const pattern = `%${escapeIlike(trimmedQ)}%`;
        extraConditions.push(sql`(
          t.search_vector @@ to_tsquery('english', ${tsquery})
          OR EXISTS (
            SELECT 1 FROM facts f_s
            WHERE f_s.entity_id = t.id
            AND f_s.measure = 'role'
            AND f_s.value ILIKE ${pattern}
          )
          OR EXISTS (
            SELECT 1 FROM facts f_s2
            WHERE f_s2.entity_id = t.id
            AND f_s2.measure = 'employed-by'
            AND (
              f_s2.value ILIKE ${pattern}
              OR EXISTS (
                SELECT 1 FROM entities e_s
                WHERE e_s.stable_id = f_s2.value
                AND e_s.title ILIKE ${pattern}
              )
            )
          )
        )`);
        searchMode = "fts";
      } else {
        // Fallback to ILIKE when tsquery cannot be built (all-punctuation input)
        const pattern = `%${escapeIlike(trimmedQ)}%`;
        extraConditions.push(sql`(
          t.title ILIKE ${pattern}
          OR t.description ILIKE ${pattern}
          OR EXISTS (
            SELECT 1 FROM facts f_s
            WHERE f_s.entity_id = t.id
            AND f_s.measure = 'role'
            AND f_s.value ILIKE ${pattern}
          )
          OR EXISTS (
            SELECT 1 FROM facts f_s2
            WHERE f_s2.entity_id = t.id
            AND f_s2.measure = 'employed-by'
            AND (
              f_s2.value ILIKE ${pattern}
              OR EXISTS (
                SELECT 1 FROM entities e_s
                WHERE e_s.stable_id = f_s2.value
                AND e_s.title ILIKE ${pattern}
              )
            )
          )
        )`);
        searchMode = "ilike";
      }
    }

    if (affiliation) {
      extraConditions.push(sql`EXISTS (
        SELECT 1 FROM facts f_aff
        WHERE f_aff.entity_id = t.id
        AND f_aff.measure = 'employed-by'
        AND (
          f_aff.value = ${affiliation}
          OR EXISTS (
            SELECT 1 FROM entities e_aff
            WHERE e_aff.stable_id = f_aff.value
            AND (e_aff.id = ${affiliation} OR e_aff.title = ${affiliation})
          )
        )
      )`);
    }

    // Combine extra conditions into a single SQL fragment
    const extraWhere =
      extraConditions.length > 0
        ? sql`AND ${extraConditions.reduce((acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`))}`
        : sql``;

    // Sort — validated against whitelist by parseSort
    const { field, dir } = parseSort(sort, SORT_ALLOWED, "name", "asc");

    // Define sort expressions as parameterized SQL fragments
    const roleSubquery = sql`(SELECT f_r.value FROM facts f_r WHERE f_r.entity_id = t.id AND f_r.measure = 'role' LIMIT 1)`;
    const employerSubquery = sql`(SELECT COALESCE(emp.title, f_e.value) FROM facts f_e LEFT JOIN entities emp ON emp.stable_id = f_e.value WHERE f_e.entity_id = t.id AND f_e.measure = 'employed-by' LIMIT 1)`;
    const bornYearSubquery = sql`(SELECT f_b.numeric FROM facts f_b WHERE f_b.entity_id = t.id AND f_b.measure = 'born-year' LIMIT 1)`;
    const netWorthSubquery = sql`(SELECT f_n.numeric FROM facts f_n WHERE f_n.entity_id = t.id AND f_n.measure = 'net-worth' LIMIT 1)`;

    const sortExprMap: Record<string, ReturnType<typeof sql>> = {
      name: sql`t.title`,
      role: roleSubquery,
      employer: employerSubquery,
      bornYear: bornYearSubquery,
      netWorth: netWorthSubquery,
    };
    const sortExpr = sortExprMap[field] ?? sql`t.title`;
    const defaultOrderClause =
      dir === "desc"
        ? sql`${sortExpr} DESC NULLS LAST`
        : sql`${sortExpr} ASC NULLS LAST`;

    // When searching via FTS with no explicit sort, order by search relevance
    let orderClause = defaultOrderClause;
    if (q && searchMode === "fts" && (sort === undefined || sort === "")) {
      const trimmedQ = q.trim();
      const normalized = normalizeSearchQuery(trimmedQ);
      const tsquery = buildPrefixTsquery(normalized);
      if (tsquery) {
        // Title-match boost: exact (+1000), acronym-in-parens (+500), starts-with (+100), word-boundary (+10)
        orderClause = sql`(
          ts_rank_cd(t.search_vector, to_tsquery('english', ${tsquery}), 1)
          + CASE
              WHEN lower(t.title) = lower(${trimmedQ}) THEN 1000
              WHEN position('(' || upper(${trimmedQ}) || ')' in t.title) > 0 THEN 500
              WHEN starts_with(lower(t.title), lower(${trimmedQ}) || ' ') THEN 100
              WHEN position(' ' || lower(${trimmedQ}) in lower(t.title)) > 0 THEN 10
              ELSE 0
            END
        ) DESC`;
      }
    }

    // QUA-506: reads things_search; trigram fallback (below) stays on things.
    const countResult = (await db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM things_search t
      WHERE t.thing_type = 'entity'
        AND t.entity_type = 'person'
        ${extraWhere}
    `)) as CountRow[];
    let total = countResult[0]?.total ?? 0;

    // Data query with fact subqueries for person attributes
    let rows = (await db.execute(sql`
      SELECT
        t.id,
        t.source_id AS slug,
        t.title AS name,
        t.wiki_id AS "wikiId",
        t.description,
        ${roleSubquery} AS role,
        (SELECT f_e.value FROM facts f_e WHERE f_e.entity_id = t.id AND f_e.measure = 'employed-by' LIMIT 1) AS "employerId",
        ${employerSubquery} AS "employerName",
        ${bornYearSubquery} AS "bornYear",
        ${netWorthSubquery} AS "netWorth"
      FROM things_search t
      WHERE t.thing_type = 'entity'
        AND t.entity_type = 'person'
        ${extraWhere}
      ORDER BY ${orderClause}, t.id
      LIMIT ${limit}
      OFFSET ${offset}
    `)) as PersonRawRow[];

    // Trigram fallback: if FTS returned too few results, retry with trigram similarity
    if (q && total < TRIGRAM_FALLBACK_THRESHOLD && searchMode === "fts") {
      searchMode = "trigram";
      const trimmedQ = q.trim();

      // Build trigram conditions: keep affiliation filter if present, replace search with trigram
      const trigramConditions: ReturnType<typeof sql>[] = [];
      trigramConditions.push(
        sql`similarity(t.title, ${trimmedQ}) > ${TRIGRAM_SIMILARITY_THRESHOLD}`,
      );

      if (affiliation) {
        trigramConditions.push(sql`EXISTS (
          SELECT 1 FROM facts f_aff
          WHERE f_aff.entity_id = t.id
          AND f_aff.measure = 'employed-by'
          AND (
            f_aff.value = ${affiliation}
            OR EXISTS (
              SELECT 1 FROM entities e_aff
              WHERE e_aff.stable_id = f_aff.value
              AND (e_aff.id = ${affiliation} OR e_aff.title = ${affiliation})
            )
          )
        )`);
      }

      const trigramExtraWhere =
        trigramConditions.length > 0
          ? sql`AND ${trigramConditions.reduce((acc, cond, i) => (i === 0 ? cond : sql`${acc} AND ${cond}`))}`
          : sql``;

      const trigramCountResult = (await db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM things t
        WHERE t.thing_type = 'entity'
          AND t.entity_type = 'person'
          ${trigramExtraWhere}
      `)) as CountRow[];
      const trigramTotal = trigramCountResult[0]?.total ?? 0;

      if (trigramTotal > total) {
        total = trigramTotal;
        rows = (await db.execute(sql`
          SELECT
            t.id,
            t.source_id AS slug,
            t.title AS name,
            t.wiki_id AS "wikiId",
            t.description,
            ${roleSubquery} AS role,
            (SELECT f_e.value FROM facts f_e WHERE f_e.entity_id = t.id AND f_e.measure = 'employed-by' LIMIT 1) AS "employerId",
            ${employerSubquery} AS "employerName",
            ${bornYearSubquery} AS "bornYear",
            ${netWorthSubquery} AS "netWorth"
          FROM things t
          WHERE t.thing_type = 'entity'
            AND t.entity_type = 'person'
            ${trigramExtraWhere}
          ORDER BY similarity(t.title, ${trimmedQ}) DESC, t.id
          LIMIT ${limit}
          OFFSET ${offset}
        `)) as PersonRawRow[];
      }
    }

    return c.json({
      items: rows.map(formatPersonRow),
      total,
      limit,
      offset,
      searchMode,
    });
  })

  // ---- GET /affiliations ----
  // Returns distinct employer names with person counts, for filter dropdown.
  // Intentionally still reads from `things` — dropdown helper, ~1h staleness
  // is fine.
  .get("/affiliations", async (c) => {
    const db = getDrizzleDb();

    const rows = (await db.execute(sql`
      SELECT
        COALESCE(emp.title, f.value) AS "employerName",
        COUNT(DISTINCT t.id)::int AS count
      FROM things t
      JOIN facts f ON f.entity_id = t.id AND f.measure = 'employed-by'
      LEFT JOIN entities emp ON emp.stable_id = f.value
      WHERE t.thing_type = 'entity' AND t.entity_type = 'person'
      GROUP BY COALESCE(emp.title, f.value)
      HAVING COUNT(DISTINCT t.id) >= 2
      ORDER BY COUNT(DISTINCT t.id) DESC
      LIMIT 20
    `)) as AffiliationRow[];

    return c.json({
      affiliations: rows.map((r) => ({
        name: r.employerName,
        count: Number(r.count),
      })),
    });
  });

// ---- Exports ----

export const peopleRoute = peopleApp;
export type PeopleRoute = typeof peopleApp;
