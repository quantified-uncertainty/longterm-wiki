import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";
import type { citationQuotes, citationAccuracySnapshots, citationContent, resourceContentVersions } from "../schema.js";

// ---- In-memory stores simulating Postgres tables ----
// Store types are derived from the Drizzle schema so TypeScript catches column renames.

// citationQuotes.$inferSelect gives camelCase Drizzle field names.
// We use that plus a convenience Map key.
type QuoteRow = typeof citationQuotes.$inferSelect;
// citationAccuracySnapshots.$inferSelect
type SnapshotRow = typeof citationAccuracySnapshots.$inferSelect;
// citationContent.$inferSelect
type ContentRow = typeof citationContent.$inferSelect;
// resourceContentVersions.$inferSelect
type ContentVersionRow = typeof resourceContentVersions.$inferSelect;

let nextQuoteId = 1;
let nextSnapshotId = 1;
let nextContentVersionId = 1;
let quotesStore: Map<string, QuoteRow>; // key: `${pageSlug}:${footnote}`
let contentStore: Map<string, ContentRow>; // key: url
let snapshotStore: Array<SnapshotRow>;
let contentVersionStore: Array<ContentVersionRow>;

let nextSlugIntId = 1000;
const slugIntIdMap = new Map<string, number>();

function getIntIdForSlug(slug: string): number {
  if (!slugIntIdMap.has(slug)) {
    slugIntIdMap.set(slug, nextSlugIntId++);
  }
  return slugIntIdMap.get(slug)!;
}

/** Reverse-lookup: recover slug from integer ID. */
function slugFromIntId(intId: number | null): string | null {
  if (intId === null) return null;
  for (const [slug, id] of slugIntIdMap.entries()) {
    if (id === intId) return slug;
  }
  return null;
}

function resetStores() {
  nextQuoteId = 1;
  nextSnapshotId = 1;
  nextContentVersionId = 1;
  quotesStore = new Map();
  contentStore = new Map();
  snapshotStore = [];
  contentVersionStore = [];
  nextSlugIntId = 1000;
  slugIntIdMap.clear();
}

function quoteKey(pageId: string, footnote: number) {
  return `${pageId}:${footnote}`;
}

