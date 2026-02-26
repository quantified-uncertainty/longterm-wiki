/**
 * Claims Synthesize — gap analysis between claims store and page content
 *
 * Compares stored claims for an entity against the current page content
 * to identify:
 *   1. Claims not mentioned on the page (gaps)
 *   2. Page assertions that contradict verified claims (contradictions)
 *   3. Unsupported page assertions that have verified alternatives (corrections)
 *
 * Usage:
 *   pnpm crux claims synthesize <page-id>
 *   pnpm crux claims synthesize <page-id> --json
 *   pnpm crux claims synthesize <page-id> --top=20
 */

import { readFileSync } from 'fs';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { getClaimsByEntity, type ClaimRow } from '../lib/wiki-server/claims.ts';
import { callOpenRouter, stripCodeFences, parseJsonWithRepair, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GapAnalysis {
  /** Claims in the store that are NOT adequately covered on the page */
  gaps: Array<{
    claimId: number;
    claimText: string;
    verdict: string | null;
    importance: 'high' | 'medium' | 'low';
    reason: string;
  }>;
  /** Page assertions that may conflict with verified claims */
  contradictions: Array<{
    claimId: number;
    claimText: string;
    pageExcerpt: string;
    explanation: string;
  }>;
  /** Suggestions for improving the page using stored claims */
  suggestions: string[];
  /** Summary statistics */
  stats: {
    totalClaims: number;
    coveredOnPage: number;
    gaps: number;
    contradictions: number;
  };
}

// ---------------------------------------------------------------------------
// LLM-based gap analysis
// ---------------------------------------------------------------------------

const GAP_ANALYSIS_SYSTEM = `You are analyzing a wiki page against a set of verified claims from a structured knowledge store.

Your task: identify (1) gaps — verified claims NOT adequately covered on the page, and (2) contradictions — page content that conflicts with verified claims.

Return JSON with this structure:
{
  "gaps": [
    { "claimId": <number>, "importance": "high" | "medium" | "low", "reason": "Brief explanation" }
  ],
  "contradictions": [
    { "claimId": <number>, "pageExcerpt": "Text from the page that conflicts", "explanation": "What the conflict is" }
  ],
  "suggestions": [ "Specific suggestion for improving the page" ]
}

Guidelines:
- A claim is "covered" if its core information appears on the page, even if worded differently
- Only flag gaps for claims that are clearly relevant and would add value to the page
- High importance: key facts a reader would expect (founding date, team size, major achievements)
- Medium importance: supporting details that enrich the page
- Low importance: minor facts that are nice-to-have
- Only flag contradictions when the page clearly states something different from a verified claim
- Focus on the top 20 most important gaps, not an exhaustive list`;

async function runGapAnalysis(
  claims: ClaimRow[],
  pageContent: string,
  model: string,
): Promise<{ gaps: Array<{ claimId: number; importance: string; reason: string }>; contradictions: Array<{ claimId: number; pageExcerpt: string; explanation: string }>; suggestions: string[] }> {
  // Format claims compactly
  const claimsText = claims.map((c) => {
    const meta: string[] = [];
    if (c.claimVerdict) meta.push(c.claimVerdict);
    if (c.claimType) meta.push(c.claimType);
    if (c.asOf) meta.push(`as_of:${c.asOf}`);
    const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
    return `[ID:${c.id}] "${c.claimText}"${metaStr}`;
  }).join('\n');

  // Truncate page content if too long
  const truncatedContent = pageContent.length > 12000
    ? pageContent.slice(0, 12000) + '\n\n[... page truncated ...]'
    : pageContent;

  const userPrompt = `## Claims Store\n${claimsText}\n\n## Current Page Content\n${truncatedContent}`;

  const raw = await callOpenRouter(GAP_ANALYSIS_SYSTEM, userPrompt, { model, maxTokens: 4000 });
  const cleaned = stripCodeFences(raw);
  const parsed = parseJsonWithRepair(cleaned);

  return {
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
    contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors();
  const positional = (args._positional as string[]) || [];

  const pageId = positional[0];
  if (!pageId) {
    console.error('Usage: crux claims synthesize <page-id> [--json] [--top=N] [--model=M]');
    process.exit(1);
  }

  const jsonOutput = args['json'] === true;
  const topN = typeof args['top'] === 'string' ? parseInt(args['top'], 10) : 20;
  const model = typeof args['model'] === 'string' ? args['model'] : DEFAULT_CITATION_MODEL;

  // Check server
  const available = await isServerAvailable();
  if (!available) {
    console.error('Wiki server is not available. Cannot fetch claims.');
    process.exit(1);
  }

  // Fetch claims
  const result = await getClaimsByEntity(pageId, { includeSources: true });
  if (!result.ok) {
    console.error(`Failed to fetch claims for ${pageId}: ${result.message}`);
    process.exit(1);
  }

  const claims = result.data.claims;
  if (claims.length === 0) {
    console.error(`No claims found for entity "${pageId}". Run: crux claims extract ${pageId}`);
    process.exit(1);
  }

  // Read page content
  const filePath = findPageFile(pageId);
  if (!filePath) {
    console.error(`Page file not found for "${pageId}"`);
    process.exit(1);
  }

  const rawContent = readFileSync(filePath, 'utf-8');
  const pageContent = stripFrontmatter(rawContent);

  // Prioritize verified/sourced claims for the analysis
  const priorityClaims = claims
    .filter(c => c.claimVerdict === 'verified' || c.sourceQuote || (c.sources && c.sources.length > 0))
    .slice(0, topN * 3); // Send 3x to LLM, then trim output to topN

  // Fall back to all claims if no verified ones
  const analysisInput = priorityClaims.length > 10 ? priorityClaims : claims.slice(0, topN * 3);

  if (!jsonOutput) {
    console.log(`\n${c.bold}Claims Synthesis: ${pageId}${c.reset}`);
    console.log(`  ${claims.length} total claims, ${priorityClaims.length} verified/sourced`);
    console.log(`  Analyzing against page content (${pageContent.length} chars)...`);
    console.log('');
  }

  // Run LLM gap analysis
  const llmResult = await runGapAnalysis(analysisInput, pageContent, model);

  // Build the claim lookup for resolving IDs
  const claimById = new Map(claims.map(c => [c.id, c]));

  // Assemble full gap analysis
  const analysis: GapAnalysis = {
    gaps: llmResult.gaps.slice(0, topN).map(g => {
      const claim = claimById.get(g.claimId);
      return {
        claimId: g.claimId,
        claimText: claim?.claimText ?? `[Claim #${g.claimId}]`,
        verdict: claim?.claimVerdict ?? null,
        importance: (g.importance as 'high' | 'medium' | 'low') || 'medium',
        reason: g.reason,
      };
    }),
    contradictions: llmResult.contradictions.map(c => {
      const claim = claimById.get(c.claimId);
      return {
        claimId: c.claimId,
        claimText: claim?.claimText ?? `[Claim #${c.claimId}]`,
        pageExcerpt: c.pageExcerpt,
        explanation: c.explanation,
      };
    }),
    suggestions: llmResult.suggestions,
    stats: {
      totalClaims: claims.length,
      coveredOnPage: claims.length - llmResult.gaps.length,
      gaps: llmResult.gaps.length,
      contradictions: llmResult.contradictions.length,
    },
  };

  if (jsonOutput) {
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }

  // Pretty-print
  console.log(`${c.bold}=== Gap Analysis ===${c.reset}`);
  console.log(`  Total claims: ${analysis.stats.totalClaims}`);
  console.log(`  Covered on page: ~${analysis.stats.coveredOnPage}`);
  console.log(`  Gaps found: ${analysis.stats.gaps}`);
  console.log(`  Contradictions: ${analysis.stats.contradictions}`);
  console.log('');

  if (analysis.gaps.length > 0) {
    console.log(`${c.bold}Gaps (claims not on the page):${c.reset}`);
    for (const gap of analysis.gaps) {
      const importanceColor = gap.importance === 'high' ? c.red : gap.importance === 'medium' ? c.yellow : c.dim;
      const verdictStr = gap.verdict ? ` [${gap.verdict}]` : '';
      console.log(`  ${importanceColor}[${gap.importance.toUpperCase()}]${c.reset} "${gap.claimText}"${verdictStr}`);
      console.log(`    ${c.dim}→ ${gap.reason}${c.reset}`);
    }
    console.log('');
  }

  if (analysis.contradictions.length > 0) {
    console.log(`${c.bold}${c.red}Contradictions:${c.reset}`);
    for (const contra of analysis.contradictions) {
      console.log(`  Claim: "${contra.claimText}"`);
      console.log(`  Page says: "${contra.pageExcerpt}"`);
      console.log(`  ${c.dim}→ ${contra.explanation}${c.reset}`);
      console.log('');
    }
  }

  if (analysis.suggestions.length > 0) {
    console.log(`${c.bold}Suggestions:${c.reset}`);
    for (const suggestion of analysis.suggestions) {
      console.log(`  • ${suggestion}`);
    }
    console.log('');
  }

  // Summary
  const highGaps = analysis.gaps.filter(g => g.importance === 'high').length;
  if (highGaps > 0) {
    console.log(`${c.yellow}⚠ ${highGaps} high-importance claims are missing from the page.${c.reset}`);
    console.log(`  Run: crux content improve ${pageId} --directions="Incorporate missing claims from claims store"`);
  }
  if (analysis.contradictions.length > 0) {
    console.log(`${c.red}⚠ ${analysis.contradictions.length} contradiction(s) detected — manual review recommended.${c.reset}`);
  }
}

main().catch(err => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
