/**
 * Page Source-Check Command
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

import fs from 'fs';
import path from 'path';
import type { CommandResult } from '../lib/command-types.ts';
import { findPageById } from '../lib/page-resolution.ts';
import { replaceUntilStable } from '../lib/html-utils.ts';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { parseFrontmatter } from '../lib/mdx-utils.ts';
import {
  extractClaims,
} from '../lib/semantic-diff/claim-extractor.ts';
import type { ExtractedClaim } from '../lib/semantic-diff/types.ts';
import { createLlmClient, runLlmAgent, MODELS } from '../lib/llm.ts';
import { parseJsonFromLlm } from '../lib/json-parsing.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import { withPipelineRun } from '../lib/pipeline-runs/lifecycle.ts';
import { extractFootnotedSentences, claimHasCitation, isCheckWorthy } from './verify-page-utils.ts';

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

interface PageSourcingReport {
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

// ── Web sourcing ─────────────────────────────────────────────────

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
      reasoning: `Error during sourcing: ${e instanceof Error ? e.message : String(e)}`,
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
  const limit = Number(options.limit) || 0; // 0 = no limit
  const startTime = Date.now();

  // Load page
  const page = findPageById(pageId);
  if (!page) {
    return { exitCode: 1, output: `Page not found: ${pageId}` };
  }

  console.log(`\n  Verifying: ${page.title} (${page.slug})`);
  console.log(`  Mode: ${mode}\n`);

  const costTracker = new CostTracker();

  return withPipelineRun(
    {
      pipelineName: 'verify-page',
      entityId: page.slug,
      shape: mode,
      allowOffline: true,
      tracker: costTracker,
    },
    async () => {
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

      // Step 2: Classify cited vs uncited by checking if claim content appears in footnoted text
      console.log('  [2/4] Classifying cited vs uncited...');
      const footnoteMap = buildFootnoteMap(page.content);
      const footnotedParagraphs = extractFootnotedSentences(page.content);

      const classifiedClaims: ClaimWithCitation[] = claims.map(claim => ({
        ...claim,
        hasCitation: claimHasCitation(claim, footnotedParagraphs),
        checkWorthy: isCheckWorthy(claim),
      }));

      const cited = classifiedClaims.filter(c => c.hasCitation);
      const uncited = classifiedClaims.filter(c => !c.hasCitation);
      const checkWorthy = uncited.filter(c => c.checkWorthy);

      console.log(`         ${cited.length} cited, ${uncited.length} uncited (${checkWorthy.length} check-worthy)`);
      console.log(`         ${footnoteMap.totalFootnotes} footnotes in page`);

      if (mode === 'quick') {
        // Quick mode: just report the breakdown
        const report: PageSourcingReport = {
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

        const underLimit = limit === 0 || verifiedCount < limit;
        if (shouldVerify && costTracker.totalCost < budget && !budgetExhausted && underLimit) {
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

      const report: PageSourcingReport = {
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
    },
  );
}

// ── Report formatting ────────────────────────────────────────────────

function formatReport(report: PageSourcingReport): string {
  const lines: string[] = [];

  lines.push(`\n  Page Source-Check Report: ${report.title}`);
  lines.push(`  ${'─'.repeat(50)}`);
  lines.push(`  Total claims extracted:  ${report.totalClaims}`);
  lines.push(`  Cited (have footnote):   ${report.citedClaims}`);
  lines.push(`  Uncited:                 ${report.uncitedClaims}`);
  lines.push(`  Check-worthy uncited:    ${report.checkWorthyClaims}`);

  if (report.verified > 0) {
    lines.push('');
    lines.push(`  Web sourcing results (${report.verified} claims):`);
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

// ── Batch audit (no LLM) ────────────────────────────────────────────

interface PageCitationStats {
  slug: string;
  title: string;
  wordCount: number;
  footnoteCount: number;
  proseWordsPerFootnote: number;
  estimatedCitationDensity: 'good' | 'fair' | 'poor' | 'none';
  subcategory: string;
}

/**
 * Fast citation density audit across all pages. No LLM calls — just counts
 * footnotes and prose words to estimate how well-cited each page is.
 */
