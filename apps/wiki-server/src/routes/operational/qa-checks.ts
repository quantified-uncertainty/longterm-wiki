/**
 * QA Page Checks — track which live pages have been audited by /qa-sweep.
 *
 * Provides a staleness-ordered queue so sweeps prioritize never-checked and
 * least-recently-checked pages, plus coverage stats per directory.
 */

import { Hono } from "hono";
import { eq, desc, and, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { sqlInList } from "../shared/query-helpers.js";
import { qaPageChecks } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
} from "../shared/utils.js";
import { entityHref } from "../shared/thing-sync.js";
import {
  RecordQaCheckSchema,
  RecordQaCheckBatchSchema,
} from "../../api-types.js";

/**
 * Hardcoded index pages that aren't in the things table but should appear
 * in the queue. These are the ~14 directory index pages.
 */
const INDEX_PAGES = [
  { pageUrl: "/organizations", directory: "organizations" },
  { pageUrl: "/people", directory: "people" },
  { pageUrl: "/ai-models", directory: "ai-models" },
  { pageUrl: "/benchmarks", directory: "benchmarks" },
  { pageUrl: "/legislation", directory: "legislation" },
  { pageUrl: "/projects", directory: "projects" },
  { pageUrl: "/approaches", directory: "approaches" },
  { pageUrl: "/events", directory: "events" },
  { pageUrl: "/grants", directory: "grants" },
  { pageUrl: "/publications", directory: "publications" },
  { pageUrl: "/research-areas", directory: "research-areas" },
  { pageUrl: "/funding-programs", directory: "funding-programs" },
  { pageUrl: "/funding-rounds", directory: "funding-rounds" },
  { pageUrl: "/divisions", directory: "divisions" },
];

/** Map entity_type to directory name (for coverage grouping). */
const ENTITY_TYPE_TO_DIRECTORY: Record<string, string> = {
  organization: "organizations",
  person: "people",
  "ai-model": "ai-models",
  benchmark: "benchmarks",
  policy: "legislation",
  project: "projects",
  approach: "approaches",
  event: "events",
  "research-area": "research-areas",
};

