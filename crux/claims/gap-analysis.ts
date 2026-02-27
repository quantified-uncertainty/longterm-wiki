/**
 * Claims Gap Analysis — lightweight text-based gap detection
 *
 * Compares verified claims (with source evidence) against current page content
 * using simple text search to identify:
 *   1. Missing claims — verified facts not mentioned on the page
 *   2. Contradictions — page text that conflicts with verified claims
 *   3. Coverage stats — how many verified claims are already on the page
 *
 * Unlike synthesize.ts (which uses an LLM for semantic analysis), this module
 * uses fast heuristic text matching so it can run as a pre-step in the improve
 * pipeline without adding API cost.
 *
 * Usage:
 *   import { runGapAnalysis } from './gap-analysis.ts';
 *   const result = await runGapAnalysis('anthropic');
 *
 *   // Standalone CLI:
 *   pnpm crux claims gap-analysis <page-id>
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { getClaimsByEntity, type ClaimRow } from '../lib/wiki-server/claims.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GapAnalysisResult {
  /** Verified claims with sources that are NOT mentioned on the page */
  missingClaims: ClaimWithSource[];
  /** Page text that appears to contradict a verified claim */
  contradictions: Contradiction[];
  /** Summary statistics */
  stats: {
    total: number;
    verified: number;
    onPage: number;
    missing: number;
  };
}

export interface ClaimWithSource {
  id: number;
  claimText: string;
  sourceQuote: string | null;
  sourceUrl: string | null;
  section: string | null;
  asOf: string | null;
  /** Core keywords extracted from the claim for matching */
  keywords: string[];
}

export interface Contradiction {
  claim: ClaimWithSource;
  pageText: string;
}

// ---------------------------------------------------------------------------
// Text matching helpers
// ---------------------------------------------------------------------------

/**
 * Extract "core keywords" from a claim — significant words that should appear
 * on the page if the claim is covered. Filters out stop words and very short
 * tokens. Returns lowercase.
 */
