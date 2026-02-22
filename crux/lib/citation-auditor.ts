/**
 * Citation Auditor — independent post-hoc verification module
 *
 * Stateless, database-free citation verification. Extracts citations from MDX
 * content, fetches source URLs via the source-fetcher module (or uses a
 * pre-filled cache), and independently verifies each claim against the actual
 * source text using a cheap LLM call.
 *
 * Designed to be embedded in the improve pipeline as a post-improve gate, run
 * as a standalone CLI command, or scheduled for batch health checks.
 *
 * Usage:
 *   import { auditCitations, type AuditRequest } from './citation-auditor.ts';
 *
 *   const result = await auditCitations({
 *     content: pageContent,
 *     fetchMissing: true,
 *   });
 *   if (!result.pass) throw new Error('Citation audit failed');
 *
 * See issue #635.
 */

import { extractCitationsFromContent, extractClaimSentence } from './citation-archive.ts';
import { callOpenRouter, stripCodeFences, truncateSource, DEFAULT_CITATION_MODEL } from './quote-extractor.ts';
import { fetchSource, type FetchedSource } from './source-fetcher.ts';
import { stripFrontmatter } from './patterns.ts';

/** Minimum source content length (chars) required to attempt LLM verification. */
export const MIN_SOURCE_CONTENT_LENGTH = 50;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Pre-fetched source content keyed by URL.
 *
 * Pass this to avoid redundant HTTP requests when sources were already fetched
 * during a research or improve phase. Each value is a FetchedSource (from the
 * source-fetcher module) which carries both content and fetch status.
 */
export type SourceCache = Map<string, FetchedSource>;

/**
 * Known claim texts keyed by footnote reference string (e.g., "3").
 *
 * Pass this when you have precise claim text from a grounded-writer phase.
 * If omitted, claim text is extracted from the MDX content automatically.
 */
export type ClaimMap = Map<string, string>;

/** Verdict for a single citation check. */
export type AuditVerdict =
  | 'verified'      // source clearly supports the claim
  | 'unsupported'   // source does not contain information relevant to the claim
  | 'misattributed' // source has related content but claim misrepresents it
  | 'url-dead';     // URL could not be fetched (4xx/5xx or network error)

/** Audit result for a single citation. */
export interface CitationAudit {
  /** Footnote reference number as a string, e.g. "3" for [^3]. */
  footnoteRef: string;
  /** The claim text extracted from the wiki page (or from claimMap). */
  claim: string;
  /** The URL cited by this footnote. */
  sourceUrl: string;
  /**
   * Verdict from LLM verification, or 'unchecked' if no source was available
   * (e.g., URL not in cache and fetchMissing=false, paywall, or unverifiable
   * domain such as social media).
   */
  verdict: AuditVerdict | 'unchecked';
  /** The passage in the source most relevant to the claim (when LLM verification ran). */
  relevantQuote?: string;
  /** Human-readable explanation of the verdict. */
  explanation: string;
}

/** Aggregate audit report for a page. */
export interface AuditResult {
  /** Per-citation verdicts. */
  citations: CitationAudit[];
  summary: {
    /** Total citations found in the content. */
    total: number;
    /** Citations with verdict='verified'. */
    verified: number;
    /** Citations with verdict='unsupported' or 'misattributed'. */
    failed: number;
    /** Citations with verdict='misattributed' (subset of failed). */
    misattributed: number;
    /** Citations that could not be checked (url-dead, unchecked). */
    unchecked: number;
  };
  /**
   * Placeholder for claims that make factual assertions without any citation.
   * Full detection requires an additional LLM pass over the content.
   * Currently always returns [].
   */
  newUngroundedClaims: string[];
  /** True if the audit passes the passThreshold (enough citations verified). */
  pass: boolean;
}

