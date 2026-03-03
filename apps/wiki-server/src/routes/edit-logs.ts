import { Hono } from "hono";
import { z } from "zod";
import { eq, gte, count, sql, asc, desc } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../db.js";
import { editLogs, wikiPages } from "../schema.js";
import { checkRefsExist } from "./ref-check.js";
import { parseJsonBody, validationError, invalidJsonError, firstOrThrow, paginationQuery } from "./utils.js";
import { EditLogEntrySchema, EditLogBatchSchema } from "../api-types.js";
import { resolvePageIntId, resolvePageIntIds } from "./page-id-helpers.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 1000;

// ---- Schemas (from shared api-types) ----

const AppendSchema = EditLogEntrySchema;
const AppendBatchSchema = EditLogBatchSchema;

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE, defaultLimit: 100 });

const AllEntriesQuery = PaginationQuery.extend({
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const editLogsApp = new Hono()

  // ---- POST / (append single entry) ----

  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = AppendSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    // Validate page reference
    const missing = await checkRefsExist(db, wikiPages, wikiPages.id, [d.pageId]);
    if (missing.length > 0) {
      return validationError(c, `Referenced page not found: ${missing.join(", ")}`);
    }

    // Phase D2a: resolve page slug to integer ID (no longer dual-writing page_id_old)
    const pageIdInt = await resolvePageIntId(db, d.pageId);

    const rows = await db
      .insert(editLogs)
      .values({
        pageIdInt,
        date: d.date,
        tool: d.tool,
        agency: d.agency,
        requestedBy: d.requestedBy ?? null,
        note: d.note ?? null,
      })
      .returning({
        id: editLogs.id,
        date: editLogs.date,
        createdAt: editLogs.createdAt,
      });

    const row = firstOrThrow(rows, "edit log insert");
    // pageId derived from input (page_id_old column no longer written)
    return c.json({ ...row, pageId: d.pageId }, 201);
  })

  // ---- POST /batch (append multiple entries) ----

  .post("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = AppendBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    // Validate page references
    const pageIds = [...new Set(items.map((d) => d.pageId))];
    const missing = await checkRefsExist(db, wikiPages, wikiPages.id, pageIds);
    if (missing.length > 0) {
      return validationError(c, `Referenced pages not found: ${missing.join(", ")}`);
    }

    const results = await db.transaction(async (tx) => {
      // Phase D2a: resolve slugs to integer IDs (no longer dual-writing page_id_old)
      const intIdMap = await resolvePageIntIds(tx, pageIds);
      return await tx
        .insert(editLogs)
        .values(
          items.map((d) => ({
            pageIdInt: intIdMap.get(d.pageId) ?? null,
            date: d.date,
            tool: d.tool,
            agency: d.agency,
            requestedBy: d.requestedBy ?? null,
            note: d.note ?? null,
          }))
        )
        .returning({ id: editLogs.id });
    });

    // pageId derived from input items (page_id_old column no longer written)
    const resultWithPageId = results.map((r, i) => ({ ...r, pageId: items[i].pageId }));
    return c.json({ inserted: results.length, results: resultWithPageId }, 201);
  })

  // ---- GET /?page_id=X (entries for a page) ----

  .get("/", async (c) => {
    const pageId = c.req.query("page_id");
    if (!pageId) return validationError(c, "page_id query parameter is required");

    const db = getDrizzleDb();

    // Phase 4b: resolve slug to integer and query by page_id_int
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return c.json({ entries: [] });

    const rows = await db
      .select()
      .from(editLogs)
      .where(eq(editLogs.pageIdInt, intId))
      .orderBy(asc(editLogs.date), asc(editLogs.id));

    return c.json({
      // pageId from query param (page_id_old no longer written for new rows)
      entries: rows.map((r) => ({
        id: r.id,
        pageId,
        date: r.date,
        tool: r.tool,
        agency: r.agency,
        requestedBy: r.requestedBy,
        note: r.note,
        createdAt: r.createdAt,
      })),
    });
  })

  // ---- GET /all (paginated, all entries) ----

  .get("/all", async (c) => {
    const parsed = AllEntriesQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { limit, offset, since } = parsed.data;
    const db = getDrizzleDb();

    const whereClause = since ? gte(editLogs.date, since) : undefined;

    // JOIN with wiki_pages to recover slug from integer ID (page_id_old no longer written)
    const [rows, countResult] = await Promise.all([
      db
        .select({
          id: editLogs.id,
          pageId: wikiPages.id,
          date: editLogs.date,
          tool: editLogs.tool,
          agency: editLogs.agency,
          requestedBy: editLogs.requestedBy,
          note: editLogs.note,
          createdAt: editLogs.createdAt,
        })
        .from(editLogs)
        .leftJoin(wikiPages, eq(wikiPages.integerIdCol, editLogs.pageIdInt))
        .where(whereClause)
        .orderBy(desc(editLogs.date), desc(editLogs.id))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(editLogs).where(whereClause),
    ]);

    const total = countResult[0].count;

    return c.json({
      entries: rows,
      total,
      limit,
      offset,
    });
  })

  // ---- GET /latest-dates (latest edit date per page, for build-data) ----

  .get("/latest-dates", async (c) => {
    // JOIN wiki_pages to recover slug from page_id_int (page_id_old no longer written)
    const rawDb = getDb();
    const rows = await rawDb<{ page_id: string; latest_date: string }[]>`
      SELECT wp.id AS page_id, max(el.date) AS latest_date
      FROM edit_logs el
      JOIN wiki_pages wp ON wp.integer_id = el.page_id_int
      GROUP BY wp.id
    `;

    const dateMap: Record<string, string> = {};
    for (const row of rows) {
      dateMap[row.page_id] = row.latest_date;
    }

    return c.json({ dates: dateMap });
  })

  // ---- GET /earliest-dates (earliest edit date per page, for dateCreated fallback) ----

  .get("/earliest-dates", async (c) => {
    // JOIN wiki_pages to recover slug from page_id_int (page_id_old no longer written)
    const rawDb = getDb();
    const rows = await rawDb<{ page_id: string; earliest_date: string }[]>`
      SELECT wp.id AS page_id, min(el.date) AS earliest_date
      FROM edit_logs el
      JOIN wiki_pages wp ON wp.integer_id = el.page_id_int
      GROUP BY wp.id
    `;

    const dateMap: Record<string, string> = {};
    for (const row of rows) {
      dateMap[row.page_id] = row.earliest_date;
    }

    return c.json({ dates: dateMap });
  })

  // ---- GET /stats ----

  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const totalResult = await db.select({ count: count() }).from(editLogs);
    const totalEntries = totalResult[0].count;

    // Use pageIdInt for count (page_id_old no longer written for new rows)
    const pagesResult = await db
      .select({
        count: sql<number>`count(distinct ${editLogs.pageIdInt})`,
      })
      .from(editLogs);
    const pagesWithLogs = Number(pagesResult[0].count);

    const byTool = await db
      .select({
        tool: editLogs.tool,
        count: count(),
      })
      .from(editLogs)
      .groupBy(editLogs.tool)
      .orderBy(desc(count()));

    const byAgency = await db
      .select({
        agency: editLogs.agency,
        count: count(),
      })
      .from(editLogs)
      .groupBy(editLogs.agency)
      .orderBy(desc(count()));

    return c.json({
      totalEntries,
      pagesWithLogs,
      byTool: Object.fromEntries(byTool.map((r) => [r.tool, r.count])),
      byAgency: Object.fromEntries(byAgency.map((r) => [r.agency, r.count])),
    });
  });

export const editLogsRoute = editLogsApp;
export type EditLogsRoute = typeof editLogsApp;
