/**
 * Unified Citation Service — single entry point for all citation checking
 *
 * Consolidates the two check paths:
 *   1. HTTP-only ("http"): fetch each URL, check HTTP status → verified/broken/unverifiable
 *   2. LLM-based ("llm"): fetch each URL, then verify claims against source text via LLM
 *
 * Both paths share:
 *   - Citation extraction from MDX (via citation-archive.ts)
 *   - URL fetching (via source-fetcher.ts)
 *   - Result types and summary statistics
 *
 * Usage:
 *   import { verifyCitations } from './citation-service.ts';
 *
 *   // Quick HTTP check
 *   const httpResult = await verifyCitations({ content, mode: 'http' });
 *
 *   // Full LLM sourcing
 *   const llmResult = await verifyCitations({ content, mode: 'llm', fetchMissing: true });
 *
 * Part of the citation consolidation initiative (#1479).
 */

import {
  extractCitationsFromContent,
  type ExtractedCitation,
} from './citation-archive.ts';
import {
  auditCitations,
  type AuditRequest,
  type AuditResult,
  type AuditVerdict,
  type CitationAudit,
  type SourceCache,
  type ClaimMap,
} from './citation-auditor.ts';
import { fetchSource, type FetchedSource } from '../search/source-fetcher.ts';
import { stripFrontmatter } from '../patterns.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Check mode. */
export type CheckMode = 'http' | 'llm';

/** Status from HTTP-only check. */
export type HttpCheckStatus = 'verified' | 'broken' | 'unverifiable';

/** Result for a single citation (HTTP mode). */
export interface HttpCitationResult {
  footnote: string;
  url: string;
  linkText: string;
  claimContext: string;
  httpStatus: number;
  pageTitle: string | null;
  contentSnippet: string | null;
  contentLength: number;
  status: HttpCheckStatus;
  error: string | null;
}

/** Aggregate result for HTTP-mode check. */
export interface HttpSourcingResult {
  mode: 'http';
  citations: HttpCitationResult[];
  summary: {
    total: number;
    verified: number;
    broken: number;
    unverifiable: number;
  };
}

/** Aggregate result for LLM-mode check. */
export interface LlmSourcingResult {
  mode: 'llm';
  /** Per-citation LLM verdicts (from citation-auditor). */
  citations: CitationAudit[];
  summary: AuditResult['summary'];
  unsourcedTableCells: AuditResult['unsourcedTableCells'];
  pass: boolean;
}

/** Union result type — discriminated on `mode`. */
export type SourcingResult = HttpSourcingResult | LlmSourcingResult;

/** Options for verifyCitations(). */
export interface VerifyCitationsRequest {
  /** Raw MDX content (with or without frontmatter). */
  content: string;

  /** Check mode: 'http' for quick status check, 'llm' for claim sourcing. */
  mode: CheckMode;

  // ---- HTTP mode options ----

  /** Concurrency limit for HTTP fetches. Default: 5. */
  concurrency?: number;
  /** Delay between batches (ms). Default: 1000 for http, 300 for llm. */
  delayMs?: number;

  // ---- LLM mode options ----

  /** Pre-fetched sources (avoids redundant fetches). LLM mode only. */
  sourceCache?: SourceCache;
  /** Pre-extracted claim texts by footnote ref. LLM mode only. */
  claimMap?: ClaimMap;
  /** Whether to fetch URLs not in sourceCache. Default: true. */
  fetchMissing?: boolean;
  /** Fraction of citations that must be verified for pass=true. Default: 0.8. */
  passThreshold?: number;
  /** LLM model for sourcing. LLM mode only. */
  model?: string;
  /** Max concurrent LLM calls. Default: 3. LLM mode only. */
  llmConcurrency?: number;

  // ---- Shared ----

