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
const MIN_SOURCE_CONTENT_LENGTH = 50;

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
}

// ---------------------------------------------------------------------------
// LLM verification
// ---------------------------------------------------------------------------

/** Parsed response from the per-citation LLM verifier. */
interface VerifierResponse {
  verdict: AuditVerdict;
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

    const verdict = validVerdicts.includes(parsed.verdict as AuditVerdict)
      ? (parsed.verdict as AuditVerdict)
      : 'unsupported';

    return {
      verdict,
      relevantQuote: typeof parsed.relevantQuote === 'string' ? parsed.relevantQuote : '',
      explanation: typeof parsed.explanation === 'string' && parsed.explanation.length > 0
        ? parsed.explanation
        : 'No explanation provided.',
    };
  } catch {
    return {
      verdict: 'unsupported',
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
 * 2. For each citation:
 *    a. Resolves claim text from claimMap or extracts it from the MDX body.
 *    b. Resolves source content from sourceCache, or fetches via source-fetcher.
 *    c. Calls the LLM verifier (cheap model) to produce a verdict.
 * 3. Returns AuditResult with per-citation verdicts, summary, and pass/fail gate.
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
  } = request;

  const body = stripFrontmatter(content);
  const extracted = extractCitationsFromContent(body);

  const citationAudits: CitationAudit[] = [];

  for (let i = 0; i < extracted.length; i++) {
    const ext = extracted[i];
    const footnoteRef = String(ext.footnote);

    // Resolve claim text
    const claim = claimMap?.get(footnoteRef)
      || extractClaimSentence(body, ext.footnote)
      || ext.claimContext;

    // Resolve source
    const source = await resolveSource(ext.url, sourceCache, fetchMissing);

    // Handle: URL not fetchable / not in cache
    if (!source) {
      citationAudits.push({
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
      citationAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: 'url-dead',
        explanation: `URL returned an error status and could not be fetched.`,
      });
      continue;
    }

    // Handle: fetch error (network failure, timeout, or unverifiable domain such as social media).
    // We use 'unchecked' rather than 'url-dead': the error may be transient, and social-media
    // domains that are intentionally blocked should not be flagged as dead URLs.
    if (source.status === 'error') {
      citationAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: 'unchecked',
        explanation: `Source could not be fetched (network error, timeout, or unverifiable domain).`,
      });
      continue;
    }

    // Handle: paywall — mark unchecked regardless of content length
    if (source.status === 'paywall') {
      citationAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: 'unchecked',
        explanation: 'Source is behind a paywall — content not available for verification.',
      });
      continue;
    }

    // Handle: no usable content (social media, PDF, empty page)
    if (!source.content || source.content.length < MIN_SOURCE_CONTENT_LENGTH) {
      citationAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: 'unchecked',
        explanation: 'Source returned no usable text content.',
      });
      continue;
    }

    // LLM verification
    try {
      const verifyResult = await verifyClaimAgainstSource(claim, source.content, { model });

      citationAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: verifyResult.verdict,
        relevantQuote: verifyResult.relevantQuote || undefined,
        explanation: verifyResult.explanation,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      citationAudits.push({
        footnoteRef,
        claim,
        sourceUrl: ext.url,
        verdict: 'unchecked',
        explanation: `Verification error: ${msg.slice(0, 200)}`,
      });
    }

    // Rate-limit between LLM calls
    if (i < extracted.length - 1 && delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Build summary
  const verified = citationAudits.filter((c) => c.verdict === 'verified').length;
  const failed = citationAudits.filter(
    (c) => c.verdict === 'unsupported' || c.verdict === 'misattributed',
  ).length;
  const unchecked = citationAudits.filter(
    (c) => c.verdict === 'unchecked' || c.verdict === 'url-dead',
  ).length;

  // Pass/fail gate: of checkable citations (verified + failed), what fraction is verified?
  const checkable = verified + failed;
  const pass =
    passThreshold <= 0
      ? true
      : checkable === 0
        ? true // nothing checkable → pass by default (no claims to dispute)
        : verified / checkable >= passThreshold;

  return {
    citations: citationAudits,
    summary: { total: citationAudits.length, verified, failed, unchecked },
    newUngroundedClaims: [],
    pass,
  };
}
