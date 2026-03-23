/**
 * Page Verification Command
 *
 * Extracts factual claims from wiki page prose, identifies which are
 * cited vs uncited, and optionally verifies uncited claims against
 * web evidence.
 *
 * Usage:
 *   crux verify page <page-id>                   Standard: extract + identify uncited
 *   crux verify page <page-id> --quick            Just count cited vs uncited claims
 *   crux verify page <page-id> --deep             Also verify uncited claims against web
 *   crux verify page <page-id> --budget=2         Limit spending (default: $2)
 */

import type { CommandResult } from '../lib/command-types.ts';
import { findPageById } from '../lib/page-resolution.ts';
import {
  preprocessMdxForExtraction,
  splitIntoChunks,
  extractClaims,
} from '../lib/semantic-diff/claim-extractor.ts';
import type { ExtractedClaim } from '../lib/semantic-diff/types.ts';
import { createLlmClient, callLlm, runLlmAgent, MODELS } from '../lib/llm.ts';
import { parseJsonFromLlm } from '../lib/json-parsing.ts';
import { CostTracker } from '../lib/cost-tracker.ts';

// ── Types ────────────────────────────────────────────────────────────

interface FootnoteMap {
  /** Maps sentence text → list of footnote numbers attached to it */
  sentencesWithFootnotes: Set<string>;
  totalFootnotes: number;
}

interface ClaimWithCitation extends ExtractedClaim {
  hasCitation: boolean;
  checkWorthy: boolean;
}

type WebVerdict = 'supported' | 'contradicted' | 'unverifiable' | 'partially_supported';

interface VerifiedClaim extends ClaimWithCitation {
  verdict?: WebVerdict;
  evidence?: string;
  searchQuery?: string;
  reasoning?: string;
}

interface PageVerificationReport {
  pageId: string;
  title: string;
  totalClaims: number;
  citedClaims: number;
  uncitedClaims: number;
  checkWorthyClaims: number;
  verified: number;
  verdicts: Record<WebVerdict, number>;
  claims: VerifiedClaim[];
  cost: number;
  durationMs: number;
}

// ── Footnote detection ───────────────────────────────────────────────

/**
 * Build a map of which sentences in the raw MDX have footnote references.
 * We look for [^N] patterns and associate them with the surrounding sentence.
 */
function buildFootnoteMap(rawContent: string): FootnoteMap {
  // Strip frontmatter
  const content = rawContent.replace(/^---[\s\S]*?---\n/, '');

  // Find all footnote reference positions (IDs can contain alphanumeric, hyphens, colons, underscores)
  const footnotePattern = /\[\^[\w:.-]+\]/g;
  const footnoteMatches = [...content.matchAll(footnotePattern)];

  // For each footnote, find the sentence it's in
  const sentencesWithFootnotes = new Set<string>();
  for (const match of footnoteMatches) {
    if (match.index === undefined) continue;
    // Get surrounding context (200 chars before the footnote)
    const start = Math.max(0, match.index - 200);
    const context = content.slice(start, match.index);
    // Find the last sentence boundary before the footnote
    const sentenceMatch = context.match(/[^.!?\n]*$/);
    if (sentenceMatch) {
      const sentence = sentenceMatch[0].trim().toLowerCase();
      if (sentence.length > 10) {
        sentencesWithFootnotes.add(sentence);
      }
    }
  }

  return {
    sentencesWithFootnotes,
    totalFootnotes: footnoteMatches.length,
  };
}

/**
 * Check if a claim's source context appears near a footnote in the original text.
 *
 * Strategy: take key phrases from the claim text, search for them in the raw
 * content, and check if a footnote reference appears within ~100 chars after.
 */