const qaChecksApp = new Hono()
  // ---- POST / (record a single check) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = RecordQaCheckSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    const inserted = await db
      .insert(qaPageChecks)
      .values({
        thingId: d.thingId ?? null,
        pageUrl: d.pageUrl,
        directory: d.directory ?? null,
        checkType: d.checkType,
        result: d.result,
        findings: d.findings ?? null,
        depth: d.depth ?? null,
        sweepId: d.sweepId ?? null,
        checkedAt: d.checkedAt ? new Date(d.checkedAt) : new Date(),
      })
      .returning();

    return c.json(firstOrThrow(inserted, "qa check insert"), 201);
  })

  // ---- POST /batch (record multiple checks) ----
  .post("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = RecordQaCheckBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();
    const rows = await db
      .insert(qaPageChecks)
      .values(
        parsed.data.items.map((d) => ({
          thingId: d.thingId ?? null,
          pageUrl: d.pageUrl,
          directory: d.directory ?? null,
          checkType: d.checkType,
          result: d.result,
          findings: d.findings ?? null,
          depth: d.depth ?? null,
          sweepId: d.sweepId ?? null,
          checkedAt: d.checkedAt ? new Date(d.checkedAt) : new Date(),
        }))
      )
      .returning();

    return c.json({ inserted: rows.length }, 201);
  })

  // ---- GET / (list recent checks) ----
  .get("/", async (c) => {
    const directory = c.req.query("directory");
    const sweepId = c.req.query("sweep_id");
    const limit = Math.min(Number(c.req.query("limit") || 50), 500);
    const offset = Number(c.req.query("offset") || 0);
    const db = getDrizzleDb();

    const conditions = [];
    if (directory) conditions.push(eq(qaPageChecks.directory, directory));
    if (sweepId) conditions.push(eq(qaPageChecks.sweepId, sweepId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(qaPageChecks)
      .where(where)
      .orderBy(desc(qaPageChecks.checkedAt))
      .limit(limit)
      .offset(offset);

    return c.json({ checks: rows, total: rows.length });
  })

  // ---- GET /queue (staleness-ordered page queue) ----
  .get("/queue", async (c) => {
    const directory = c.req.query("directory");
    const entityType = c.req.query("entity_type");
    const limit = Math.min(Number(c.req.query("limit") || 20), 200);
    const db = getDrizzleDb();

    // Query things LEFT JOIN qa_page_checks to get last check time
    const rows = (await db.execute(sql`
      SELECT
        t.id AS thing_id,
        t.title,
        t.entity_type,
        t.source_id,
        t.wiki_id,
        MAX(qpc.checked_at)::text AS last_checked,
        COUNT(qpc.id)::int AS check_count
      FROM things t
      LEFT JOIN qa_page_checks qpc ON qpc.thing_id = t.id
      WHERE t.thing_type = 'entity'
        ${entityType ? sql`AND t.entity_type = ${entityType}` : sql``}
        ${
          directory
            ? sql`AND t.entity_type = ${
                Object.entries(ENTITY_TYPE_TO_DIRECTORY).find(
                  ([, dir]) => dir === directory
                )?.[0] ?? "__none__"
              }`
            : sql``
        }
      GROUP BY t.id, t.title, t.entity_type, t.source_id, t.wiki_id
      ORDER BY MAX(qpc.checked_at) ASC NULLS FIRST
      LIMIT ${limit}
    `)) as Array<{
      thing_id: string;
      title: string;
      entity_type: string | null;
      source_id: string;
      wiki_id: string | null;
      last_checked: string | null;
      check_count: number;
    }>;

    const entityPages = rows.map((r) => ({
      thingId: r.thing_id,
      title: r.title,
      entityType: r.entity_type,
      pageUrl: entityHref(r.entity_type, r.source_id, r.wiki_id),
      lastChecked: r.last_checked,
      checkCount: r.check_count,
    }));

    // Also inject index pages that match the directory filter
    const indexPages = INDEX_PAGES.filter(
      (p) => !directory || p.directory === directory
    );

    // Get last check times for index pages
    const indexUrls = indexPages.map((p) => p.pageUrl);
    let indexCheckMap = new Map<
      string,
      { lastChecked: string | null; checkCount: number }
    >();

    if (indexUrls.length > 0) {
      const indexRows = (await db.execute(sql`
        SELECT
          page_url,
          MAX(checked_at)::text AS last_checked,
          COUNT(*)::int AS check_count
        FROM qa_page_checks
        WHERE page_url IN (${sqlInList(indexUrls)})
        GROUP BY page_url
      `)) as Array<{
        page_url: string;
        last_checked: string | null;
        check_count: number;
      }>;

      indexCheckMap = new Map(
        indexRows.map((r) => [
          r.page_url,
          { lastChecked: r.last_checked, checkCount: r.check_count },
        ])
      );
    }

    const indexEntries = indexPages.map((p) => {
      const check = indexCheckMap.get(p.pageUrl);
      return {
        thingId: null as string | null,
        title: `${p.directory} (index)`,
        entityType: null as string | null,
        pageUrl: p.pageUrl,
        lastChecked: check?.lastChecked ?? null,
        checkCount: check?.checkCount ?? 0,
      };
    });

    // Merge and sort: never-checked first, then oldest
    const allPages = [...entityPages, ...indexEntries].sort((a, b) => {
      if (!a.lastChecked && !b.lastChecked) return 0;
      if (!a.lastChecked) return -1;
      if (!b.lastChecked) return 1;
      return (
        new Date(a.lastChecked).getTime() - new Date(b.lastChecked).getTime()
      );
    });

    return c.json({ pages: allPages.slice(0, limit) });
  })

  // ---- GET /coverage (per-directory coverage stats) ----
  .get("/coverage", async (c) => {
    const db = getDrizzleDb();

    // Count total things per entity_type (that maps to a directory)
    const entityTypes = Object.keys(ENTITY_TYPE_TO_DIRECTORY);
    const thingCounts = (await db.execute(sql`
      SELECT entity_type, COUNT(*)::int AS total
      FROM things
      WHERE thing_type = 'entity'
        AND entity_type IN (${sqlInList(entityTypes)})
      GROUP BY entity_type
    `)) as Array<{ entity_type: string; total: number }>;

    // Count distinct checked pages per directory
    const checkedCounts = (await db.execute(sql`
      SELECT
        directory,
        COUNT(DISTINCT page_url)::int AS checked_pages,
        MAX(checked_at)::text AS last_checked
      FROM qa_page_checks
      WHERE directory IS NOT NULL
      GROUP BY directory
    `)) as Array<{
      directory: string;
      checked_pages: number;
      last_checked: string | null;
    }>;

    const checkedMap = new Map(
      checkedCounts.map((r) => [
        r.directory,
        { checkedPages: r.checked_pages, lastChecked: r.last_checked },
      ])
    );

    const directories = thingCounts.map((r) => {
      const dirName =
        ENTITY_TYPE_TO_DIRECTORY[r.entity_type] ?? r.entity_type;
      const checked = checkedMap.get(dirName);
      const checkedPages = checked?.checkedPages ?? 0;
      return {
        name: dirName,
        entityType: r.entity_type,
        totalPages: r.total,
        checkedPages,
        lastChecked: checked?.lastChecked ?? null,
        coveragePercent:
          r.total > 0 ? Math.round((checkedPages / r.total) * 100) : 0,
      };
    });

    // Sort by coverage ascending (least covered first)
    directories.sort((a, b) => a.coveragePercent - b.coveragePercent);

    return c.json({ directories });
  });

export const qaChecksRoute = qaChecksApp;
export type QaChecksRoute = typeof qaChecksApp;
