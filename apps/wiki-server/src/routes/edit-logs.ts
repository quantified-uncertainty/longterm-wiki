import { Hono } from "hono";
import { z } from "zod";
import { eq, gte, count, sql, asc, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { editLogs, wikiPages } from "../schema.js";
import { checkRefsExist } from "./ref-check.js";
import { parseJsonBody, validationError, invalidJsonError, firstOrThrow, paginationQuery } from "./utils.js";
import { EditLogEntrySchema, EditLogBatchSchema } from "../api-types.js";

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

    const rows = await db
      .insert(editLogs)
      .values({
        pageId: d.pageId,
        date: d.date,
        tool: d.tool,
        agency: d.agency,
        requestedBy: d.requestedBy ?? null,
        note: d.note ?? null,
      })
      .returning({
        id: editLogs.id,
        pageId: editLogs.pageId,
        date: editLogs.date,
        createdAt: editLogs.createdAt,
      });

    return c.json(firstOrThrow(rows, "edit log insert"), 201);
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
      return await tx
        .insert(editLogs)
        .values(
          items.map((d) => ({
            pageId: d.pageId,
            date: d.date,
            tool: d.tool,
            agency: d.agency,
            requestedBy: d.requestedBy ?? null,
            note: d.note ?? null,
          }))
        )
        .returning({ id: editLogs.id, pageId: editLogs.pageId });
    });

    return c.json({ inserted: results.length, results }, 201);
  })

  // ---- GET /?page_id=X (entries for a page) ----

  .get("/", async (c) => {
    const pageId = c.req.query("page_id");
    if (!pageId) return validationError(c, "page_id query parameter is required");

    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(editLogs)
      .where(eq(editLogs.pageId, pageId))
      .orderBy(asc(editLogs.date), asc(editLogs.id));

    return c.json({
      entries: rows.map((r) => ({
        id: r.id,
        pageId: r.pageId,
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

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(editLogs)
        .where(whereClause)
        .orderBy(desc(editLogs.date), desc(editLogs.id))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(editLogs).where(whereClause),
    ]);

    const total = countResult[0].count;

    return c.json({
      entries: rows.map((r) => ({
        id: r.id,
        pageId: r.pageId,
        date: r.date,
        tool: r.tool,
        agency: r.agency,
        requestedBy: r.requestedBy,
        note: r.note,
        createdAt: r.createdAt,
      })),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /latest-dates (latest edit date per page, for build-data) ----

  .get("/latest-dates", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select({
        pageId: editLogs.pageId,
        latestDate: sql<string>`max(${editLogs.date})`,
      })
      .from(editLogs)
      .groupBy(editLogs.pageId);

    const dateMap: Record<string, string> = {};
    for (const row of rows) {
      dateMap[row.pageId] = row.latestDate;
    }

    return c.json({ dates: dateMap });
  })

  // ---- GET /earliest-dates (earliest edit date per page, for dateCreated fallback) ----

  .get("/earliest-dates", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select({
        pageId: editLogs.pageId,
        earliestDate: sql<string>`min(${editLogs.date})`,
      })
      .from(editLogs)
      .groupBy(editLogs.pageId);

    const dateMap: Record<string, string> = {};
    for (const row of rows) {
      dateMap[row.pageId] = row.earliestDate;
    }

    return c.json({ dates: dateMap });
  })

  // ---- GET /stats ----

  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const totalResult = await db.select({ count: count() }).from(editLogs);
    const totalEntries = totalResult[0].count;

    const pagesResult = await db
      .select({
        count: sql<number>`count(distinct ${editLogs.pageId})`,
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