function claimHasCitation(
  claim: ExtractedClaim,
  rawContent: string,
): boolean {
  // Use the claim's keyValue or a distinctive phrase from the claim text
  const searchTerms: string[] = [];

  if (claim.keyValue && claim.keyValue.length > 3) {
    searchTerms.push(claim.keyValue);
  }

  // Take the first substantive phrase (skip common words)
  const words = claim.text.split(/\s+/).filter(w => w.length > 3);
  if (words.length >= 3) {
    // Use a 3-word window from the middle of the claim
    const mid = Math.floor(words.length / 2);
    searchTerms.push(words.slice(Math.max(0, mid - 1), mid + 2).join(' '));
  }

  // Also try the sourceContext if available
  if (claim.sourceContext && claim.sourceContext.length > 20) {
    const contextWords = claim.sourceContext.split(/\s+/).filter(w => w.length > 3);
    if (contextWords.length >= 2) {
      searchTerms.push(contextWords.slice(0, 3).join(' '));
    }
  }

  const contentLower = rawContent.toLowerCase();
  const footnoteNearby = /\[\^[\w:.-]+\]/;

  for (const term of searchTerms) {
    const termLower = term.toLowerCase();
    const idx = contentLower.indexOf(termLower);
    if (idx === -1) continue;

    // Check if there's a footnote within 150 chars after this term
    const after = rawContent.slice(idx, idx + termLower.length + 150);
    if (footnoteNearby.test(after)) {
      return true;
    }
  }

  return false;
}

// ── Checkworthiness filter ───────────────────────────────────────────

/**
 * Loki-inspired checkworthiness filter.
 * Skip claims that are definitions, vague existence claims, or trivially true.
 */
function isCheckWorthy(claim: ExtractedClaim): boolean {
  // Definitions are not worth fact-checking against the web
  if (claim.type === 'definition') return false;

  // Low-confidence claims from the extractor are often vague
  if (claim.confidence === 'low') return false;

  // Existence claims without a specific keyValue are usually trivial
  if (claim.type === 'existence' && !claim.keyValue) return false;

  // Very short claims are usually not substantive
  if (claim.text.length < 20) return false;

  return true;
}

// ── Web verification ─────────────────────────────────────────────────

const VERIFY_SYSTEM_PROMPT = `You verify factual claims against web search evidence. For each claim, you will be given search results. Determine whether the evidence supports or contradicts the claim.

Output JSON:
{
  "verdict": "supported" | "contradicted" | "partially_supported" | "unverifiable",
  "reasoning": "Brief explanation of why",
  "evidence": "The specific text from search results that supports/contradicts"
}

Rules:
- "supported": Evidence clearly confirms the claim
- "contradicted": Evidence clearly contradicts the claim (different number, date, attribution, etc.)
- "partially_supported": Some aspects confirmed but key details differ or are uncertain
- "unverifiable": Search results don't address this specific claim`;

interface VerifyResult {
  verdict: WebVerdict;
  reasoning: string;
  evidence: string;
}

async function generateSearchQuery(claim: ExtractedClaim): Promise<string> {
  // Simple heuristic: use the claim text directly, stripped of hedging
  const text = claim.text
    .replace(/^(approximately|about|around|roughly|estimated)\s+/i, '')
    .replace(/\s+(approximately|about|around|roughly)$/i, '');

  // If there's a keyValue, emphasize it
  if (claim.keyValue) {
    return `${text} ${claim.keyValue}`;
  }
  return text;
}

async function verifyClaimAgainstWeb(
  claim: ClaimWithCitation,
  client: ReturnType<typeof createLlmClient>,
  costTracker: CostTracker,
): Promise<VerifiedClaim> {
  const searchQuery = await generateSearchQuery(claim);

  try {
    // Single agent call: search web + produce verdict in one pass
    const resultText = await runLlmAgent(client, `Verify this factual claim by searching the web for evidence, then produce a verdict.

Claim: "${claim.text}"${claim.keyValue ? `\nKey value to check: ${claim.keyValue}` : ''}

After searching, respond with ONLY a JSON object (no other text):
{
  "verdict": "supported" | "contradicted" | "partially_supported" | "unverifiable",
  "reasoning": "Brief explanation",
  "evidence": "The specific text from search results that supports/contradicts"
}`, {
      model: MODELS.haiku,
      maxTokens: 1500,
      systemPrompt: VERIFY_SYSTEM_PROMPT,
      serverTools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
      maxToolTurns: 3,
      retryLabel: 'verify-claim',
      costTracker,
    });

    const parsed = parseJsonFromLlm<VerifyResult>(
      resultText,
      'verify-verdict',
      () => ({ verdict: 'unverifiable' as WebVerdict, reasoning: 'Failed to parse verdict', evidence: '' }),
    );

    const validVerdicts = new Set<WebVerdict>(['supported', 'contradicted', 'partially_supported', 'unverifiable']);
    const verdict = validVerdicts.has(parsed.verdict) ? parsed.verdict : 'unverifiable';

    return {
      ...claim,
      verdict,
      reasoning: parsed.reasoning || '',
      evidence: parsed.evidence || '',
      searchQuery,
    };
  } catch (e) {
    return {
      ...claim,
      verdict: 'unverifiable',
      reasoning: `Error during verification: ${e instanceof Error ? e.message : String(e)}`,
      searchQuery,
    };
  }
}

