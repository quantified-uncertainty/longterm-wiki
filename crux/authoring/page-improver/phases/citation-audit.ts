/**
 * Citation Audit Phase
 *
 * Post-improve advisory check that verifies each citation in the improved
 * content against its source URL using the citation-auditor module.
 *
 * Runs after the enrich phase. In advisory mode (default), warnings are
 * logged but --apply is never blocked. In gate mode (--citation-gate), the
 * pipeline aborts --apply when the verified fraction falls below the
 * passThreshold.
 *
 * Source cache integration:
 *   When the research phase built a SourceCacheEntry[], it is converted into
 *   the Map<string, FetchedSource> that auditCitations() expects, avoiding
 *   redundant HTTP fetches.  When no cache is available (e.g. polish tier),
 *   the auditor fetches citation URLs directly via source-fetcher.
 *
 * See issue #670.
 */

import { auditCitations, MIN_SOURCE_CONTENT_LENGTH, type AuditResult, type SourceCache } from '../../../lib/citation-auditor.ts';
import type { SourceCacheEntry } from '../../../lib/section-writer.ts';
import type { FetchedSource } from '../../../lib/source-fetcher.ts';
import type { PageData, ResearchResult, PipelineOptions } from '../types.ts';
import { log, writeTemp } from '../utils.ts';

// ---------------------------------------------------------------------------
// Source cache adapter
// ---------------------------------------------------------------------------

/**
 * Convert SourceCacheEntry[] (built by the research phase) to the
 * Map<string, FetchedSource> expected by auditCitations().
 *
 * SourceCacheEntry carries content but no fetch-status field, so we infer
 * status from content length: entries with more than MIN_SOURCE_CONTENT_LENGTH
 * chars are treated as 'ok'.
 */
export function buildAuditorSourceCache(entries: SourceCacheEntry[]): SourceCache {
  const cache: SourceCache = new Map<string, FetchedSource>();
  for (const entry of entries) {
    if (!entry.url) continue;
    const hasContent = entry.content.length > MIN_SOURCE_CONTENT_LENGTH;
    const fetchedSource: FetchedSource = {
      url: entry.url,
      title: entry.title,
      fetchedAt: new Date().toISOString(),
      content: entry.content,
      relevantExcerpts: [],
      // Infer status from content presence — entries without usable content
      // are marked 'error' so the auditor classifies them as 'unchecked'
      // rather than attempting LLM verification on empty text.
      status: hasContent ? 'ok' : 'error',
    };
    cache.set(entry.url, fetchedSource);
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/**
 * Run the post-improve citation audit phase.
 *
 * @param page       Page metadata (used for logging and temp-file naming).
 * @param content    Improved MDX content to audit (after enrich phase).
 * @param research   Research result from the research phase (may be undefined
 *                   for tiers that skip research, e.g. polish).
 * @param options    Pipeline options. citationGate controls whether a failing
 *                   audit should block --apply (gate mode vs advisory mode).
 * @returns AuditResult with per-citation verdicts and summary counts.
 */
export async function citationAuditPhase(
  page: PageData,
  content: string,
  research: ResearchResult | undefined,
  options: PipelineOptions,
): Promise<AuditResult> {
  log('citation-audit', 'Starting post-improve citation audit');

  // Build source cache from research phase when available
  const sourceCache: SourceCache | undefined = research?.sourceCache
    ? buildAuditorSourceCache(research.sourceCache)
    : undefined;

  if (sourceCache && sourceCache.size > 0) {
    log('citation-audit', `Using ${sourceCache.size} pre-fetched source(s) from research phase`);
  } else {
    log('citation-audit', 'No research source cache — will fetch citation URLs directly');
  }

  const result = await auditCitations({
    content,
    sourceCache,
    fetchMissing: true, // fall back to direct URL fetching when not in cache
    passThreshold: 0.8,
    ...(options.citationAuditModel ? { model: options.citationAuditModel } : {}),
  });

  const { total, verified, failed, unchecked } = result.summary;

  // Summary line
  log(
    'citation-audit',
    `Audit complete: ${total} citation(s) — ${verified} verified, ${failed} failed, ${unchecked} unchecked`,
  );

  // Per-citation verdicts
  for (const citation of result.citations) {
    const ref = `[^${citation.footnoteRef}]`;
    if (citation.verdict === 'verified') {
      log('citation-audit', `  ${ref} ✓ verified — ${citation.explanation}`);
    } else if (citation.verdict === 'unsupported' || citation.verdict === 'misattributed') {
      log('citation-audit', `  ${ref} ✗ ${citation.verdict} — ${citation.explanation}`);
      if (citation.claim) {
        log('citation-audit', `    Claim: ${citation.claim.slice(0, 120)}`);
      }
      log('citation-audit', `    URL: ${citation.sourceUrl}`);
    } else {
      // 'unchecked' or 'url-dead' — advisory only
      log('citation-audit', `  ${ref} ? ${citation.verdict} — ${citation.explanation}`);
    }
  }

  if (total === 0) {
    log('citation-audit', 'No citations found — skipping verification');
  } else if (result.pass) {
    log('citation-audit', `✓ Citation audit passed`);
  } else {
    const mode = options.citationGate ? 'GATE' : 'WARNING';
    log(
      'citation-audit',
      `⚠ [${mode}] Citation audit failed: pass rate below threshold (${verified}/${verified + failed} verified)`,
    );
  }

  writeTemp(page.id, 'citation-audit.json', result);
  return result;
}