  /** Log progress to stdout. Default: false. */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// HTTP-only check (extracted from citation-archive.verifyCitationsForPage)
// ---------------------------------------------------------------------------

function httpStatusToCheck(httpStatus: number): HttpCheckStatus {
  if (httpStatus === 0) return 'unverifiable';
  if (httpStatus >= 200 && httpStatus < 400) return 'verified';
  return 'broken';
}

async function verifyHttp(
  content: string,
  opts: VerifyCitationsRequest,
): Promise<HttpSourcingResult> {
  const concurrency = opts.concurrency ?? 5;
  const delayMs = opts.delayMs ?? 1000;
  const verbose = opts.verbose ?? false;

  const body = stripFrontmatter(content);
  const extracted = extractCitationsFromContent(body);
  const citations: HttpCitationResult[] = [];

  for (let i = 0; i < extracted.length; i += concurrency) {
    const batch = extracted.slice(i, i + concurrency);

    const results = await Promise.all(
      batch.map(async (ext) => {
        if (verbose) {
          process.stdout.write(`  [^${ext.footnote}] ${ext.url.slice(0, 60)}...`);
        }

        const source = await fetchSource({ url: ext.url, extractMode: 'full' });

        let errorMsg: string | null = null;
        if (source.status === 'error') errorMsg = 'fetch error';
        else if (source.status === 'dead') errorMsg = `HTTP ${source.httpStatus}`;

        const status = httpStatusToCheck(source.httpStatus);

        const result: HttpCitationResult = {
          footnote: ext.footnote,
          url: ext.url,
          linkText: ext.linkText,
          claimContext: ext.claimContext,
          httpStatus: source.httpStatus,
          pageTitle: source.title || null,
          contentSnippet: source.content ? source.content.slice(0, 500) : null,
          contentLength: source.content.length,
          status,
          error: errorMsg,
        };

        if (verbose) {
          const icon = status === 'verified' ? ' ✓' :
                       status === 'broken' ? ' ✗' : ' ?';
          console.log(icon);
        }

        return result;
      }),
    );

    citations.push(...results);

    if (i + concurrency < extracted.length && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return {
    mode: 'http',
    citations,
    summary: {
      total: citations.length,
      verified: citations.filter(c => c.status === 'verified').length,
      broken: citations.filter(c => c.status === 'broken').length,
      unverifiable: citations.filter(c => c.status === 'unverifiable').length,
    },
  };
}

// ---------------------------------------------------------------------------
// LLM sourcing (delegates to citation-auditor)
// ---------------------------------------------------------------------------

async function verifyLlm(
  content: string,
  opts: VerifyCitationsRequest,
): Promise<LlmSourcingResult> {
  const request: AuditRequest = {
    content,
    sourceCache: opts.sourceCache,
    claimMap: opts.claimMap,
    fetchMissing: opts.fetchMissing ?? true,
    passThreshold: opts.passThreshold,
    model: opts.model,
    delayMs: opts.delayMs ?? 300,
    concurrency: opts.llmConcurrency ?? 3,
  };

  const result = await auditCitations(request);

  return {
    mode: 'llm',
    citations: result.citations,
    summary: result.summary,
    unsourcedTableCells: result.unsourcedTableCells,
    pass: result.pass,
  };
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

/**
 * Verify citations in MDX content.
 *
 * @param request - Check options including content and mode.
 * @returns SourcingResult discriminated by mode ('http' or 'llm').
 *
 * HTTP mode: Fetches each URL and checks HTTP status. Fast, no LLM cost.
 * LLM mode: Fetches sources and verifies claims against source text via LLM.
 */
export async function verifyCitations(
  request: VerifyCitationsRequest,
): Promise<SourcingResult> {
  if (request.mode === 'http') {
    return verifyHttp(request.content, request);
  }
  return verifyLlm(request.content, request);
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export {
  extractCitationsFromContent,
  type ExtractedCitation,
} from './citation-archive.ts';

export {
  auditCitations,
  type AuditResult,
  type AuditVerdict,
  type CitationAudit,
  type SourceCache,
  type ClaimMap,
  type AuditRequest,
  type SourceContext,
  type UnsourcedTableCell,
  MIN_SOURCE_CONTENT_LENGTH,
} from './citation-auditor.ts';
