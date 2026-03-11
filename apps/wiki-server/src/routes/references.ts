/**
 * References API — page citations endpoint.
 *
 * The claim_page_references and claims tables were archived by migration 0065.
 * This route now only serves page_citations data; claim-related fields are
 * returned as empty to preserve backward-compatible response shapes.
 */

import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import {
  pageCitations,
  wikiPages,
  resources,
} from "../schema.js";
import { checkRefsExist } from "./ref-check.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
} from "./utils.js";
import {
  PageCitationInsertSchema,
  PageCitationBatchSchema,
  type PageCitationRow,
} from "../api-types.js";
import { resolvePageIntId, resolvePageIntIds } from "./page-id-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CitationItem extends PageCitationRow {
  type: "citation";
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const app = new Hono()
  // ---- GET /by-page/:pageId — unified references for a page ----
  .get("/by-page/:pageId", async (c) => {
    const pageId = c.req.param("pageId");
    const db = getDrizzleDb();

    // Phase 4b: resolve slug to integer and query by page_id_int
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) {
      return c.json({ references: [], totalClaim: 0, totalCitation: 0 });
    }

    // claim_page_references and claims were archived by migration 0065.
    // Only page_citations remain.

    const citationRows = await db
      .select()
      .from(pageCitations)
      .where(eq(pageCitations.pageIdInt, intId));

    const citations: CitationItem[] = citationRows.map((r) => ({
      type: "citation" as const,
      id: Number(r.id),
      referenceId: r.referenceId,
      pageId, // use URL parameter — page_id_old no longer written for new rows (Phase D2a)
      title: r.title,
      url: r.url,
      note: r.note,
      resourceId: r.resourceId,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
    }));

    return c.json({ references: citations, totalClaim: 0, totalCitation: citations.length });
  })

  // ---- POST /claim — DISABLED: claims tables archived by migration 0065 ----
  .post("/claim", async (c) => {
    return c.json(
      { error: "Claim references are no longer supported. The claims tables were archived by migration 0065." },
      410,
    );
  })

  // ---- POST /citation — create a regular citation ----
  .post("/citation", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = PageCitationInsertSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    // Verify page exists
    const missingPages = await checkRefsExist(
      db,
      wikiPages,
      wikiPages.id,
      [parsed.data.pageId]
    );
    if (missingPages.length > 0) {
      return validationError(c, `Page not found: ${parsed.data.pageId}`);
    }

    // Verify resource exists if provided
    if (parsed.data.resourceId) {
      const missingResources = await checkRefsExist(
        db,
        resources,
        resources.id,
        [parsed.data.resourceId]
      );
      if (missingResources.length > 0) {
        return validationError(c, `Resource not found: ${parsed.data.resourceId}`);
      }
    }

    // Phase D2a: resolve slug to integer ID (no longer dual-writing page_id_old)
    const citPageIdInt = await resolvePageIntId(db, parsed.data.pageId);

    const rows = await db
      .insert(pageCitations)
      .values({
        referenceId: parsed.data.referenceId,
        pageIdInt: citPageIdInt,
        title: parsed.data.title ?? null,
        url: parsed.data.url ?? null,
        note: parsed.data.note ?? null,
        resourceId: parsed.data.resourceId ?? null,
      })
      .returning();

    const row = firstOrThrow(rows, "page_citation insert");
    const result: PageCitationRow = {
      id: Number(row.id),
      referenceId: row.referenceId,
      pageId: parsed.data.pageId, // derived from input — page_id_old no longer written (Phase D2a)
      title: row.title,
      url: row.url,
      note: row.note,
      resourceId: row.resourceId,
      createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    };

    return c.json(result, 201);
  })

  // ---- POST /citations/batch — batch create regular citations ----
  .post("/citations/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = PageCitationBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    // Verify all pages exist
    const pageIds = [...new Set(parsed.data.items.map((i) => i.pageId))];
    const missingPages = await checkRefsExist(db, wikiPages, wikiPages.id, pageIds);
    if (missingPages.length > 0) {
      return validationError(c, `Pages not found: ${missingPages.join(", ")}`);
    }

    // Verify all resources exist (if any provided)
    const resourceIds = [
      ...new Set(
        parsed.data.items
          .filter((i) => i.resourceId)
          .map((i) => i.resourceId!)
      ),
    ];
    if (resourceIds.length > 0) {
      const missingResources = await checkRefsExist(db, resources, resources.id, resourceIds);
      if (missingResources.length > 0) {
        return validationError(c, `Resources not found: ${missingResources.join(", ")}`);
      }
    }

    // Phase D2a: resolve page slugs to integer IDs (no longer dual-writing page_id_old)
    const batchIntIdMap = await resolvePageIntIds(db, pageIds);

    const values = parsed.data.items.map((item) => ({
      referenceId: item.referenceId,
      pageIdInt: batchIntIdMap.get(item.pageId) ?? null,
      title: item.title ?? null,
      url: item.url ?? null,
      note: item.note ?? null,
      resourceId: item.resourceId ?? null,
    }));

    const rows = await db
      .insert(pageCitations)
      .values(values)
      .onConflictDoNothing()
      .returning();

    return c.json({ inserted: rows.length }, 201);
  })

  // ---- GET /all — all references grouped by page (for build-data.mjs) ----
  .get("/all", async (c) => {
    const db = getDrizzleDb();

    // claim_page_references and claims were archived by migration 0065.
    // Only page_citations remain.

    const citationRows = await db
      .select({
        referenceId: pageCitations.referenceId,
        title: pageCitations.title,
        url: pageCitations.url,
        note: pageCitations.note,
        resourceId: pageCitations.resourceId,
        pageSlug: sql<string | null>`coalesce(${pageCitations.pageId}, ${wikiPages.id})`,
      })
      .from(pageCitations)
      .leftJoin(wikiPages, eq(pageCitations.pageIdInt, wikiPages.integerIdCol));

    // Group by pageId (skip rows with no recoverable slug)
    const byPage: Record<
      string,
      {
        claimReferences: Array<{
          claimId: number;
          claimText: string;
          verdict: string | null;
          referenceId: string | null;
        }>;
        citations: Array<{
          referenceId: string;
          title: string | null;
          url: string | null;
          note: string | null;
          resourceId: string | null;
        }>;
      }
    > = {};

    for (const row of citationRows) {
      const pageId = row.pageSlug;
      if (!pageId) continue; // skip rows with no recoverable page slug
      if (!byPage[pageId]) {
        byPage[pageId] = { claimReferences: [], citations: [] };
      }
      byPage[pageId].citations.push({
        referenceId: row.referenceId,
        title: row.title,
        url: row.url,
        note: row.note,
        resourceId: row.resourceId,
      });
    }

    const totalCitations = Object.values(byPage).reduce((n, p) => n + p.citations.length, 0);

    return c.json({
      pages: byPage,
      totalPages: Object.keys(byPage).length,
      totalClaimRefs: 0,
      totalCitations,
    });
  });

export const referencesRoute = app;
export type ReferencesRoute = typeof app;