/** Convert a QuoteRow (camelCase) to a raw SQL row (snake_case) for dispatch returns. */
function quoteToSqlRow(r: QuoteRow): Record<string, unknown> {
  return {
    id: r.id,
    page_id: r.pageId,
    footnote: r.footnote,
    url: r.url,
    resource_id: r.resourceId,
    claim_text: r.claimText,
    claim_context: r.claimContext,
    source_quote: r.sourceQuote,
    source_location: r.sourceLocation,
    quote_verified: r.quoteVerified,
    verification_method: r.verificationMethod,
    verification_score: r.verificationScore,
    verified_at: r.verifiedAt,
    source_title: r.sourceTitle,
    source_type: r.sourceType,
    extraction_model: r.extractionModel,
    claim_id: r.claimId,
    accuracy_verdict: r.accuracyVerdict,
    accuracy_issues: r.accuracyIssues,
    accuracy_score: r.accuracyScore,
    accuracy_checked_at: r.accuracyCheckedAt,
    accuracy_supporting_quotes: r.accuracySupportingQuotes,
    verification_difficulty: r.verificationDifficulty,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** Convert a SnapshotRow (camelCase) to a raw SQL row (snake_case). */
function snapshotToSqlRow(r: SnapshotRow): Record<string, unknown> {
  return {
    id: r.id,
    page_id: r.pageId,
    total_citations: r.totalCitations,
    checked_citations: r.checkedCitations,
    accurate_count: r.accurateCount,
    minor_issues_count: r.minorIssuesCount,
    inaccurate_count: r.inaccurateCount,
    unsupported_count: r.unsupportedCount,
    not_verifiable_count: r.notVerifiableCount,
    average_score: r.averageScore,
    snapshot_at: r.snapshotAt,
  };
}

/** Convert a ContentRow (camelCase) to a raw SQL row (snake_case). */
function contentToSqlRow(r: ContentRow): Record<string, unknown> {
  return {
    url: r.url,
    resource_id: r.resourceId,
    fetched_at: r.fetchedAt,
    http_status: r.httpStatus,
    content_type: r.contentType,
    page_title: r.pageTitle,
    full_text_preview: r.fullTextPreview,
    full_text: r.fullText,
    content_length: r.contentLength,
    content_hash: r.contentHash,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();
  // Debug: uncomment to see SQL patterns
  // if (q.includes("resource_content_versions")) console.log("DISPATCH rcv:", JSON.stringify({ q: q.slice(0, 300), params }));

  // --- ref-check: SELECT id FROM wiki_pages/resources WHERE id IN (...) ---
  if (q.includes("as id from") && q.includes("where") && q.includes(" in ")) {
    return params.map((p) => ({ id: p }));
  }

  // --- citation_quotes: INSERT ... ON CONFLICT DO UPDATE (supports multi-row) ---
  if (q.includes("insert into") && q.includes("citation_quotes") && q.includes("do update")) {
    // Params: page_id (integer), footnote, url, ...
    const COLS = 14;
    const numRows = params.length / COLS;
    const rows: QuoteRow[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const pageIdNum = params[o] as number;
      const footnote = params[o + 1] as number;
      const url = params[o + 2] as string | null;
      const resourceId = params[o + 3] as string | null;
      const claimText = params[o + 4] as string;
      const claimContext = params[o + 5] as string | null;
      const sourceQuote = params[o + 6] as string | null;
      const sourceLocation = params[o + 7] as string | null;
      const quoteVerified = (params[o + 8] ?? false) as boolean;
      const verificationMethod = params[o + 9] as string | null;
      const verificationScore = params[o + 10] as number | null;
      const sourceTitle = params[o + 11] as string | null;
      const sourceType = params[o + 12] as string | null;
      const extractionModel = params[o + 13] as string | null;

      // Derive slug from integer page_id for the store key
      const pageSlug = slugFromIntId(pageIdNum) ?? `page-${pageIdNum}`;
      const key = quoteKey(pageSlug, footnote);
      const existing = quotesStore.get(key);

      if (existing) {
        const updated: QuoteRow = {
          ...existing,
          pageId: pageIdNum, footnote, url, resourceId,
          claimText, claimContext,
          sourceQuote, sourceLocation,
          quoteVerified, verificationMethod,
          verificationScore, sourceTitle,
          sourceType, extractionModel,
          updatedAt: now,
        };
        quotesStore.set(key, updated);
        rows.push(updated);
      } else {
        const row: QuoteRow = {
          id: nextQuoteId++,
          pageId: pageIdNum, footnote, url, resourceId,
          claimText, claimContext,
          sourceQuote, sourceLocation,
          quoteVerified, verificationMethod,
          verificationScore,
          verifiedAt: null, sourceTitle, sourceType,
          extractionModel,
          claimId: null,
          accuracyVerdict: null, accuracyIssues: null, accuracyScore: null,
          accuracyCheckedAt: null, accuracySupportingQuotes: null,
          verificationDifficulty: null,
          createdAt: now, updatedAt: now,
        };
        quotesStore.set(key, row);
        rows.push(row);
      }
    }
    return rows.map(quoteToSqlRow);
  }

  // --- citation_quotes: UPDATE ... accuracy_verdict ---
  if (q.startsWith("update") && q.includes("citation_quotes") && q.includes("accuracy_verdict")) {
    const verdict = params[0] as string | null;
    const score = params[1] as number | null;
    const issues = params[2] as string | null;
    const supportingQuotes = params[3] as string | null;
    const difficulty = params[4] as string | null;
    const intId = params[5] as number;
    const footnote = params[6] as number;
    const existing = Array.from(quotesStore.values()).find(
      (r) => r.pageId === intId && r.footnote === footnote
    );
    if (!existing) return [];
    existing.accuracyVerdict = verdict;
    existing.accuracyScore = score;
    existing.accuracyIssues = issues;
    existing.accuracySupportingQuotes = supportingQuotes;
    existing.verificationDifficulty = difficulty;
    existing.accuracyCheckedAt = new Date();
    existing.updatedAt = new Date();
    return [quoteToSqlRow(existing)];
  }

  // --- citation_quotes: UPDATE ... quote_verified ---
  if (q.startsWith("update") && q.includes("citation_quotes") && q.includes("quote_verified")) {
    const quoteVerified = params[0] as boolean;
    const method = params[1] as string | null;
    const score = params[2] as number | null;
    const intId = params[3] as number;
    const footnote = params[4] as number;
    const existing = Array.from(quotesStore.values()).find(
      (r) => r.pageId === intId && r.footnote === footnote
    );
    if (!existing) return [];
    existing.quoteVerified = quoteVerified;
    existing.verificationMethod = method;
    existing.verificationScore = score;
    existing.verifiedAt = new Date();
    existing.updatedAt = new Date();
    return [quoteToSqlRow(existing)];
  }

  // --- citation_quotes: Broken quotes (WHERE quote_verified AND verification_score IS NOT NULL AND < threshold) ---
  // Note: !q.includes("group by") prevents this from matching the verdict/difficulty distribution queries.
  if (q.includes("citation_quotes") && q.includes("is not null") && q.includes("where") && !q.includes("group by") && !q.includes("update") && !q.includes("insert")) {
    const threshold = (params[1] as number) ?? 0.5;
    return Array.from(quotesStore.values())
      .filter((r) => r.quoteVerified === true && r.verificationScore != null && (r.verificationScore as number) < threshold)
      .sort((a, b) => (a.verificationScore as number) - (b.verificationScore as number))
      .map((r) => ({
        // slug derived from page_id via LEFT JOIN wiki_pages
        slug: slugFromIntId(r.pageId as number) ?? `page-${r.pageId}`, footnote: r.footnote, url: r.url,
        claim_text: r.claimText, verification_score: r.verificationScore,
      }));
  }

  // --- citation_quotes: Flagged citations (WHERE accuracy_verdict IN ('inaccurate','unsupported') ORDER BY accuracy_score LIMIT) ---
  // Distinguished by the inlined 'inaccurate' literal in the WHERE clause (not a parameterised intId lookup).
  // Must come BEFORE the generic WHERE + ORDER BY handler which assumes page_id lookup.
  if (q.includes("citation_quotes") && q.includes("'inaccurate'") && q.includes("where") && q.includes("order by") && q.includes("limit") && !q.includes("group by")) {
    const all = Array.from(quotesStore.values());
    const flagged = all
      .filter((r) => r.accuracyVerdict === "inaccurate" || r.accuracyVerdict === "unsupported")
      .sort((a, b) => ((a.accuracyScore ?? 0) as number) - ((b.accuracyScore ?? 0) as number));
    return flagged.map(quoteToSqlRow);
  }

  // --- citation_quotes: SELECT * ... WHERE page_id ORDER BY footnote [LIMIT] ---
  if (q.includes("citation_quotes") && q.includes("where") && q.includes("order by") && !q.includes("group by")) {
    const intId = params[0] as number;
    const limit = (params[1] as number) || 1000;
    return Array.from(quotesStore.values())
      .filter((r) => r.pageId === intId)
      .sort((a, b) => (a.footnote as number) - (b.footnote as number))
      .slice(0, limit)
      .map(quoteToSqlRow);
  }

  // --- citation_quotes: SELECT WHERE (no ORDER BY, no COUNT, no GROUP BY) ---
  // Handles health endpoint (with or without LIMIT). First param is always pageId.
  if (q.includes("citation_quotes") && q.includes("where") && !q.includes("count(*)") && !q.includes("group by") && !q.includes("order by")) {
    // Dual-write pre-read: SELECT claim_text, url ... WHERE page_id = ? AND footnote = ? LIMIT 1
    if (params.length === 3 && q.includes("limit")) {
      const intId = params[0] as number;
      const footnote = params[1] as number;
      const found = Array.from(quotesStore.values()).find(
        (r) => r.pageId === intId && r.footnote === footnote
      );
      return found ? [quoteToSqlRow(found)] : [];
    }
    // Health query: params[0] = pageId, optionally params[1] = limit value
    // Single-quote query: params[0] = pageId, params[1] = footnote (handled below if 2 non-limit params)
    if (params.length === 1 || (params.length === 2 && q.includes("limit"))) {
      const intId = params[0] as number;
      return Array.from(quotesStore.values())
        .filter((r) => r.pageId === intId)
        .sort((a, b) => (a.footnote as number) - (b.footnote as number))
        .map(quoteToSqlRow);
    }
    return [];
  }

  // --- citation_quotes: SELECT WHERE LIMIT (no ORDER BY) — GET /quotes/:pageId/:footnote ---
  // params[0]=intId, params[1]=footnote
  if (q.includes("citation_quotes") && q.includes("where") && q.includes("limit") && !q.includes("order by") && !q.includes("count(*)") && !q.includes("group by")) {
    const intId = params[0] as number;
    const footnote = params[1] as number;
    const found = Array.from(quotesStore.values()).find(
      (r) => r.pageId === intId && r.footnote === footnote
    );
    return found ? [quoteToSqlRow(found)] : [];
  }

  // --- citation_quotes: SELECT ... LEFT JOIN wiki_pages ORDER BY ... LIMIT (paginated all with slug) ---
  if (q.includes("citation_quotes") && q.includes("order by") && q.includes("limit") && !q.includes("where") && !q.includes("count(*)") && !q.includes("group by")) {
    const limit = (params[0] as number) || 100;
    const offset = (params[1] as number) || 0;
    const all = Array.from(quotesStore.values()).sort((a, b) => {
      const pc = (a.pageId as number) - (b.pageId as number);
      return pc !== 0 ? pc : (a.footnote as number) - (b.footnote as number);
    });
    return all.slice(offset, offset + limit).map((r) => ({
      ...quoteToSqlRow(r),
      // Include slug from wiki_pages join (used by build-data bundling)
      slug: slugFromIntId(r.pageId as number),
    }));
  }

  // --- citation_quotes: Accuracy-dashboard summary (count + count(case when accuracy_verdict) without group by) ---
  // Must come BEFORE the generic stats handler — distinguished by accuracy_verdict/accuracy_score in the query.
  if (q.includes("citation_quotes") && q.includes("accuracy_verdict") && q.includes("count") && q.includes("case") && !q.includes("group by") && !q.includes("where")) {
    const all = Array.from(quotesStore.values());
    const checked = all.filter((r) => r.accuracyVerdict != null);
    const checkedScores = checked.filter((r) => r.accuracyScore != null).map((r) => r.accuracyScore as number);
    const avgScore = checkedScores.length > 0 ? checkedScores.reduce((a, b) => a + b, 0) / checkedScores.length : null;
    return [{
      count: all.length,
      checked_citations: checked.length,
      accurate_citations: all.filter((r) => r.accuracyVerdict === "accurate").length,
      inaccurate_citations: all.filter((r) => r.accuracyVerdict === "inaccurate").length,
      unsupported_citations: all.filter((r) => r.accuracyVerdict === "unsupported").length,
      minor_issue_citations: all.filter((r) => r.accuracyVerdict === "minor_issues").length,
      avg: avgScore,
    }];
  }

  // --- citation_quotes: Stats aggregation (count + count(case) without group by) ---
  if (q.includes("citation_quotes") && q.includes("count") && q.includes("case") && !q.includes("group by")) {
    const all = Array.from(quotesStore.values());
    const withQuotes = all.filter((r) => r.sourceQuote != null).length;
    const verified = all.filter((r) => r.quoteVerified === true).length;
    const scores = all.filter((r) => r.verificationScore != null).map((r) => r.verificationScore as number);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const pages = new Set(all.map((r) => r.pageId));
    return [{
      count: all.length,
      with_quotes: withQuotes,
      verified,
      unverified: all.length - verified,
      total_pages: pages.size,
      avg: avgScore,
    }];
  }

  // --- citation_quotes: COUNT(*) (simple count, no group by) ---
  if (q.includes("count(*)") && q.includes("citation_quotes") && !q.includes("group by")) {
    return [{ count: quotesStore.size }];
  }

  // --- citation_quotes: Accuracy-snapshot aggregation (GROUP BY + HAVING + not_verifiable) ---
  // Accuracy-snapshot aggregation: selects page_id + slug (via LEFT JOIN wiki_pages), plus detailed counts
  if (q.includes("citation_quotes") && q.includes("group by") && q.includes("having") && q.includes("not_verifiable")) {
    const byPage = new Map<string, QuoteRow[]>();
    for (const r of quotesStore.values()) {
      if (r.accuracyVerdict != null) {
        const s = slugFromIntId(r.pageId as number) ?? `page-${r.pageId}`;
        const arr = byPage.get(s) || [];
        arr.push(r);
        byPage.set(s, arr);
      }
    }
    return Array.from(byPage.entries())
      .map(([pageSlug, rows]) => ({
        page_id: getIntIdForSlug(pageSlug), // citationQuotes.pageId
        slug: pageSlug, // wikiPages.slug via LEFT JOIN — extractColumns finds "slug"
        count: rows.length,
        checked_citations: rows.filter((r) => r.accuracyVerdict != null).length,
        accurate_count: rows.filter((r) => r.accuracyVerdict === "accurate").length,
        minor_issues_count: rows.filter((r) => r.accuracyVerdict === "minor_issues").length,
        inaccurate_count: rows.filter((r) => r.accuracyVerdict === "inaccurate").length,
        unsupported_count: rows.filter((r) => r.accuracyVerdict === "unsupported").length,
        not_verifiable_count: rows.filter((r) => r.accuracyVerdict === "not_verifiable").length,
        avg: null,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  // --- citation_quotes: Accuracy summary (GROUP BY + HAVING, no not_verifiable) ---
  // Accuracy summary: groupBy wikiPages.slug with LEFT JOIN wiki_pages
  if (q.includes("citation_quotes") && q.includes("group by") && q.includes("having")) {
    const byPage = new Map<string, QuoteRow[]>();
    for (const r of quotesStore.values()) {
      if (r.accuracyVerdict != null) {
        const s = slugFromIntId(r.pageId as number) ?? `page-${r.pageId}`;
        const arr = byPage.get(s) || [];
        arr.push(r);
        byPage.set(s, arr);
      }
    }
    return Array.from(byPage.entries())
      .map(([pageSlug, rows]) => ({
        slug: pageSlug, // wikiPages.slug via LEFT JOIN — extractColumns finds "slug"
        checked: rows.length,
        accurate: rows.filter((r) => r.accuracyVerdict === "accurate").length,
        inaccurate: rows.filter((r) => r.accuracyVerdict === "inaccurate").length,
        unsupported: rows.filter((r) => r.accuracyVerdict === "unsupported").length,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  // --- citation_quotes: Verdict distribution (WHERE accuracy_verdict IS NOT NULL + GROUP BY accuracy_verdict) ---
  // accuracy-dashboard query 2: SELECT accuracy_verdict, count(*) ... WHERE accuracy_verdict IS NOT NULL GROUP BY accuracy_verdict
  // Note: accuracy_verdict is in the query; verification_difficulty is NOT.
  if (q.includes("citation_quotes") && q.includes("accuracy_verdict") && q.includes("where") && q.includes("group by") && !q.includes("having") && !q.includes("verification_difficulty")) {
    const verdictCounts = new Map<string, number>();
    for (const r of quotesStore.values()) {
      if (r.accuracyVerdict != null) {
        verdictCounts.set(r.accuracyVerdict as string, (verdictCounts.get(r.accuracyVerdict as string) || 0) + 1);
      }
    }
    return Array.from(verdictCounts.entries()).map(([verdict, cnt]) => ({ accuracy_verdict: verdict, cnt }));
  }

  // --- citation_quotes: Difficulty distribution (WHERE verification_difficulty IS NOT NULL + GROUP BY verification_difficulty) ---
  // accuracy-dashboard query 3. Returns { verification_difficulty, cnt } to match extractColumns mapping.
  if (q.includes("citation_quotes") && q.includes("verification_difficulty") && q.includes("where") && q.includes("group by") && !q.includes("having")) {
    const diffCounts = new Map<string, number>();
    for (const r of quotesStore.values()) {
      if (r.verificationDifficulty != null) {
        diffCounts.set(r.verificationDifficulty as string, (diffCounts.get(r.verificationDifficulty as string) || 0) + 1);
      }
    }
    // Key must be "verification_difficulty" to match the column name extractColumns extracts from
    // SELECT "citation_quotes"."verification_difficulty". Drizzle maps this to the `difficulty` JS field.
    return Array.from(diffCounts.entries()).map(([d, cnt]) => ({ verification_difficulty: d, cnt }));
  }

  // --- citation_quotes: Accuracy-dashboard full select (LEFT JOIN wiki_pages, ORDER BY, no GROUP BY, no WHERE) ---
  // Accuracy-dashboard: explicit select with pageIdSlug via LEFT JOIN wiki_pages
  if (q.includes("citation_quotes") && q.includes("wiki_pages") && q.includes("order by") && !q.includes("group by") && !q.includes("where") && !q.includes("count")) {
    return Array.from(quotesStore.values())
      .sort((a, b) => {
        const pc = (a.pageId as number) - (b.pageId as number);
        return pc !== 0 ? pc : (a.footnote as number) - (b.footnote as number);
      })
      .map((r) => ({
        // wikiPages.slug via LEFT JOIN — extractColumns finds "slug"
        slug: slugFromIntId(r.pageId as number) ?? `page-${r.pageId}`,
        footnote: r.footnote,
        url: r.url,
        claim_text: r.claimText,
        source_quote: r.sourceQuote,
        quote_verified: r.quoteVerified,
        verification_score: r.verificationScore,
        accuracy_verdict: r.accuracyVerdict,
        accuracy_score: r.accuracyScore,
        accuracy_issues: r.accuracyIssues,
        accuracy_supporting_quotes: r.accuracySupportingQuotes,
        verification_difficulty: r.verificationDifficulty,
        accuracy_checked_at: r.accuracyCheckedAt,
        source_title: r.sourceTitle,
      }));
  }

  // --- citation_quotes: Page stats (GROUP BY without HAVING) ---
  // Page stats: groupBy wikiPages.slug with LEFT JOIN wiki_pages
  if (q.includes("citation_quotes") && q.includes("group by") && !q.includes("having")) {
    const byPage = new Map<string, QuoteRow[]>();
    for (const r of quotesStore.values()) {
      const s = slugFromIntId(r.pageId as number) ?? `page-${r.pageId}`;
      const arr = byPage.get(s) || [];
      arr.push(r);
      byPage.set(s, arr);
    }
    return Array.from(byPage.entries())
      .map(([pageSlug, rows]) => ({
        slug: pageSlug, // wikiPages.slug via LEFT JOIN — extractColumns finds "slug"
        count: rows.length,
        with_quotes: rows.filter((r) => r.sourceQuote != null).length,
        verified: rows.filter((r) => r.quoteVerified === true).length,
        avg: null,
        accuracy_checked: rows.filter((r) => r.accuracyVerdict != null).length,
        accurate: rows.filter((r) => r.accuracyVerdict === "accurate").length,
        inaccurate: rows.filter((r) => r.accuracyVerdict === "inaccurate").length,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  // --- citation_accuracy_snapshots: INSERT (supports multi-row) ---
  if (q.includes("insert into") && q.includes("citation_accuracy_snapshots")) {
    // Params: page_id (integer), total_citations, ...
    const COLS = 9;
    const numRows = params.length / COLS;
    const rows: SnapshotRow[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const pageIdNum = params[o] as number | null;
      const row: SnapshotRow = {
        id: nextSnapshotId++,
        pageId: pageIdNum,
        totalCitations: params[o + 1] as number,
        checkedCitations: params[o + 2] as number,
        accurateCount: params[o + 3] as number,
        minorIssuesCount: params[o + 4] as number,
        inaccurateCount: params[o + 5] as number,
        unsupportedCount: params[o + 6] as number,
        notVerifiableCount: params[o + 7] as number,
        averageScore: params[o + 8] as number | null,
        snapshotAt: now,
      };
      snapshotStore.push(row);
      rows.push(row);
    }
    return rows.map(snapshotToSqlRow);
  }

  // --- citation_accuracy_snapshots: Cleanup dry-run total count ---
  if (
    q.includes("count(*)") &&
    q.includes("as total") &&
    q.includes("citation_accuracy_snapshots")
  ) {
    return [{ total: snapshotStore.length }];
  }

  // --- citation_accuracy_snapshots: Cleanup dry-run count of rows to delete ---
  if (
    q.includes("count(*)") &&
    q.includes("not in") &&
    q.includes("row_number") &&
    q.includes("citation_accuracy_snapshots")
  ) {
    const keep = params[0] as number;
    const byPage = new Map<string, typeof snapshotStore>();
    for (const r of snapshotStore) {
      const pageSlug = slugFromIntId(r.pageId as number) ?? `page-${r.pageId}`;
      const arr = byPage.get(pageSlug) || [];
      arr.push(r);
      byPage.set(pageSlug, arr);
    }
    let wouldDelete = 0;
    for (const rows of byPage.values()) {
      rows.sort(
        (a, b) => new Date(b.snapshotAt as Date).getTime() - new Date(a.snapshotAt as Date).getTime()
      );
      if (rows.length > keep) {
        wouldDelete += rows.length - keep;
      }
    }
    return [{ count: wouldDelete }];
  }

  // --- citation_accuracy_snapshots: Cleanup actual delete ---
  if (
    q.includes("delete") &&
    q.includes("citation_accuracy_snapshots") &&
    q.includes("not in") &&
    q.includes("row_number")
  ) {
    const keep = params[0] as number;
    const byPage = new Map<string, typeof snapshotStore>();
    for (const r of snapshotStore) {
      const pageSlug = slugFromIntId(r.pageId as number) ?? `page-${r.pageId}`;
      const arr = byPage.get(pageSlug) || [];
      arr.push(r);
      byPage.set(pageSlug, arr);
    }
    const toDelete = new Set<number>();
    for (const rows of byPage.values()) {
      rows.sort(
        (a, b) => new Date(b.snapshotAt as Date).getTime() - new Date(a.snapshotAt as Date).getTime()
      );
      for (let i = keep; i < rows.length; i++) {
        toDelete.add(rows[i].id as number);
      }
    }
    const deletedCount = toDelete.size;
    snapshotStore = snapshotStore.filter((r) => !toDelete.has(r.id as number));
    return new Array(deletedCount).fill({});
  }

  // --- citation_accuracy_snapshots: SELECT with WHERE ---
  if (q.includes("citation_accuracy_snapshots") && q.includes("where") && !q.includes("group by")) {
    const intId = params[0] as number;
    const limit = (params[1] as number) || 1000;
    return snapshotStore
      .filter((r) => r.pageId === intId)
      .sort((a, b) => new Date(b.snapshotAt as Date).getTime() - new Date(a.snapshotAt as Date).getTime())
      .slice(0, limit)
      .map(snapshotToSqlRow);
  }

  // --- citation_accuracy_snapshots: SELECT with GROUP BY (global trends) ---
  if (q.includes("citation_accuracy_snapshots") && q.includes("group by")) {
    // Group by snapshot_at
    const byTime = new Map<string, SnapshotRow[]>();
    for (const r of snapshotStore) {
      const key = String(r.snapshotAt);
      const arr = byTime.get(key) || [];
      arr.push(r);
      byTime.set(key, arr);
    }
    return Array.from(byTime.entries()).map(([_key, rows]) => ({
      snapshot_at: rows[0].snapshotAt,
      count: rows.length,
      total_citations: rows.reduce((s, r) => s + (r.totalCitations as number), 0),
      checked_citations: rows.reduce((s, r) => s + (r.checkedCitations as number), 0),
      accurate_count: rows.reduce((s, r) => s + (r.accurateCount as number), 0),
      minor_issues_count: rows.reduce((s, r) => s + (r.minorIssuesCount as number), 0),
      inaccurate_count: rows.reduce((s, r) => s + (r.inaccurateCount as number), 0),
      unsupported_count: rows.reduce((s, r) => s + (r.unsupportedCount as number), 0),
      not_verifiable_count: rows.reduce((s, r) => s + (r.notVerifiableCount as number), 0),
      average_score: null,
    }));
  }

  // --- citation_quotes: SELECT * ORDER BY ... (no LIMIT, no WHERE — for accuracy-dashboard) ---
  if (q.includes("citation_quotes") && q.includes("order by") && !q.includes("where") && !q.includes("count(*)") && !q.includes("group by") && !q.includes("limit")) {
    return Array.from(quotesStore.values()).sort((a, b) => {
      const pc = (a.pageId as number) - (b.pageId as number);
      return pc !== 0 ? pc : (a.footnote as number) - (b.footnote as number);
    }).map(quoteToSqlRow);
  }

  // --- citation_content: INSERT ... ON CONFLICT DO UPDATE ---
  if (q.includes("insert into") && q.includes("citation_content")) {
    const url = params[0] as string;
    const resourceId = params[1] as string | null;
    const fetchedAt = params[2] as Date;
    const httpStatus = params[3] as number | null;
    const contentType = params[4] as string | null;
    const pageTitle = params[5] as string | null;
    const fullTextPreview = params[6] as string | null;
    const contentLength = params[7] as number | null;
    const contentHash = params[8] as string | null;
    const now = new Date();
    const existing = contentStore.get(url);
    const row: ContentRow = {
      url,
      resourceId,
      fetchedAt,
      httpStatus,
      contentType,
      pageTitle,
      fullTextPreview,
      fullText: null,
      contentLength,
      contentHash,
      fetchMethod: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    contentStore.set(url, row);
    return [contentToSqlRow(row)];
  }

  // --- resource_content_versions: INSERT ... ON CONFLICT DO NOTHING ---
  if (q.includes("insert into") && q.includes("resource_content_versions")) {
    const resourceId = params[0] as string | null;
    const url = params[1] as string;
    const contentHash = params[2] as string;
    const rawFetchedAt = params[3];
    const fetchedAt = rawFetchedAt instanceof Date ? rawFetchedAt : new Date(rawFetchedAt as string);
    const content = params[4] as string | null;
    const contentLength = params[5] as number | null;
    const httpStatus = params[6] as number | null;
    const contentType = params[7] as string | null;
    const fetchMethod = params[8] as string | null;
    const rawMetadata = params[9];
    const metadata = typeof rawMetadata === "string" ? JSON.parse(rawMetadata) : rawMetadata as Record<string, unknown> | null;
    const now = new Date();
    // Check dedup: UNIQUE(url, content_hash)
    const existing = contentVersionStore.find(
      (r) => r.url === url && r.contentHash === contentHash
    );
    if (existing) return []; // ON CONFLICT DO NOTHING
    const row: ContentVersionRow = {
      id: nextContentVersionId++,
      resourceId,
      url,
      contentHash,
      fetchedAt,
      content,
      contentLength,
      httpStatus,
      contentType,
      fetchMethod,
      metadata,
      createdAt: now,
    };
    contentVersionStore.push(row);
    return [{ id: row.id }];
  }

  // --- resource_content_versions: SELECT ... WHERE url [AND fetched_at <=] ORDER BY fetched_at DESC ---
  if (q.includes("resource_content_versions") && q.includes("where") && q.includes("order by")) {
    const url = params[0] as string;
    // Check if there's a date filter (temporal query: fetched_at <= $2)
    const hasDateFilter = q.includes("<=");
    const dateFilter = hasDateFilter && params[1] instanceof Date ? params[1] as Date : null;

    let filtered = contentVersionStore
      .filter((r) => r.url === url)
      .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());

    if (dateFilter) {
      filtered = filtered.filter((r) => r.fetchedAt.getTime() <= dateFilter.getTime());
    }

    // Handle LIMIT/OFFSET — find the positional params
    const limitMatch = q.match(/limit\s+\$(\d+)/);
    const limitIdx = limitMatch ? parseInt(limitMatch[1]) - 1 : -1;
    const limit = limitIdx >= 0 ? (params[limitIdx] as number) : filtered.length;
    const offsetMatch = q.match(/offset\s+\$(\d+)/);
    const offsetIdx = offsetMatch ? parseInt(offsetMatch[1]) - 1 : -1;
    const offset = offsetIdx >= 0 ? (params[offsetIdx] as number) : 0;
    return filtered.slice(offset, offset + limit).map((r) => ({
      id: r.id, resource_id: r.resourceId, url: r.url,
      content_hash: r.contentHash, fetched_at: r.fetchedAt,
      content: r.content, content_length: r.contentLength,
      http_status: r.httpStatus, content_type: r.contentType,
      fetch_method: r.fetchMethod, metadata: r.metadata,
      created_at: r.createdAt,
    }));
  }

  // --- resource_content_versions: SELECT count(*) WHERE url ---
  if (q.includes("resource_content_versions") && q.includes("count(*)")) {
    const url = params[0] as string;
    return [{ count: contentVersionStore.filter((r) => r.url === url).length }];
  }

  // --- resource_content_versions: SELECT WHERE id (single version) ---
  if (q.includes("resource_content_versions") && q.includes("where") && !q.includes("order by") && !q.includes("count(*)")) {
    const id = params[0] as number;
    const row = contentVersionStore.find((r) => r.id === id);
    if (!row) return [];
    return [{
      id: row.id, resource_id: row.resourceId, url: row.url,
      content_hash: row.contentHash, fetched_at: row.fetchedAt,
      content: row.content, content_length: row.contentLength,
      http_status: row.httpStatus, content_type: row.contentType,
      fetch_method: row.fetchMethod, metadata: row.metadata,
      created_at: row.createdAt,
    }];
  }

  // --- citation_content: SELECT * WHERE url ---
  if (q.includes("citation_content") && q.includes("where")) {
    const url = params[0] as string;
    const row = contentStore.get(url);
    return row ? [contentToSqlRow(row)] : [];
  }

  // --- wiki_pages: SELECT WHERE slug (for resolvePageIntId/resolvePageIntIds) ---
  // Allocating on first use mirrors production where all page slugs have wiki_pages rows.
  // Exception: "no-entity-id" slug returns no row, simulating a page absent from wiki_pages
  // (used to test the null-intId early-return path in routes).
  if (q.includes('from "wiki_pages"') && q.includes("where") && q.includes("slug") && !q.includes("count(*)") && !q.includes("as id")) {
    return params
      .filter((p) => String(p) !== "no-entity-id")
      .map((p) => ({ id: getIntIdForSlug(String(p)), slug: p, title: `Page: ${p}` }));
  }

  // --- entities: SELECT WHERE id (dual-write entity lookup #3671) ---
  if (q.includes('"entities"') && q.includes("where") && !q.includes("count(*)")) {
    return [];
  }

  // --- source_check_evidence: UPDATE/INSERT (dual-write #3671) ---
  if (q.includes("source_check_evidence")) {
    if (q.includes("update")) return [];
    if (q.includes("insert")) return [{ id: 9999 }];
    return [];
  }

  // --- source_check_verdicts: UPDATE/INSERT (dual-write #3671) ---
  if (q.includes("source_check_verdicts")) {
    if (q.includes("update")) return [];
    if (q.includes("insert")) return [{ record_id: "mock" }];
    return [];
  }

  // --- entity_ids fallbacks (for health check count) ---
  if (q.includes("count(*)")) {
    return [{ count: 0 }];
  }

  // --- sequence health check ---
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: true }];
  }

  return [];
}

// Mock the db module
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Helpers ----

async function upsertQuote(app: Hono, pageId: string, footnote: number, claimText = "Test claim") {
  return postJson(app, "/api/citations/quotes/upsert", {
    pageId,
    footnote,
    claimText,
    url: `https://example.com/${pageId}/${footnote}`,
  });
}

// ---- Tests ----

describe("Citation Server API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- Quote Upsert ----

  describe("POST /api/citations/quotes/upsert", () => {
    it("creates a new quote and returns 200", async () => {
      const res = await upsertQuote(app, "test-page", 1);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("test-page");
      expect(body.footnote).toBe(1);
      expect(body.id).toBe(1);
    });

    it("updates existing quote on conflict", async () => {
      await upsertQuote(app, "test-page", 1, "Original claim");
      const res = await postJson(app, "/api/citations/quotes/upsert", {
        pageId: "test-page",
        footnote: 1,
        claimText: "Updated claim",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("test-page");
    });

    it("rejects missing claimText", async () => {
      const res = await postJson(app, "/api/citations/quotes/upsert", {
        pageId: "test-page",
        footnote: 1,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
    });

    it("rejects invalid JSON", async () => {
      const res = await app.request("/api/citations/quotes/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_json");
    });
  });

  // ---- Batch Upsert ----

  describe("POST /api/citations/quotes/upsert-batch", () => {
    it("creates multiple quotes in a batch", async () => {
      const res = await postJson(app, "/api/citations/quotes/upsert-batch", {
        items: [
          { pageId: "page-a", footnote: 1, claimText: "Claim 1" },
          { pageId: "page-a", footnote: 2, claimText: "Claim 2" },
          { pageId: "page-b", footnote: 1, claimText: "Claim 3" },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(3);
      expect(body.results[0].pageId).toBe("page-a");
      expect(body.results[2].pageId).toBe("page-b");
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/citations/quotes/upsert-batch", {
        items: [],
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- Get Quotes ----

  describe("GET /api/citations/quotes", () => {
    it("returns quotes for a page", async () => {
      await upsertQuote(app, "my-page", 1, "Claim one");
      await upsertQuote(app, "my-page", 2, "Claim two");
      await upsertQuote(app, "other-page", 1, "Other claim");

      const res = await app.request("/api/citations/quotes?page_id=my-page");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.quotes).toHaveLength(2);
      expect(body.quotes[0].footnote).toBe(1);
      expect(body.quotes[1].footnote).toBe(2);
    });

    it("returns empty array for unknown page", async () => {
      const res = await app.request("/api/citations/quotes?page_id=nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.quotes).toHaveLength(0);
    });

    it("requires page_id parameter", async () => {
      const res = await app.request("/api/citations/quotes");
      expect(res.status).toBe(400);
    });
  });

  // ---- Get All Quotes (paginated) ----

  describe("GET /api/citations/quotes/all", () => {
    it("returns paginated quotes with pageSlug", async () => {
      for (let i = 1; i <= 5; i++) {
        await upsertQuote(app, "page-x", i);
      }

      const res = await app.request("/api/citations/quotes/all?limit=3&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.quotes).toHaveLength(3);
      expect(body.total).toBe(5);
      expect(body.limit).toBe(3);
      expect(body.offset).toBe(0);
      // Each quote should include the page slug for build-time bundling
      expect(body.quotes[0].pageSlug).toBe("page-x");
    });
  });

  // ---- Mark Verified ----

  describe("POST /api/citations/quotes/mark-verified", () => {
    it("marks a quote as verified", async () => {
      await upsertQuote(app, "verify-page", 1);

      const res = await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "verify-page",
        footnote: 1,
        method: "text-match",
        score: 0.95,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true);
    });

    it("returns 404 for nonexistent quote", async () => {
      const res = await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "nonexistent",
        footnote: 99,
        method: "text-match",
        score: 0.5,
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for page absent from entity_ids (null-intId early-return)", async () => {
      // "no-entity-id" sentinel: entity_ids mock returns no row → resolvePageIntId → null
      const res = await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "no-entity-id",
        footnote: 1,
        method: "text-match",
        score: 0.5,
      });
      expect(res.status).toBe(404);
    });
  });

  // ---- Mark Accuracy ----

  describe("POST /api/citations/quotes/mark-accuracy", () => {
    it("marks accuracy verdict", async () => {
      await upsertQuote(app, "acc-page", 1);

      const res = await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "acc-page",
        footnote: 1,
        verdict: "accurate",
        score: 0.9,
        issues: null,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true);
      expect(body.verdict).toBe("accurate");
    });

    it("rejects invalid verdict", async () => {
      const res = await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "acc-page",
        footnote: 1,
        verdict: "maybe",
        score: 0.5,
      });
      expect(res.status).toBe(400);
    });

    it("dual-writes to source-check tables (#3671)", async () => {
      await upsertQuote(app, "dual-write-page", 1, "Claim about AI safety");

      const res = await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "dual-write-page",
        footnote: 1,
        verdict: "inaccurate",
        score: 0.3,
        issues: "The source contradicts this claim",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true);
      expect(body.verdict).toBe("inaccurate");

      // Wait briefly for the fire-and-forget dual-write to complete
      await new Promise((r) => setTimeout(r, 50));

      // The citation_quotes row should have the verdict set
      const key = "dual-write-page:1";
      const row = quotesStore.get(key);
      expect(row).toBeDefined();
      expect(row!.accuracyVerdict).toBe("inaccurate");
    });
  });

  // ---- Stats ----

  describe("GET /api/citations/stats", () => {
    it("returns aggregate statistics", async () => {
      await upsertQuote(app, "stats-page", 1);
      await upsertQuote(app, "stats-page", 2);

      const res = await app.request("/api/citations/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalQuotes).toBe(2);
      expect(body.totalPages).toBe(1);
      expect(body.verified).toBe(0);
      expect(body.unverified).toBe(2);
    });
  });

  // ---- Page Stats ----

  describe("GET /api/citations/page-stats", () => {
    it("returns per-page statistics", async () => {
      await upsertQuote(app, "page-a", 1);
      await upsertQuote(app, "page-a", 2);
      await upsertQuote(app, "page-b", 1);

      const res = await app.request("/api/citations/page-stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pages).toHaveLength(2);
      expect(body.pages[0].pageId).toBe("page-a");
      expect(body.pages[0].total).toBe(2);
      expect(body.pages[1].pageId).toBe("page-b");
      expect(body.pages[1].total).toBe(1);
    });
  });

  // ---- Accuracy Summary ----

  describe("GET /api/citations/accuracy-summary", () => {
    it("returns pages with accuracy data", async () => {
      await upsertQuote(app, "acc-page", 1);
      await upsertQuote(app, "acc-page", 2);
      await upsertQuote(app, "no-acc-page", 1);

      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "acc-page", footnote: 1, verdict: "accurate", score: 0.9,
      });
      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "acc-page", footnote: 2, verdict: "inaccurate", score: 0.3,
      });

      const res = await app.request("/api/citations/accuracy-summary");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pages).toHaveLength(1);
      expect(body.pages[0].pageId).toBe("acc-page");
      expect(body.pages[0].accurate).toBe(1);
      expect(body.pages[0].inaccurate).toBe(1);
    });
  });

  // ---- Broken Quotes ----

  describe("GET /api/citations/broken", () => {
    it("returns verified quotes with low scores", async () => {
      await upsertQuote(app, "broken-page", 1);
      await upsertQuote(app, "broken-page", 2);

      await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "broken-page", footnote: 1, method: "text-match", score: 0.2,
      });
      await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "broken-page", footnote: 2, method: "text-match", score: 0.9,
      });

      const res = await app.request("/api/citations/broken");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.broken).toHaveLength(1);
      expect(body.broken[0].footnote).toBe(1);
      expect(body.broken[0].verificationScore).toBe(0.2);
    });
  });

  // ---- Content Upsert ----

  describe("POST /api/citations/content/upsert", () => {
    it("creates content entry", async () => {
      const res = await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/article",
        fetchedAt: "2025-01-01T00:00:00Z",
        httpStatus: 200,
        contentType: "text/html",
        pageTitle: "Test Article",
        fullTextPreview: "Some content...",
        contentLength: 1234,
        contentHash: "abc123",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://example.com/article");
    });

    it("rejects missing url", async () => {
      const res = await postJson(app, "/api/citations/content/upsert", {
        fetchedAt: "2025-01-01T00:00:00Z",
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- Content Get ----

  describe("GET /api/citations/content", () => {
    it("returns content for a URL", async () => {
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/article",
        fetchedAt: "2025-01-01T00:00:00Z",
        httpStatus: 200,
        pageTitle: "Test Article",
      });

      const res = await app.request(
        "/api/citations/content?url=https://example.com/article"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://example.com/article");
      expect(body.pageTitle).toBe("Test Article");
      expect(body.httpStatus).toBe(200);
    });

    it("returns 404 for unknown URL", async () => {
      const res = await app.request(
        "/api/citations/content?url=https://example.com/unknown"
      );
      expect(res.status).toBe(404);
    });

    it("requires url parameter", async () => {
      const res = await app.request("/api/citations/content");
      expect(res.status).toBe(400);
    });
  });

  // ---- Accuracy Snapshot ----

  describe("POST /api/citations/accuracy-snapshot", () => {
    it("creates snapshots for pages with accuracy data", async () => {
      await upsertQuote(app, "snap-page", 1);
      await upsertQuote(app, "snap-page", 2);

      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "snap-page", footnote: 1, verdict: "accurate", score: 0.9,
      });
      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "snap-page", footnote: 2, verdict: "inaccurate", score: 0.3,
      });

      const res = await postJson(app, "/api/citations/accuracy-snapshot", {});
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.snapshotCount).toBe(1);
      expect(body.pages).toContain("snap-page");
    });
  });

  // ---- Accuracy Trends ----

  describe("GET /api/citations/accuracy-trends", () => {
    it("returns trends for a specific page", async () => {
      await upsertQuote(app, "trend-page", 1);
      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "trend-page", footnote: 1, verdict: "accurate", score: 0.9,
      });
      await postJson(app, "/api/citations/accuracy-snapshot", {});

      const res = await app.request("/api/citations/accuracy-trends?page_id=trend-page");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("trend-page");
      expect(body.snapshots).toHaveLength(1);
    });

    it("returns global trends when no page_id", async () => {
      const res = await app.request("/api/citations/accuracy-trends");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshots).toBeDefined();
    });
  });

  // ---- Accuracy Dashboard ----

  describe("GET /api/citations/accuracy-dashboard", () => {
    it("returns full dashboard data", async () => {
      await upsertQuote(app, "dash-page", 1, "First claim");
      await upsertQuote(app, "dash-page", 2, "Second claim");

      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "dash-page", footnote: 1, verdict: "accurate", score: 0.9,
      });
      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "dash-page", footnote: 2, verdict: "inaccurate", score: 0.3,
        issues: "Wrong number",
      });

      const res = await app.request("/api/citations/accuracy-dashboard");
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.summary).toBeDefined();
      expect(body.summary.totalCitations).toBe(2);
      expect(body.summary.checkedCitations).toBe(2);
      expect(body.summary.accurateCitations).toBe(1);
      expect(body.summary.inaccurateCitations).toBe(1);

      expect(body.pages).toHaveLength(1);
      expect(body.pages[0].pageId).toBe("dash-page");

      expect(body.flaggedCitations).toHaveLength(1);
      expect(body.flaggedCitations[0].verdict).toBe("inaccurate");
    });

    it("returns empty dashboard when no quotes", async () => {
      const res = await app.request("/api/citations/accuracy-dashboard");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.totalCitations).toBe(0);
      expect(body.pages).toHaveLength(0);
    });
  });

  // ---- Health ----

  describe("GET /api/citations/health/:pageId", () => {
    it("returns zero-filled health for page with no quotes", async () => {
      const res = await app.request("/api/citations/health/empty-page");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("empty-page");
      expect(body.total).toBe(0);
      expect(body.withQuotes).toBe(0);
      expect(body.verified).toBe(0);
      expect(body.accuracyChecked).toBe(0);
      expect(body.accurate).toBe(0);
      expect(body.inaccurate).toBe(0);
      expect(body.avgScore).toBeNull();
    });

    it("returns empty health for page absent from entity_ids (null-intId early-return)", async () => {
      // "no-entity-id" is a sentinel slug that the mock entity_ids handler returns no row for,
      // exercising the resolvePageIntId → null → early-return path.
      const res = await app.request("/api/citations/health/no-entity-id");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("no-entity-id");
      expect(body.total).toBe(0);
    });

    it("returns health summary for a page with mixed statuses", async () => {
      await upsertQuote(app, "health-page", 1, "Claim 1");
      await upsertQuote(app, "health-page", 2, "Claim 2");
      await upsertQuote(app, "health-page", 3, "Claim 3");

      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "health-page", footnote: 1, verdict: "accurate", score: 0.9,
      });
      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "health-page", footnote: 2, verdict: "inaccurate", score: 0.3,
      });
      await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "health-page", footnote: 3, method: "text-match", score: 0.8,
      });

      const res = await app.request("/api/citations/health/health-page");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("health-page");
      expect(body.total).toBe(3);
      expect(body.accuracyChecked).toBe(2);
      expect(body.accurate).toBe(1);
      expect(body.inaccurate).toBe(1);
      expect(body.verified).toBe(1);
    });
  });

  // ---- Accuracy Snapshot Cleanup ----

  describe("DELETE /api/citations/accuracy-snapshots/cleanup", () => {
    /** Seed the in-memory snapshot store directly for cleanup testing. */
    function seedSnapshotStore(pageId: string, count: number) {
      for (let i = 0; i < count; i++) {
        snapshotStore.push({
          id: nextSnapshotId++,
          pageId: getIntIdForSlug(pageId),
          totalCitations: 10,
          checkedCitations: 5,
          accurateCount: 4,
          minorIssuesCount: 1,
          inaccurateCount: 0,
          unsupportedCount: 0,
          notVerifiableCount: 0,
          averageScore: 0.9,
          snapshotAt: new Date(Date.now() - (count - i) * 1000),
        });
      }
    }

    it("dry run reports what would be deleted", async () => {
      seedSnapshotStore("page-a", 5);

      const res = await app.request(
        "/api/citations/accuracy-snapshots/cleanup?keep=2&dry_run=true",
        { method: "DELETE" }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dryRun).toBe(true);
      expect(body.keep).toBe(2);
      expect(body.totalSnapshots).toBe(5);
      expect(body.wouldDelete).toBe(3);
      expect(body.wouldRetain).toBe(2);
    });

    it("actually deletes old snapshots", async () => {
      seedSnapshotStore("page-a", 4);
      seedSnapshotStore("page-b", 2);

      const res = await app.request(
        "/api/citations/accuracy-snapshots/cleanup?keep=2",
        { method: "DELETE" }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // page-a: 4 snapshots, keep 2 → delete 2
      // page-b: 2 snapshots, keep 2 → delete 0
      expect(body.deleted).toBe(2);
      expect(body.keep).toBe(2);
      expect(snapshotStore).toHaveLength(4);
    });

    it("defaults to keeping 30 snapshots per page", async () => {
      const res = await app.request(
        "/api/citations/accuracy-snapshots/cleanup?dry_run=true",
        { method: "DELETE" }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keep).toBe(30);
    });
  });

  // ---- Bearer auth ----

  describe("Bearer auth for citation routes", () => {
    it("rejects unauthenticated requests when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/citations/stats");
      expect(res.status).toBe(401);

      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    });

    it("accepts requests with correct token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/citations/stats", {
        headers: { Authorization: "Bearer test-key" },
      });
      expect(res.status).toBe(200);

      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    });
  });

  // ---- Content Version History ----

  describe("Content version history (dual-write + query)", () => {
    it("dual-writes to resource_content_versions on content upsert", async () => {
      const res = await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/versioned",
        fetchedAt: "2025-01-01T00:00:00Z",
        httpStatus: 200,
        contentType: "text/html",
        pageTitle: "Test Page",
        fullText: "Hello world content",
        contentLength: 19,
        contentHash: "abc123def456",
      });
      expect(res.status).toBe(200);

      // Verify dual-write created a content version
      expect(contentVersionStore.length).toBe(1);
      expect(contentVersionStore[0].url).toBe("https://example.com/versioned");
      expect(contentVersionStore[0].contentHash).toBe("abc123def456");
      expect(contentVersionStore[0].content).toBe("Hello world content");
      expect(contentVersionStore[0].httpStatus).toBe(200);
      const meta = typeof contentVersionStore[0].metadata === "string"
        ? JSON.parse(contentVersionStore[0].metadata as string)
        : contentVersionStore[0].metadata;
      expect(meta).toMatchObject({ pageTitle: "Test Page" });
    });

    it("deduplicates: same content hash does not create new version", async () => {
      // First upsert
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/dedup-test",
        fetchedAt: "2025-01-01T00:00:00Z",
        fullText: "Same content",
        contentHash: "deduphash",
      });
      expect(contentVersionStore.length).toBe(1);

      // Second upsert with same hash — should not create new version
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/dedup-test",
        fetchedAt: "2025-01-02T00:00:00Z",
        fullText: "Same content",
        contentHash: "deduphash",
      });
      expect(contentVersionStore.length).toBe(1);
    });

    it("creates new version when content hash changes", async () => {
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/changing",
        fetchedAt: "2025-01-01T00:00:00Z",
        fullText: "Version 1",
        contentHash: "hash_v1",
      });
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/changing",
        fetchedAt: "2025-02-01T00:00:00Z",
        fullText: "Version 2 with updates",
        contentHash: "hash_v2",
      });
      expect(contentVersionStore.length).toBe(2);
      expect(contentVersionStore[0].contentHash).toBe("hash_v1");
      expect(contentVersionStore[1].contentHash).toBe("hash_v2");
    });

    it("GET /content/history returns paginated version list", async () => {
      // Seed versions directly
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/history-test",
        fetchedAt: "2025-01-01T00:00:00Z",
        fullText: "V1",
        contentHash: "h1",
      });
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/history-test",
        fetchedAt: "2025-02-01T00:00:00Z",
        fullText: "V2",
        contentHash: "h2",
      });

      const res = await app.request(
        "/api/citations/content/history?url=https://example.com/history-test&limit=10"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.versions).toHaveLength(2);
      // Newest first
      expect(body.versions[0].contentHash).toBe("h2");
      expect(body.versions[1].contentHash).toBe("h1");
    });

    it("GET /content/history/:id returns single version with content", async () => {
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/single-ver",
        fetchedAt: "2025-01-01T00:00:00Z",
        fullText: "Full content here",
        contentHash: "singlehash",
      });

      const verId = contentVersionStore[0].id;
      const res = await app.request(`/api/citations/content/history/${verId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(verId);
      expect(body.content).toBe("Full content here");
      expect(body.contentHash).toBe("singlehash");
    });

    it("GET /content/history/:id returns 404 for unknown ID", async () => {
      const res = await app.request("/api/citations/content/history/99999");
      expect(res.status).toBe(404);
    });

    it("GET /content/at returns latest version at or before date", async () => {
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/temporal",
        fetchedAt: "2025-01-15T00:00:00Z",
        fullText: "January version",
        contentHash: "jan",
      });
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/temporal",
        fetchedAt: "2025-03-15T00:00:00Z",
        fullText: "March version",
        contentHash: "mar",
      });

      // Query at Feb 1 — should get January version
      const res = await app.request(
        "/api/citations/content/at?url=https://example.com/temporal&date=2025-02-01T00:00:00Z"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contentHash).toBe("jan");
      expect(body.content).toBe("January version");
    });

    it("GET /content/at returns 404 when no version exists before date", async () => {
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/future-only",
        fetchedAt: "2025-06-01T00:00:00Z",
        fullText: "Future content",
        contentHash: "future",
      });

      const res = await app.request(
        "/api/citations/content/at?url=https://example.com/future-only&date=2025-01-01T00:00:00Z"
      );
      expect(res.status).toBe(404);
    });

    it("skips version write when no contentHash and no fullText", async () => {
      const initialCount = contentVersionStore.length;
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/no-content",
        fetchedAt: "2025-01-01T00:00:00Z",
        httpStatus: 403,
      });
      // No version should be created (no hash, no text to compute hash from)
      expect(contentVersionStore.length).toBe(initialCount);
    });
  });
});