export async function auditAllPagesCommand(
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const limitN = Number(options.limit) || 50;
  const sortBy = (options.sort as string) || 'density';
  const minWords = Number(options.minWords) || 200;

  const files = findMdxFiles(CONTENT_DIR_ABS);
  const stats: PageCitationStats[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(content);
    const slug = path.basename(file, path.extname(file));
    const title = (fm.title as string) || slug;
    const subcategory = (fm.subcategory as string) || '';

    // Skip internal/dashboard/meta pages
    if (subcategory === 'dashboards' || subcategory === 'citations') continue;
    if ((fm.contentFormat as string) === 'dashboard') continue;
    const relPath = path.relative(CONTENT_DIR_ABS, file);
    if (relPath.startsWith('internal/') || relPath.startsWith('docs/internal/')) continue;
    if (relPath.startsWith('meta/') || relPath.startsWith('docs/meta/')) continue;
    // Skip pages explicitly marked as internal content
    if (subcategory === 'internal' || subcategory === 'style-guides' || subcategory === 'meta') continue;

    // Strip frontmatter
    const body = content.replace(/^---[\s\S]*?---\n/, '');

    // Strip imports, components, footnote definitions. Remove tags/component
    // blocks to a fixed point so nested or spliced-together markup can't survive
    // a single pass.
    let stripped = body.replace(/^(?:import|export)\s.*$/gm, '');
    stripped = replaceUntilStable(/<\w+[^>]*>[\s\S]*?<\/\w+>/g, stripped, ''); // component blocks
    stripped = replaceUntilStable(/<[^>]+\/>/g, stripped, '');                 // self-closing tags
    stripped = replaceUntilStable(/<[^>]+>/g, stripped, '');                   // stray tags
    const prose = stripped
      .replace(/^\[\^[\w:.-]+\]:.*$/gm, '') // footnote defs
      .replace(/^#{1,6}\s.*$/gm, '')        // headings
      .replace(/\s+/g, ' ')
      .trim();

    const wordCount = prose.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount < minWords) continue;

    // Count footnote references (strip definitions first to avoid double-counting)
    const bodyWithoutDefs = body.replace(/^\[\^[\w:.-]+\]:.*$/gm, '');
    const footnoteRefs = (bodyWithoutDefs.match(/\[\^[\w:.-]+\]/g) || []);
    const footnoteCount = footnoteRefs.length;

    const proseWordsPerFootnote = footnoteCount > 0
      ? Math.round(wordCount / footnoteCount)
      : Infinity;

    let estimatedCitationDensity: PageCitationStats['estimatedCitationDensity'];
    if (footnoteCount === 0) {
      estimatedCitationDensity = 'none';
    } else if (proseWordsPerFootnote <= 50) {
      estimatedCitationDensity = 'good';  // roughly 1 footnote per 2-3 sentences
    } else if (proseWordsPerFootnote <= 120) {
      estimatedCitationDensity = 'fair';
    } else {
      estimatedCitationDensity = 'poor';
    }

    stats.push({
      slug,
      title: title.slice(0, 40),
      wordCount,
      footnoteCount,
      proseWordsPerFootnote,
      estimatedCitationDensity,
      subcategory,
    });
  }

  // Sort
  if (sortBy === 'density') {
    // Sort by density descending, with zero-footnote pages sorted by word count
    stats.sort((a, b) => {
      if (a.footnoteCount === 0 && b.footnoteCount === 0) return b.wordCount - a.wordCount;
      if (a.footnoteCount === 0) return -1;
      if (b.footnoteCount === 0) return 1;
      return b.proseWordsPerFootnote - a.proseWordsPerFootnote;
    });
  } else if (sortBy === 'words') {
    stats.sort((a, b) => b.wordCount - a.wordCount);
  } else if (sortBy === 'footnotes') {
    stats.sort((a, b) => a.footnoteCount - b.footnoteCount);
  }

  // Summary stats
  const total = stats.length;
  const noneCount = stats.filter(s => s.estimatedCitationDensity === 'none').length;
  const poorCount = stats.filter(s => s.estimatedCitationDensity === 'poor').length;
  const fairCount = stats.filter(s => s.estimatedCitationDensity === 'fair').length;
  const goodCount = stats.filter(s => s.estimatedCitationDensity === 'good').length;

  const lines: string[] = [];
  lines.push(`\n  Wiki Citation Density Audit`);
  lines.push(`  ${'─'.repeat(60)}`);
  lines.push(`  Pages analyzed: ${total} (min ${minWords} words)`);
  lines.push(`  Citation density:  good: ${goodCount}  fair: ${fairCount}  poor: ${poorCount}  none: ${noneCount}`);
  lines.push('');

  // Show worst pages
  const shown = stats.slice(0, limitN);
  lines.push(`  Worst ${shown.length} pages by citation density:`);
  lines.push('');
  lines.push(`  ${'Page'.padEnd(42)} ${'Words'.padStart(6)} ${'FN'.padStart(4)} ${'W/FN'.padStart(6)} Rating`);
  lines.push(`  ${'─'.repeat(42)} ${'─'.repeat(6)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(6)}`);

  for (const s of shown) {
    const wPerFn = s.footnoteCount === 0 ? '  n/a' : String(s.proseWordsPerFootnote).padStart(6);
    const rating = s.estimatedCitationDensity === 'none' ? 'NONE' :
      s.estimatedCitationDensity === 'poor' ? 'POOR' :
      s.estimatedCitationDensity === 'fair' ? 'fair' : 'good';
    lines.push(`  ${s.title.padEnd(42)} ${String(s.wordCount).padStart(6)} ${String(s.footnoteCount).padStart(4)} ${wPerFn} ${rating}`);
  }

  if (stats.length > limitN) {
    lines.push(`  ... and ${stats.length - limitN} more pages`);
  }

  return { exitCode: 0, output: lines.join('\n') };
}