// ── Main command ─────────────────────────────────────────────────────

export async function verifyPageCommand(
  pageId: string,
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const mode = options.deep ? 'deep' : options.quick ? 'quick' : 'standard';
  const budget = Number(options.budget) || 2;
  const startTime = Date.now();

  // Load page
  const page = findPageById(pageId);
  if (!page) {
    return { exitCode: 1, output: `Page not found: ${pageId}` };
  }

  console.log(`\n  Verifying: ${page.title} (${page.slug})`);
  console.log(`  Mode: ${mode}\n`);

  // Step 1: Extract claims
  console.log('  [1/4] Extracting claims...');
  const claims = await extractClaims(page.content);
  console.log(`         Found ${claims.length} claims`);

  if (claims.length === 0) {
    return {
      exitCode: 0,
      output: `No verifiable claims found in ${page.title}`,
    };
  }

  // Step 2: Classify cited vs uncited by checking if claim text appears near a footnote
  console.log('  [2/4] Classifying cited vs uncited...');
  const footnoteMap = buildFootnoteMap(page.content);
  // Strip frontmatter for raw content search
  const rawContent = page.content.replace(/^---[\s\S]*?---\n/, '');

  const classifiedClaims: ClaimWithCitation[] = claims.map(claim => ({
    ...claim,
    hasCitation: claimHasCitation(claim, rawContent),
    checkWorthy: isCheckWorthy(claim),
  }));

  const cited = classifiedClaims.filter(c => c.hasCitation);
  const uncited = classifiedClaims.filter(c => !c.hasCitation);
  const checkWorthy = uncited.filter(c => c.checkWorthy);

  console.log(`         ${cited.length} cited, ${uncited.length} uncited (${checkWorthy.length} check-worthy)`);
  console.log(`         ${footnoteMap.totalFootnotes} footnotes in page`);

  if (mode === 'quick') {
    // Quick mode: just report the breakdown
    const report: PageVerificationReport = {
      pageId: page.slug,
      title: page.title,
      totalClaims: claims.length,
      citedClaims: cited.length,
      uncitedClaims: uncited.length,
      checkWorthyClaims: checkWorthy.length,
      verified: 0,
      verdicts: { supported: 0, contradicted: 0, partially_supported: 0, unverifiable: 0 },
      claims: classifiedClaims.map(c => ({ ...c })),
      cost: 0,
      durationMs: Date.now() - startTime,
    };

    return { exitCode: 0, output: formatReport(report) };
  }

  // Step 3: Verify uncited check-worthy claims against web
  console.log('  [3/4] Verifying uncited claims against web...');
  const costTracker = new CostTracker(budget);
  const client = createLlmClient();

  const verifiedClaims: VerifiedClaim[] = [];
  let verifiedCount = 0;
  let budgetExhausted = false;

  for (const claim of classifiedClaims) {
    const shouldVerify = mode === 'deep' && !claim.hasCitation && claim.checkWorthy;

    if (shouldVerify && costTracker.totalCost >= budget && !budgetExhausted) {
      budgetExhausted = true;
      console.log(`         Budget limit reached ($${budget}), skipping remaining claims`);
    }

    if (shouldVerify && costTracker.totalCost < budget && !budgetExhausted) {
      const verified = await verifyClaimAgainstWeb(claim, client, costTracker);
      verifiedClaims.push(verified);
      verifiedCount++;
      const icon = verified.verdict === 'supported' ? '+' :
        verified.verdict === 'contradicted' ? 'X' :
        verified.verdict === 'partially_supported' ? '~' : '?';
      console.log(`         [${icon}] ${verified.text.slice(0, 70)}...`);
    } else {
      verifiedClaims.push({ ...claim });
    }
  }

  console.log(`  [4/4] Done. Verified ${verifiedCount} claims against web.`);

  // Build report
  const verdictCounts: Record<WebVerdict, number> = {
    supported: 0, contradicted: 0, partially_supported: 0, unverifiable: 0,
  };
  for (const c of verifiedClaims) {
    if (c.verdict) verdictCounts[c.verdict]++;
  }

  const report: PageVerificationReport = {
    pageId: page.slug,
    title: page.title,
    totalClaims: claims.length,
    citedClaims: cited.length,
    uncitedClaims: uncited.length,
    checkWorthyClaims: checkWorthy.length,
    verified: verifiedCount,
    verdicts: verdictCounts,
    claims: verifiedClaims,
    cost: costTracker.totalCost,
    durationMs: Date.now() - startTime,
  };

  return { exitCode: 0, output: formatReport(report) };
}

