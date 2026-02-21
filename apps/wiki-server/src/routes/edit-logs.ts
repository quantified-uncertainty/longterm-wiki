import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, asc, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { editLogs } from "../schema.js";
import { parseJsonBody, validationError, invalidJsonError, firstOrThrow } from "./utils.js";

export const editLogsRoute = new Hono();

// ---- Constants ----

const MAX_BATCH_SIZE = 200;
const MAX_PAGE_SIZE = 1000;

// Canonical tool and agency values (mirrors crux/lib/edit-log.ts EditTool/EditAgency)
const VALID_TOOLS = [
  "crux-create",
  "crux-improve",
  "crux-grade",
  "crux-fix",
  "crux-fix-escalated",
  "crux-audit",
  "crux-audit-escalated",
  "claude-code",
  "manual",
  "bulk-script",
] as const;

const VALID_AGENCIES = ["human", "ai-directed", "automated"] as const;

// ---- Schemas ----

const AppendSchema = z.object({
  pageId: z.string().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tool: z.enum(VALID_TOOLS),
  agency: z.enum(VALID_AGENCIES),
  requestedBy: z.string().max(200).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
});

const AppendBatchSchema = z.object({
  items: z.array(AppendSchema).min(1).max(MAX_BATCH_SIZE),
});

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- POST / (append single entry) ----

editLogsRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = AppendSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const d = parsed.data;
  const db = getDrizzleDb();

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
});

// ---- POST /batch (append multiple entries) ----

editLogsRoute.post("/batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = AppendBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const db = getDrizzleDb();

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
});

// ---- GET /?page_id=X (entries for a page) ----

editLogsRoute.get("/", async (c) => {
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
});

// ---- GET /all (paginated, all entries) ----

editLogsRoute.get("/all", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset } = parsed.data;
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(editLogs)
    .orderBy(desc(editLogs.date), desc(editLogs.id))
    .limit(limit)
    .offset(offset);

  const countResult = await db.select({ count: count() }).from(editLogs);
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
});

// ---- GET /latest-dates (latest edit date per page, for build-data) ----

editLogsRoute.get("/latest-dates", async (c) => {
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
});

// ---- GET /stats ----

editLogsRoute.get("/stats", async (c) => {
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
