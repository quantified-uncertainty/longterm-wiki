/**
 * References API — unified endpoint for claim-backed and regular page citations.
 *
 * Provides a single GET endpoint that returns both claim_page_references (with
 * joined claim data) and page_citations for a given page, plus POST endpoints
 * for creating each type individually or in batch.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import {
  claimPageReferences,
  pageCitations,
  claims,
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
  ClaimPageReferenceInsertSchema,
  PageCitationInsertSchema,
  PageCitationBatchSchema,
  type ClaimPageReferenceRow,
  type PageCitationRow,
} from "../api-types.js";
import { resolvePageIntId, resolvePageIntIds } from "./page-id-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaimReferenceItem extends ClaimPageReferenceRow {
  type: "claim";
  claimText: string;
  claimVerdict: string | null;
}

interface CitationItem extends PageCitationRow {
  type: "citation";
}

type UnifiedReference = ClaimReferenceItem | CitationItem;

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

    // 1. Query claim_page_references JOIN claims for claim data
    const claimRefRows = await db
      .select({
        id: claimPageReferences.id,
        claimId: claimPageReferences.claimId,
        footnote: claimPageReferences.footnote,
        section: claimPageReferences.section,
        quoteText: claimPageReferences.quoteText,
        referenceId: claimPageReferences.referenceId,
        createdAt: claimPageReferences.createdAt,
        claimText: claims.claimText,
        claimVerdict: claims.claimVerdict,
      })
      .from(claimPageReferences)
      .innerJoin(claims, eq(claimPageReferences.claimId, claims.id))
      .where(eq(claimPageReferences.pageIdInt, intId));

    const claimRefs: ClaimReferenceItem[] = claimRefRows.map((r) => ({
      type: "claim" as const,
      id: Number(r.id),
      claimId: Number(r.claimId),
      pageId, // derived from URL parameter (page_id_old dropped in D2b)
      footnote: r.footnote,
      section: r.section,
      quoteText: r.quoteText,
      referenceId: r.referenceId,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
      claimText: r.claimText,
      claimVerdict: r.claimVerdict,
    }));

    // 2. Query page_citations for regular citations
    const citationRows = await db
      .select()
      .from(pageCitations)
      .where(eq(pageCitations.pageIdInt, intId));

    const citations: CitationItem[] = citationRows.map((r) => ({
      type: "citation" as const,
      id: Number(r.id),
      referenceId: r.referenceId,
      pageId, // derived from URL parameter (page_id_old dropped in D2b)
      title: r.title,
      url: r.url,
      note: r.note,
      resourceId: r.resourceId,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
    }));

    // 3. Return unified list
    const references: UnifiedReference[] = [
      ...claimRefs,
      ...citations,
    ];

    return c.json({ references, totalClaim: claimRefs.length, totalCitation: citations.length });
  })

  // ---- POST /claim — create a claim page reference ----
  .post("/claim", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = ClaimPageReferenceInsertSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    // Verify claim exists
    const missingClaims = await checkRefsExist(
      db,
      claims,
      claims.id,
      [String(parsed.data.claimId)]
    );
    if (missingClaims.length > 0) {
      return validationError(c, `Claim not found: ${parsed.data.claimId}`);
    }

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

    // Phase D2a: resolve slug to integer ID (no longer dual-writing page_id_old)
    const pageIdInt = await resolvePageIntId(db, parsed.data.pageId);

    const rows = await db
      .insert(claimPageReferences)
      .values({
        claimId: parsed.data.claimId,
        pageIdInt,
        footnote: parsed.data.footnote ?? null,
        section: parsed.data.section ?? null,
        quoteText: parsed.data.quoteText ?? null,
        referenceId: parsed.data.referenceId ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (rows.length === 0) {
      return c.json({ message: "Reference already exists" }, 200);
    }

    const row = rows[0];
    const result: ClaimPageReferenceRow = {
      id: Number(row.id),
      claimId: Number(row.claimId),
      pageId: parsed.data.pageId, // derived from input (page_id_old no longer written)
      footnote: row.footnote,
      section: row.section,
      quoteText: row.quoteText,
      referenceId: row.referenceId,
      createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    };

    return c.json(result, 201);
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

    // 1. Fetch all claim page references with joined claim data.
    //    Phase D2b: page_id_old dropped; join wiki_pages to get slug via page_id_int.
    const claimRefRows = await db
      .select({
        id: claimPageReferences.id,
        claimId: claimPageReferences.claimId,
        pageSlug: wikiPages.id,
        footnote: claimPageReferences.footnote,
        section: claimPageReferences.section,
        quoteText: claimPageReferences.quoteText,
        referenceId: claimPageReferences.referenceId,
        createdAt: claimPageReferences.createdAt,
        claimText: claims.claimText,
        claimVerdict: claims.claimVerdict,
      })
      .from(claimPageReferences)
      .innerJoin(claims, eq(claimPageReferences.claimId, claims.id))
      .leftJoin(wikiPages, eq(claimPageReferences.pageIdInt, wikiPages.integerIdCol));

    // 2. Fetch all page citations with wiki_pages JOIN for slug recovery.
    //    Phase D2b: page_id_old dropped; use wiki_pages.id directly.
    const citationRows = await db
      .select({
        referenceId: pageCitations.referenceId,
        title: pageCitations.title,
        url: pageCitations.url,
        note: pageCitations.note,
        resourceId: pageCitations.resourceId,
        pageSlug: wikiPages.id,
      })
      .from(pageCitations)
      .leftJoin(wikiPages, eq(pageCitations.pageIdInt, wikiPages.integerIdCol));

    // 3. Group by pageId (skip rows with no recoverable slug)
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

    for (const row of claimRefRows) {
      const pageId = row.pageSlug;
      if (!pageId) continue; // skip rows with no recoverable page slug
      if (!byPage[pageId]) {
        byPage[pageId] = { claimReferences: [], citations: [] };
      }
      byPage[pageId].claimReferences.push({
        claimId: Number(row.claimId),
        claimText: row.claimText,
        verdict: row.claimVerdict,
        referenceId: row.referenceId,
      });
    }

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

    // Derive totals from filtered byPage (rows with no recoverable slug are excluded)
    const totalClaimRefs = Object.values(byPage).reduce((n, p) => n + p.claimReferences.length, 0);
    const totalCitations = Object.values(byPage).reduce((n, p) => n + p.citations.length, 0);

    return c.json({
      pages: byPage,
      totalPages: Object.keys(byPage).length,
      totalClaimRefs,
      totalCitations,
    });
  });

export const referencesRoute = app;
export type ReferencesRoute = typeof app;