// ── Report formatting ────────────────────────────────────────────────

function formatReport(report: PageVerificationReport): string {
  const lines: string[] = [];

  lines.push(`\n  Page Verification Report: ${report.title}`);
  lines.push(`  ${'─'.repeat(50)}`);
  lines.push(`  Total claims extracted:  ${report.totalClaims}`);
  lines.push(`  Cited (have footnote):   ${report.citedClaims}`);
  lines.push(`  Uncited:                 ${report.uncitedClaims}`);
  lines.push(`  Check-worthy uncited:    ${report.checkWorthyClaims}`);

  if (report.verified > 0) {
    lines.push('');
    lines.push(`  Web verification results (${report.verified} claims):`);
    lines.push(`    Supported:             ${report.verdicts.supported}`);
    lines.push(`    Contradicted:          ${report.verdicts.contradicted}`);
    lines.push(`    Partially supported:   ${report.verdicts.partially_supported}`);
    lines.push(`    Unverifiable:          ${report.verdicts.unverifiable}`);
  }

  lines.push('');
  lines.push(`  Cost: $${report.cost.toFixed(3)}`);
  lines.push(`  Duration: ${(report.durationMs / 1000).toFixed(1)}s`);

  // Show uncited check-worthy claims
  const uncitedCheckWorthy = report.claims.filter(c => !c.hasCitation && c.checkWorthy);
  if (uncitedCheckWorthy.length > 0) {
    lines.push('');
    lines.push(`  Uncited check-worthy claims:`);
    for (const claim of uncitedCheckWorthy.slice(0, 20)) {
      const verdictIcon = claim.verdict === 'supported' ? ' [OK]' :
        claim.verdict === 'contradicted' ? ' [!!]' :
        claim.verdict === 'partially_supported' ? ' [~]' :
        claim.verdict === 'unverifiable' ? ' [?]' : '';
      lines.push(`    - ${claim.text}${verdictIcon}`);
      if (claim.verdict === 'contradicted' && claim.reasoning) {
        lines.push(`      Reason: ${claim.reasoning}`);
      }
    }
    if (uncitedCheckWorthy.length > 20) {
      lines.push(`    ... and ${uncitedCheckWorthy.length - 20} more`);
    }
  }

  // Show contradicted claims prominently
  const contradicted = report.claims.filter(c => c.verdict === 'contradicted');
  if (contradicted.length > 0) {
    lines.push('');
    lines.push(`  CONTRADICTED CLAIMS:`);
    for (const claim of contradicted) {
      lines.push(`    !! ${claim.text}`);
      if (claim.reasoning) lines.push(`       ${claim.reasoning}`);
      if (claim.evidence) lines.push(`       Evidence: ${claim.evidence.slice(0, 150)}`);
    }
  }

  return lines.join('\n');
}