/** Input request for auditCitations(). */
export interface AuditRequest {
  /** Raw page content (with or without frontmatter — stripped internally). */
  content: string;
  /**
   * Pre-fetched source content keyed by URL. When a URL is found here the
   * auditor skips the network fetch and uses the cached content directly.
   * Useful when sources were already downloaded during a research phase.
   */
  sourceCache?: SourceCache;
  /**
   * Known claim texts keyed by footnote ref string (e.g., "3").
   * When provided, used instead of extracting claim text from the MDX body.
   */
  claimMap?: ClaimMap;
  /**
   * Whether to fetch URLs not present in the sourceCache via the
   * source-fetcher module. Set to false when running in a network-restricted
   * environment or to audit only against pre-fetched sources.
   */
  fetchMissing: boolean;
  /**
   * Fraction of checkable citations that must be 'verified' for pass=true.
   * Checkable = total − url-dead − unchecked.
   * Default: 0.8 (80%). Set to 0 to disable the gate.
   */
  passThreshold?: number;
  /**
   * LLM model for per-citation verification (passed to OpenRouter).
   * Default: google/gemini-2.0-flash-001 (cheap and fast).
   */
  model?: string;
  /**
   * Milliseconds to wait between LLM calls to respect rate limits.
   * Default: 300.
   */
  delayMs?: number;
  /**
   * Maximum number of concurrent LLM verification calls.
   * Default: 3.
   */
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// LLM verification
// ---------------------------------------------------------------------------

/** Parsed response from the per-citation LLM verifier. */
interface VerifierResponse {
  verdict: AuditVerdict | 'unchecked';
  relevantQuote: string;
  explanation: string;
}

const VERIFIER_SYSTEM_PROMPT = `You are a citation verification assistant. Given a claim from a wiki article and the text of the cited source, determine whether the source supports the claim.

Use exactly one of these verdicts:
- "verified": the source clearly and directly supports the claim
- "unsupported": the source does not contain information relevant to this claim
- "misattributed": the source has related content but the claim misrepresents it (wrong numbers, wrong attribution, overclaim, misleading paraphrase)

Rules:
- Search the ENTIRE source for relevant passages before deciding
- Only return "unsupported" if you have checked the full source and it truly contains no relevant information
- Be strict about numbers, dates, and names — even small discrepancies count as "misattributed"
- For "relevantQuote", copy the exact passage from the source most relevant to the claim (1-3 sentences). Return "" if no relevant passage exists.
- For "explanation", give a concise (1-2 sentence) reason for your verdict

Respond in exactly this JSON format:
{"verdict": "verified", "relevantQuote": "exact text from source", "explanation": "why this verdict"}`;

/** Parse and validate the LLM verifier JSON response. */
export function parseVerifierResponse(raw: string): VerifierResponse {
  const json = stripCodeFences(raw);
  const validVerdicts: AuditVerdict[] = ['verified', 'unsupported', 'misattributed'];

  try {
    const parsed = JSON.parse(json) as {
      verdict?: string;
      relevantQuote?: string;
      explanation?: string;
    };

    if (validVerdicts.includes(parsed.verdict as AuditVerdict)) {
      return {
        verdict: parsed.verdict as AuditVerdict,
        relevantQuote: typeof parsed.relevantQuote === 'string' ? parsed.relevantQuote : '',
        explanation: typeof parsed.explanation === 'string' && parsed.explanation.length > 0
          ? parsed.explanation
          : 'No explanation provided.',
      };
    }

    // Unknown verdict string — treat as unchecked (parse succeeded but LLM
    // returned a non-standard verdict). This is distinct from 'unsupported'
    // which means the LLM explicitly found no relevant content (#674).
    return {
      verdict: 'unchecked',
      relevantQuote: typeof parsed.relevantQuote === 'string' ? parsed.relevantQuote : '',
      explanation: `Unknown verdict "${String(parsed.verdict)}" — treated as unchecked.`,
    };
  } catch {
    // JSON parse failure — we cannot determine a verdict at all.
    // Use 'unchecked' rather than 'unsupported' so this doesn't count as a
    // substantive negative finding against the citation (#674).
    return {
      verdict: 'unchecked',
      relevantQuote: '',
      explanation: 'Failed to parse verification response.',
    };
  }
}

/**
 * Verify a single claim against source text via LLM.
 * Returns a verdict, the relevant passage, and an explanation.
 */
async function verifyClaimAgainstSource(
  claim: string,
  sourceText: string,
  opts: { model?: string } = {},
): Promise<VerifierResponse> {
  const truncated = truncateSource(sourceText);

  const userPrompt = `WIKI CLAIM:
${claim}

SOURCE TEXT:
${truncated}

Determine whether the source supports this claim. Return JSON only.`;

  const raw = await callOpenRouter(VERIFIER_SYSTEM_PROMPT, userPrompt, {
    model: opts.model ?? DEFAULT_CITATION_MODEL,
    maxTokens: 500,
    title: 'LongtermWiki Citation Audit',
  });

  return parseVerifierResponse(raw);
}

/**
 * Verify multiple claims against the same source text via a single LLM call (#677).
 * Returns a verdict per claim in the same order as the input claims.
 */
async function verifyClaimBatchAgainstSource(
  claims: Array<{ footnoteRef: string; claim: string }>,
  sourceText: string,
  opts: { model?: string } = {},
): Promise<VerifierResponse[]> {
  if (claims.length === 1) {
    const r = await verifyClaimAgainstSource(claims[0].claim, sourceText, opts);
    return [r];
  }

  const truncated = truncateSource(sourceText);

  const claimList = claims
    .map((c, i) => `[${i + 1}] (footnote ^${c.footnoteRef}): ${c.claim}`)
    .join('\n');

  const batchSystemPrompt = `You are a citation verification assistant. Given MULTIPLE claims from a wiki article and the text of a single cited source, determine whether the source supports each claim.

Use exactly one of these verdicts per claim:
- "verified": the source clearly and directly supports the claim
- "unsupported": the source does not contain information relevant to this claim
- "misattributed": the source has related content but the claim misrepresents it (wrong numbers, wrong attribution, overclaim, misleading paraphrase)

Rules:
- Search the ENTIRE source for relevant passages before deciding
- Only return "unsupported" if you have checked the full source and it truly contains no relevant information
- Be strict about numbers, dates, and names — even small discrepancies count as "misattributed"
- For "relevantQuote", copy the exact passage from the source most relevant to the claim (1-3 sentences). Return "" if no relevant passage exists.
- For "explanation", give a concise (1-2 sentence) reason for your verdict

Respond in exactly this JSON format (one object per claim, in order):
{"results": [{"verdict": "verified", "relevantQuote": "exact text", "explanation": "why"}, ...]}`;

  const userPrompt = `WIKI CLAIMS (against the same source):
${claimList}

SOURCE TEXT:
${truncated}

Determine whether the source supports each claim. Return JSON with one result per claim, in order.`;

  const raw = await callOpenRouter(batchSystemPrompt, userPrompt, {
    model: opts.model ?? DEFAULT_CITATION_MODEL,
    maxTokens: 500 * claims.length,
    title: 'LongtermWiki Citation Audit (batch)',
  });

  return parseBatchVerifierResponse(raw, claims.length);
}

/** Parse the batch verifier response. Falls back to 'unchecked' for unparseable entries. */
export function parseBatchVerifierResponse(raw: string, expectedCount: number): VerifierResponse[] {
  const json = stripCodeFences(raw);
  const validVerdicts: AuditVerdict[] = ['verified', 'unsupported', 'misattributed'];

  try {
    const parsed = JSON.parse(json) as {
      results?: Array<{ verdict?: string; relevantQuote?: string; explanation?: string }>;
    };

    if (!Array.isArray(parsed.results)) {
      const single = parseVerifierResponse(raw);
      return Array.from({ length: expectedCount }, () => ({ ...single }));
    }

    return Array.from({ length: expectedCount }, (_, i) => {
      const entry = parsed.results![i];
      if (!entry || !validVerdicts.includes(entry.verdict as AuditVerdict)) {
        return {
          verdict: 'unchecked' as const,
          relevantQuote: '',
          explanation: entry
            ? `Unknown verdict "${String(entry.verdict)}" — treated as unchecked.`
            : 'Missing result entry in batch response.',
        };
      }
      return {
        verdict: entry.verdict as AuditVerdict,
        relevantQuote: typeof entry.relevantQuote === 'string' ? entry.relevantQuote : '',
        explanation: typeof entry.explanation === 'string' && entry.explanation.length > 0
          ? entry.explanation
          : 'No explanation provided.',
      };
    });
  } catch {
    return Array.from({ length: expectedCount }, () => ({
      verdict: 'unchecked' as const,
      relevantQuote: '',
      explanation: 'Failed to parse batch verification response.',
    }));
  }
}

/**
 * Simple concurrency limiter (avoids external p-limit dependency).
 */
function pLimit(concurrencyLimit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function next() {
    if (queue.length > 0 && active < concurrencyLimit) {
      active++;
      queue.shift()!();
    }
  }

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      };
      queue.push(run);
      next();
    });
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/** Resolve source content for a URL, returning the FetchedSource or null. */
async function resolveSource(
  url: string,
  sourceCache: SourceCache | undefined,
  fetchMissing: boolean,
): Promise<FetchedSource | null> {
  // Check cache first
  const cached = sourceCache?.get(url);
  if (cached !== undefined) return cached;

  // Fetch if allowed
  if (fetchMissing) {
    try {
      return await fetchSource({ url, extractMode: 'full' });
    } catch {
      // Network-level error (timeout, DNS failure, etc.) — return an error-status
      // source so the main loop marks the citation as unchecked rather than crashing.
      return {
        url,
        title: '',
        fetchedAt: new Date().toISOString(),
        content: '',
        relevantExcerpts: [],
        status: 'error',
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core audit function
// ---------------------------------------------------------------------------

/**
 * Audit all citations in MDX content.
 *
 * 1. Extracts citations (footnote → URL + claim context) from the MDX body.
 * 2. Resolves sources and partitions citations into non-LLM (unchecked/dead)
 *    and LLM-verifiable groups (batched by source URL for efficiency).
 * 3. Runs LLM verification concurrently with a configurable concurrency limit.
 * 4. Returns AuditResult with per-citation verdicts, summary, and pass/fail gate.
 *
 * Cost estimate: ~$0.01–0.03 per citation at the default model.
 */
export async function auditCitations(request: AuditRequest): Promise<AuditResult> {
  const {
    content,
    sourceCache,
    claimMap,
    fetchMissing,
    passThreshold = 0.8,
    model,
    delayMs = 300,
    concurrency = 3,
  } = request;

  const body = stripFrontmatter(content);
  const extracted = extractCitationsFromContent(body);

  // Phase 1: Resolve claims and sources, partitioning into non-LLM results
  // and LLM-verifiable groups (batched by source URL, #677).
  const nonLlmAudits: CitationAudit[] = [];
  const llmGroups = new Map<string, {
    sourceText: string;
    claims: Array<{ footnoteRef: string; claim: string; sourceUrl: string }>;
  }>();

  for (const ext of extracted) {
    const footnoteRef = String(ext.footnote);

    // Resolve claim text
    const claim = claimMap?.get(footnoteRef)
      || extractClaimSentence(body, ext.footnote)
      || ext.claimContext;

    // Resolve source
    const source = await resolveSource(ext.url, sourceCache, fetchMissing);

    // Handle: URL not fetchable / not in cache
    if (!source) {
      nonLlmAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: 'unchecked',
        explanation: 'Source not in cache and fetchMissing=false.',
      });
      continue;
    }

    // Handle: URL is dead
    if (source.status === 'dead') {
      nonLlmAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: 'url-dead',
        explanation: 'URL returned an error status and could not be fetched.',
      });
      continue;
    }

    // Handle: fetch error
    if (source.status === 'error') {
      nonLlmAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: 'unchecked',
        explanation: 'Source could not be fetched (network error, timeout, or unverifiable domain).',
      });
      continue;
    }

    // Handle: paywall
    if (source.status === 'paywall') {
      nonLlmAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: 'unchecked',
        explanation: 'Source is behind a paywall — content not available for verification.',
      });
      continue;
    }

    // Handle: no usable content
    if (!source.content || source.content.length < MIN_SOURCE_CONTENT_LENGTH) {
      nonLlmAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: 'unchecked',
        explanation: 'Source returned no usable text content.',
      });
      continue;
    }

    // Queue for LLM verification — group by source URL (#677).
    const sourceText = source.relevantExcerpts && source.relevantExcerpts.length > 0
      ? source.relevantExcerpts.join('\n\n---\n\n')
      : source.content;

    if (!llmGroups.has(ext.url)) {
      llmGroups.set(ext.url, { sourceText, claims: [] });
    }
    llmGroups.get(ext.url)!.claims.push({ footnoteRef, claim, sourceUrl: ext.url });
  }

  // Phase 2: Run LLM verification in parallel with concurrency limit (#677).
  // Each group (same source URL) is a single batched LLM call.
  const limit = pLimit(concurrency);
  const groupTasks = [...llmGroups.entries()].map(([, group]) =>
    limit(async () => {
      const results: CitationAudit[] = [];
      try {
        const verifyResults = await verifyClaimBatchAgainstSource(
          group.claims.map((c) => ({ footnoteRef: c.footnoteRef, claim: c.claim })),
          group.sourceText,
          { model },
        );

        for (let j = 0; j < group.claims.length; j++) {
          const c = group.claims[j];
          const v = verifyResults[j];
          results.push({
            footnoteRef: c.footnoteRef,
            claim: c.claim,
            sourceUrl: c.sourceUrl,
            verdict: v.verdict,
            relevantQuote: v.relevantQuote || undefined,
            explanation: v.explanation,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const c of group.claims) {
          results.push({
            footnoteRef: c.footnoteRef,
            claim: c.claim,
            sourceUrl: c.sourceUrl,
            verdict: 'unchecked',
            explanation: `Verification error: ${msg.slice(0, 200)}`,
          });
        }
      }

      // Rate-limit between LLM calls — only applied after actual LLM calls (#677)
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }

      return results;
    }),
  );

  const groupResults = await Promise.all(groupTasks);
  const llmAudits = groupResults.flat();

  // Combine non-LLM and LLM results, restore footnote order
  const citationAudits = [...nonLlmAudits, ...llmAudits]
    .sort((a, b) => parseInt(a.footnoteRef, 10) - parseInt(b.footnoteRef, 10));

  // Build summary
  const verified = citationAudits.filter((c) => c.verdict === 'verified').length;
  const misattributed = citationAudits.filter((c) => c.verdict === 'misattributed').length;
  const failed = citationAudits.filter(
    (c) => c.verdict === 'unsupported' || c.verdict === 'misattributed',
  ).length;
  const unchecked = citationAudits.filter(
    (c) => c.verdict === 'unchecked' || c.verdict === 'url-dead',
  ).length;

  // Pass/fail gate:
  // 1. Any misattributed citation is a hard fail — the source actively contradicts
  //    the claim, which is worse than simply being unsupported (#678).
  // 2. Of checkable citations (verified + failed), what fraction is verified?
  const checkable = verified + failed;
  const pass =
    misattributed > 0
      ? false
      : passThreshold <= 0
        ? true
        : checkable === 0
          ? true // nothing checkable → pass by default (no claims to dispute)
          : verified / checkable >= passThreshold;

  return {
    citations: citationAudits,
    summary: { total: citationAudits.length, verified, failed, misattributed, unchecked },
    newUngroundedClaims: [],
    pass,
  };
}