function extractKeywords(text: string): string[] {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
    'too', 'very', 'just', 'because', 'about', 'between', 'its',
    'that', 'this', 'these', 'those', 'which', 'who', 'whom', 'what',
    'when', 'where', 'why', 'how', 'if', 'then', 'also', 'over',
    'their', 'they', 'them', 'there', 'here', 'he', 'she', 'it', 'we',
    'his', 'her', 'our', 'your', 'my',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Extract numbers from text (including decimals and values with units like $7.3B).
 * Numbers are the strongest signal for claim coverage.
 */
function extractNumbers(text: string): string[] {
  const matches = text.match(/\d[\d,.]*\d|\d/g) || [];
  // Normalize: strip commas, keep decimal points
  return matches.map(n => n.replace(/,/g, ''));
}

/**
 * Check if a claim's core content appears on the page.
 *
 * Strategy:
 * 1. If the claim contains numbers, check if those numbers appear on the page
 * 2. Check if a threshold of keywords appear on the page
 * 3. A claim is "on page" if either (a) its key numbers match, OR (b) >60% of
 *    its keywords appear.
 */
function isClaimOnPage(claim: string, pageTextLower: string): boolean {
  const keywords = extractKeywords(claim);
  const numbers = extractNumbers(claim);

  // If the claim has numbers, check number presence (strongest signal)
  if (numbers.length > 0) {
    const numbersFound = numbers.filter(n => pageTextLower.includes(n));
    // If most numbers from the claim appear on the page, it's likely covered
    if (numbersFound.length >= Math.ceil(numbers.length * 0.5)) {
      // Also require at least some keyword overlap to avoid false positives
      // (e.g., the number "2024" appears everywhere)
      const keywordHits = keywords.filter(k => pageTextLower.includes(k));
      if (keywordHits.length >= Math.min(2, keywords.length)) {
        return true;
      }
    }
  }

  // Keyword overlap: claim is covered if >60% of its keywords appear on the page
  if (keywords.length > 0) {
    const keywordHits = keywords.filter(k => pageTextLower.includes(k));
    const ratio = keywordHits.length / keywords.length;
    return ratio > 0.6;
  }

  // Very short claims (< 3 keywords, no numbers): do substring check
  const normalized = claim.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  return pageTextLower.includes(normalized);
}

/**
 * Detect simple contradictions: look for cases where the page mentions a
 * different number in the same context as a verified claim.
 *
 * This is intentionally conservative — only flags when the same keywords
 * appear near a DIFFERENT number.
 */
function findContradictions(
  claim: ClaimWithSource,
  pageLines: string[],
): string | null {
  const claimNumbers = extractNumbers(claim.claimText);
  if (claimNumbers.length === 0) return null;

  const keywords = extractKeywords(claim.claimText);
  if (keywords.length < 2) return null;

  // Find lines that share keywords with the claim but contain different numbers
  for (const line of pageLines) {
    const lineLower = line.toLowerCase();
    const lineKeywords = extractKeywords(lineLower);

    // Check keyword overlap (at least 3 shared keywords)
    const shared = keywords.filter(k => lineKeywords.includes(k));
    if (shared.length < 3) continue;

    // Check if the line has numbers that differ from the claim
    const lineNumbers = extractNumbers(line);
    if (lineNumbers.length === 0) continue;

    const hasMatchingNumber = claimNumbers.some(cn => lineNumbers.includes(cn));
    if (!hasMatchingNumber && lineNumbers.length > 0) {
      // The line shares keywords but has different numbers -> potential contradiction
      return line.trim();
    }
  }

  return null;
}

/**
 * Get the best source URL for a claim.
 */
function getBestSourceUrl(claim: ClaimRow): string | null {
  if (claim.sources && claim.sources.length > 0) {
    const primary = claim.sources.find(s => s.isPrimary);
    const source = primary || claim.sources[0];
    return source.url || null;
  }
  return null;
}

/**
 * Get the best source quote for a claim.
 */
function getBestSourceQuote(claim: ClaimRow): string | null {
  if (claim.sources && claim.sources.length > 0) {
    const primary = claim.sources.find(s => s.isPrimary);
    const source = primary || claim.sources[0];
    return source.sourceQuote || claim.sourceQuote || null;
  }
  return claim.sourceQuote || null;
}

// ---------------------------------------------------------------------------
// Main gap analysis function
// ---------------------------------------------------------------------------

/**
 * Run gap analysis for a page entity.
 *
 * Fetches verified claims with sources from the wiki-server, reads the page
 * content, and identifies missing claims and contradictions using text search.
 *
 * @param pageId - Entity/page ID (e.g., 'anthropic')
 * @returns Gap analysis result or null if server unavailable / no claims
 */
export async function runGapAnalysis(pageId: string): Promise<GapAnalysisResult | null> {
  // Check server
  const available = await isServerAvailable();
  if (!available) return null;

  // Fetch claims with sources
  const result = await getClaimsByEntity(pageId, { includeSources: true });
  if (!result.ok || !result.data?.claims?.length) return null;

  const allClaims = result.data.claims;

  // Filter to verified claims with source evidence
  const verifiedClaims = allClaims.filter(
    c => c.claimVerdict === 'verified' && (getBestSourceQuote(c) != null || getBestSourceUrl(c) != null),
  );

  if (verifiedClaims.length === 0) {
    return {
      missingClaims: [],
      contradictions: [],
      stats: { total: allClaims.length, verified: 0, onPage: 0, missing: 0 },
    };
  }

  // Read page content
  const filePath = findPageFile(pageId);
  if (!filePath) return null;

  const rawContent = readFileSync(filePath, 'utf-8');
  const pageContent = stripFrontmatter(rawContent);
  const pageTextLower = pageContent.toLowerCase();
  const pageLines = pageContent.split('\n').filter(l => l.trim().length > 0);

  // Analyze each verified claim
  const missingClaims: ClaimWithSource[] = [];
  const contradictions: Contradiction[] = [];
  let onPage = 0;

  for (const claim of verifiedClaims) {
    const claimWithSource: ClaimWithSource = {
      id: claim.id,
      claimText: claim.claimText,
      sourceQuote: getBestSourceQuote(claim),
      sourceUrl: getBestSourceUrl(claim),
      section: claim.section,
      asOf: claim.asOf,
      keywords: extractKeywords(claim.claimText),
    };

    if (isClaimOnPage(claim.claimText, pageTextLower)) {
      onPage++;

      // Even if on page, check for contradictions
      const contradictingLine = findContradictions(claimWithSource, pageLines);
      if (contradictingLine) {
        contradictions.push({ claim: claimWithSource, pageText: contradictingLine });
      }
    } else {
      missingClaims.push(claimWithSource);
    }
  }

  return {
    missingClaims,
    contradictions,
    stats: {
      total: allClaims.length,
      verified: verifiedClaims.length,
      onPage,
      missing: missingClaims.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Format gap analysis for the improve prompt
// ---------------------------------------------------------------------------

/**
 * Format gap analysis results into structured directions for the improve prompt.
 *
 * Produces a text block that can be prepended to the LLM's directions, telling
 * it exactly which verified facts to add and which contradictions to fix.
 */
export function formatGapAnalysisForPrompt(gap: GapAnalysisResult): string {
  if (gap.missingClaims.length === 0 && gap.contradictions.length === 0) {
    return '';
  }

  const sections: string[] = [];

  if (gap.missingClaims.length > 0) {
    sections.push('### ADD THESE VERIFIED FACTS (with footnote citations to the source URLs):');
    sections.push('The following facts have been verified against their sources but are NOT currently on the page.');
    sections.push('Add each one in the appropriate section, with a footnote citation to the source URL provided.');
    sections.push('');

    // Cap at 25 to avoid overwhelming the prompt
    const toShow = gap.missingClaims.slice(0, 25);
    for (const claim of toShow) {
      const sourceInfo = claim.sourceUrl ? ` [Source: ${claim.sourceUrl}]` : '';
      sections.push(`- "${claim.claimText}"${sourceInfo}`);
      if (claim.sourceQuote) {
        const quote = claim.sourceQuote.length > 200
          ? claim.sourceQuote.slice(0, 197) + '...'
          : claim.sourceQuote;
        sections.push(`  Source quote: "${quote}"`);
      }
      if (claim.asOf) {
        sections.push(`  As of: ${claim.asOf}`);
      }
    }

    if (gap.missingClaims.length > 25) {
      sections.push(`\n... and ${gap.missingClaims.length - 25} more missing claims (showing top 25)`);
    }
    sections.push('');
  }

  if (gap.contradictions.length > 0) {
    sections.push('### FIX THESE CONTRADICTIONS (page content conflicts with verified claims):');
    sections.push('The following verified claims appear to conflict with what the page currently says.');
    sections.push('Update the page to match the verified claim, citing the source.');
    sections.push('');

    for (const { claim, pageText } of gap.contradictions) {
      const sourceInfo = claim.sourceUrl ? ` [Source: ${claim.sourceUrl}]` : '';
      sections.push(`- Verified claim: "${claim.claimText}"${sourceInfo}`);
      sections.push(`  Page currently says: "${pageText.slice(0, 150)}"`);
      if (claim.sourceQuote) {
        sections.push(`  Source quote: "${claim.sourceQuote.slice(0, 150)}"`);
      }
    }
    sections.push('');
  }

  // Summary
  sections.push(`### Gap Analysis Summary`);
  sections.push(`- ${gap.stats.verified} verified claims total, ${gap.stats.onPage} already on page, ${gap.stats.missing} missing`);
  if (gap.contradictions.length > 0) {
    sections.push(`- ${gap.contradictions.length} potential contradiction(s) detected`);
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors();
  const positional = (args._positional as string[]) || [];

  const pageId = positional[0];
  if (!pageId) {
    console.error('Usage: crux claims gap-analysis <page-id> [--json]');
    process.exit(1);
  }

  const jsonOutput = args['json'] === true;

  const result = await runGapAnalysis(pageId);

  if (!result) {
    console.error(`Could not run gap analysis for "${pageId}" (server unavailable, no claims, or page not found)`);
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Pretty-print
  console.log(`\n${c.bold}Claims Gap Analysis: ${pageId}${c.reset}`);
  console.log(`  Total claims: ${result.stats.total}`);
  console.log(`  Verified (with sources): ${result.stats.verified}`);
  console.log(`  Already on page: ${result.stats.onPage}`);
  console.log(`  Missing from page: ${result.stats.missing}`);
  console.log(`  Contradictions: ${result.contradictions.length}`);
  console.log('');

  if (result.missingClaims.length > 0) {
    console.log(`${c.bold}Missing Verified Claims:${c.reset}`);
    for (const claim of result.missingClaims.slice(0, 30)) {
      const sourceUrl = claim.sourceUrl ? ` ${c.dim}[${claim.sourceUrl}]${c.reset}` : '';
      console.log(`  ${c.yellow}-${c.reset} "${claim.claimText}"${sourceUrl}`);
      if (claim.sourceQuote) {
        console.log(`    ${c.dim}Source: "${claim.sourceQuote.slice(0, 100)}${claim.sourceQuote.length > 100 ? '...' : ''}"${c.reset}`);
      }
    }
    if (result.missingClaims.length > 30) {
      console.log(`  ${c.dim}... and ${result.missingClaims.length - 30} more${c.reset}`);
    }
    console.log('');
  }

  if (result.contradictions.length > 0) {
    console.log(`${c.bold}${c.red}Potential Contradictions:${c.reset}`);
    for (const { claim, pageText } of result.contradictions) {
      console.log(`  ${c.red}Claim:${c.reset} "${claim.claimText}"`);
      console.log(`  ${c.red}Page says:${c.reset} "${pageText.slice(0, 120)}"`);
      console.log('');
    }
  }

  // Actionable summary
  if (result.missingClaims.length > 0 || result.contradictions.length > 0) {
    console.log(`${c.bold}Next steps:${c.reset}`);
    console.log(`  Run: crux content improve ${pageId} --gap-analysis --apply`);
    console.log(`  This will inject the missing verified facts into the page with citations.`);
  } else {
    console.log(`${c.green}All verified claims are covered on the page.${c.reset}`);
  }
}

// Run CLI when invoked directly
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
