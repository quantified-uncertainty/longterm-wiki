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

    // 1. Query claim_page_references JOIN claims for claim data
    const claimRefRows = await db
      .select({
        id: claimPageReferences.id,
        claimId: claimPageReferences.claimId,
        pageId: claimPageReferences.pageId,
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
      .where(eq(claimPageReferences.pageId, pageId));

    const claimRefs: ClaimReferenceItem[] = claimRefRows.map((r) => ({
      type: "claim" as const,
      id: Number(r.id),
      claimId: Number(r.claimId),
      pageId: r.pageId,
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
      .where(eq(pageCitations.pageId, pageId));

    const citations: CitationItem[] = citationRows.map((r) => ({
      type: "citation" as const,
      id: Number(r.id),
      referenceId: r.referenceId,
      pageId: r.pageId,
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

    const rows = await db
      .insert(claimPageReferences)
      .values({
        claimId: parsed.data.claimId,
        pageId: parsed.data.pageId,
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
      pageId: row.pageId,
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

    const rows = await db
      .insert(pageCitations)
      .values({
        referenceId: parsed.data.referenceId,
        pageId: parsed.data.pageId,
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
      pageId: row.pageId,
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

    const values = parsed.data.items.map((item) => ({
      referenceId: item.referenceId,
      pageId: item.pageId,
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

    // 1. Fetch all claim page references with joined claim data
    const claimRefRows = await db
      .select({
        id: claimPageReferences.id,
        claimId: claimPageReferences.claimId,
        pageId: claimPageReferences.pageId,
        footnote: claimPageReferences.footnote,
        section: claimPageReferences.section,
        quoteText: claimPageReferences.quoteText,
        referenceId: claimPageReferences.referenceId,
        createdAt: claimPageReferences.createdAt,
        claimText: claims.claimText,
        claimVerdict: claims.claimVerdict,
      })
      .from(claimPageReferences)
      .innerJoin(claims, eq(claimPageReferences.claimId, claims.id));

    // 2. Fetch all page citations
    const citationRows = await db.select().from(pageCitations);

    // 3. Group by pageId
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
      const pageId = row.pageId;
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
      const pageId = row.pageId;
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

    return c.json({
      pages: byPage,
      totalPages: Object.keys(byPage).length,
      totalClaimRefs: claimRefRows.length,
      totalCitations: citationRows.length,
    });
  });

export const referencesRoute = app;
export type ReferencesRoute = typeof app;
