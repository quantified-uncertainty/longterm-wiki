/**
 * Wiki Page Claim Extractor
 *
 * Extracts verifiable claims from wiki page MDX content, categorizes them
 * by sourcing type, and cross-references against FactBase data.
 *
 * This module is purely extractive — it identifies claims and categorizes them
 * but does not perform sourcing (that's a downstream consumer's job).
 *
 * Reuses the semantic-diff claim extractor for LLM-based claim extraction.
 */

import { extractClaims } from '../semantic-diff/claim-extractor.ts';
import type { ExtractedClaim } from '../semantic-diff/types.ts';
import type { WikiPageVerifyItem, WikiPageVerifyCategory } from './types.ts';

// ---------------------------------------------------------------------------
// Footnote parsing
// ---------------------------------------------------------------------------

/** A parsed footnote from MDX content */
export interface ParsedFootnote {
  url?: string;
  text: string;
}

/**
 * Parse footnote definitions from MDX content.
 *
 * Handles standard markdown footnote syntax:
 *   [^1]: https://example.com
 *   [^2]: Some text with https://example.com/page embedded
 *   [^3]: Plain text footnote without URL
 *
 * @returns Map from footnote number to its parsed content
 */
export function parseFootnotes(mdxContent: string): Map<number, ParsedFootnote> {
  const footnotes = new Map<number, ParsedFootnote>();

  // Match footnote definitions: [^N]: <content>
  // Content may span multiple lines if indented, but we capture the first line
  const footnoteDefRegex = /^\[\^(\d+)\]:\s*(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = footnoteDefRegex.exec(mdxContent)) !== null) {
    const num = parseInt(match[1], 10);
    const text = match[2].trim();

    // Extract the first URL from the footnote text
    const urlMatch = text.match(/https?:\/\/[^\s)>\]"]+/);
    const url = urlMatch ? urlMatch[0] : undefined;

    footnotes.set(num, { url, text });
  }

  return footnotes;
}

// ---------------------------------------------------------------------------
// Claim-to-footnote matching
// ---------------------------------------------------------------------------

/**
 * Find footnote references in the original (non-preprocessed) MDX content
 * and build a map from text positions to footnote numbers.
 */
function buildFootnoteReferenceMap(mdxContent: string): Array<{ position: number; footnoteNumber: number }> {
  const refs: Array<{ position: number; footnoteNumber: number }> = [];
  const refRegex = /\[\^(\d+)\]/g;

  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(mdxContent)) !== null) {
    // Check if this is a footnote definition (starts with [^N]:)
    const lineStart = mdxContent.lastIndexOf('\n', match.index) + 1;
    const lineText = mdxContent.slice(lineStart, match.index + match[0].length + 10);
    if (/^\[\^\d+\]:/.test(lineText.trimStart())) {
      continue; // Skip footnote definitions
    }

    refs.push({
      position: match.index,
      footnoteNumber: parseInt(match[1], 10),
    });
  }

  return refs;
}

/**
 * Match a claim to its nearest footnote reference in the original MDX content.
 *
 * Strategy: Find where the claim's sourceContext appears in the MDX, then
 * find the nearest footnote reference within a reasonable distance (same
 * paragraph or within ~200 characters).
 *
 * @returns The matched footnote info, or null if no footnote is nearby
 */
export function matchClaimToFootnote(
  claim: ExtractedClaim,
  mdxContent: string,
  footnotes: Map<number, ParsedFootnote>,
): { footnoteNumber: number; url?: string } | null {
  if (footnotes.size === 0) return null;

  const footnoteRefs = buildFootnoteReferenceMap(mdxContent);
  if (footnoteRefs.length === 0) return null;

  // Find where the claim's source context appears in the MDX
  // We search for a significant substring since preprocessing may have altered it
  const searchText = findBestSearchText(claim);
  if (!searchText) return null;

  const claimPosition = mdxContent.indexOf(searchText);
  if (claimPosition === -1) return null;

  // Find the nearest footnote reference within a reasonable window
  // A footnote typically appears at the end of the sentence or paragraph
  // containing the claim
  const MAX_DISTANCE = 300; // characters
  let bestRef: { footnoteNumber: number; distance: number } | null = null;

  for (const ref of footnoteRefs) {
    // Only consider footnotes that come after the claim text (or very close before)
    const distance = ref.position - claimPosition;

    // Footnote should be after the claim text (within MAX_DISTANCE)
    // or very close before it (within 50 chars, for cases where the
    // footnote is at the start of the sentence)
    if (distance > -50 && distance < MAX_DISTANCE) {
      const absDist = Math.abs(distance);
      if (!bestRef || absDist < bestRef.distance) {
        bestRef = { footnoteNumber: ref.footnoteNumber, distance: absDist };
      }
    }
  }

  if (!bestRef) return null;

  const footnote = footnotes.get(bestRef.footnoteNumber);
  return {
    footnoteNumber: bestRef.footnoteNumber,
    url: footnote?.url,
  };
}

/**
 * Extract a distinctive substring from a claim for text search.
 * Uses the sourceContext first, falling back to claim text.
 * Returns a substring long enough to be unique but not so long it won't match.
 */
function findBestSearchText(claim: ExtractedClaim): string | null {
  // Try sourceContext first (it's the original text)
  const context = claim.sourceContext || claim.text;
  if (!context || context.length < 10) return null;

  // Use up to 80 chars — enough to be distinctive, short enough to match
  // even if the MDX has some formatting differences
  const candidate = context.slice(0, 80);

  // Strip any markdown/formatting artifacts that preprocessing might have added
  return candidate.replace(/\*\*/g, '').replace(/\*/g, '').trim();
}

// ---------------------------------------------------------------------------
// Stale temporal detection
// ---------------------------------------------------------------------------

/**
 * Detect whether a claim references a date or year that may be outdated.
 *
 * Looks for patterns like:
 * - "as of 2024" when current year is 2026
 * - "in 2023" for temporal claims about ongoing metrics
 * - Specific date references more than 1 year old
 *
 * @returns true if the claim appears to reference stale temporal data
 */
export function detectStaleTemporal(claim: ExtractedClaim, currentYear: number): boolean {
  const text = claim.text + ' ' + claim.sourceContext;

  // "as of YYYY" — stale if more than 1 year old
  const asOfMatch = text.match(/as\s+of\s+(\d{4})/i);
  if (asOfMatch) {
    const year = parseInt(asOfMatch[1], 10);
    if (year < currentYear - 1) return true;
  }

  // "since YYYY" with a claim about current state — check if it's a very old reference
  // that might need updating (e.g., "since 2018" on a 2026 page)
  const sinceMatch = text.match(/since\s+(\d{4})/i);
  if (sinceMatch) {
    const year = parseInt(sinceMatch[1], 10);
    // "since" claims about things 5+ years ago may need freshness review
    if (year < currentYear - 5) return true;
  }

  // For temporal claims specifically, check if the keyValue is an old year
  if (claim.type === 'temporal' && claim.keyValue) {
    const yearMatch = claim.keyValue.match(/^(\d{4})$/);
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10);
      // Temporal claims about years 2+ years old may reference stale info
      // (but founding dates etc. are fine — those don't become stale)
      // Only flag if the claim text suggests it's about a current/ongoing metric
      const ongoingIndicators = /employ|revenue|funding|headcount|staff|budget|valuation|raised|currently|now|latest|recent/i;
      if (year < currentYear - 1 && ongoingIndicators.test(text)) {
        return true;
      }
    }
  }

  // Check for specific date patterns (YYYY-MM-DD or Month YYYY) in numeric claims
  // about values that change over time
  if (claim.type === 'numeric') {
    const dateInText = text.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
    if (dateInText) {
      const year = parseInt(dateInText[1], 10);
      if (year < currentYear - 1) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// FactBase cross-referencing
// ---------------------------------------------------------------------------

/** A FactBase fact for cross-referencing */
export interface FactBaseFact {
  id: string;
  property: string;
  value: string;
}

/**
 * Parse a numeric value from a string, handling common formats:
 * - "1.5 billion" -> 1500000000
 * - "$500 million" -> 500000000
 * - "1,500" -> 1500
 * - "42%" -> 42
 * - "1500000000" -> 1500000000
 */
export function parseNumericValue(text: string): number | null {
  if (!text || typeof text !== 'string') return null;

  // Remove currency symbols and whitespace
  let cleaned = text.replace(/[$\u20AC\u00A3\u00A5,]/g, '').trim();

  // Handle "X billion/million/thousand" patterns
  const multiplierMatch = cleaned.match(/^([\d.]+)\s*(billion|million|thousand|trillion)/i);
  if (multiplierMatch) {
    const base = parseFloat(multiplierMatch[1]);
    if (isNaN(base)) return null;
    const multipliers: Record<string, number> = {
      thousand: 1_000,
      million: 1_000_000,
      billion: 1_000_000_000,
      trillion: 1_000_000_000_000,
    };
    return base * multipliers[multiplierMatch[2].toLowerCase()];
  }

  // Handle percentage
  cleaned = cleaned.replace(/%$/, '');

  // Handle plain numbers
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Check if two numeric values are approximately equal (within tolerance).
 * @param tolerance - Fractional tolerance (e.g., 0.05 for 5%)
 */
function numericApproxEqual(a: number, b: number, tolerance = 0.05): boolean {
  if (a === 0 && b === 0) return true;
  if (a === 0 || b === 0) return false;
  const ratio = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
  return ratio <= tolerance;
}

/**
 * Extract year values from text.
 */
function extractYears(text: string): number[] {
  const matches = text.match(/\b(19|20)\d{2}\b/g);
  return matches ? matches.map(Number) : [];
}

/**
 * Cross-reference a claim against FactBase facts.
 *
 * Returns matching facts where the claim appears to reference the same
 * value (number within 5%, matching year, or matching name).
 */
function crossReferenceClaim(
  claim: ExtractedClaim,
  facts: FactBaseFact[],
): { factId: string; factValue: string } | null {
  if (facts.length === 0) return null;

  const claimText = (claim.text + ' ' + (claim.keyValue ?? '')).toLowerCase();

  for (const fact of facts) {
    const factPropertyLower = fact.property.toLowerCase();

    // Check numeric cross-reference
    const claimNum = parseNumericValue(claim.keyValue ?? claim.text);
    const factNum = parseNumericValue(fact.value);

    if (claimNum !== null && factNum !== null) {
      // If both are numeric, check if they reference similar things
      // by looking for property name overlap in the claim text
      const propertyWords = factPropertyLower.split(/[_\s-]+/).filter(w => w.length > 2);
      const hasPropertyOverlap = propertyWords.some(word => claimText.includes(word));

      if (hasPropertyOverlap && !numericApproxEqual(claimNum, factNum)) {
        // Claim mentions similar property but with a different value — flag it
        return { factId: fact.id, factValue: fact.value };
      }
    }

    // Check year cross-reference
    const claimYears = extractYears(claim.text);
    const factYears = extractYears(fact.value);

    if (claimYears.length > 0 && factYears.length > 0) {
      const propertyWords = factPropertyLower.split(/[_\s-]+/).filter(w => w.length > 2);
      const hasPropertyOverlap = propertyWords.some(word => claimText.includes(word));

      if (hasPropertyOverlap) {
        // Check if years differ
        for (const cy of claimYears) {
          for (const fy of factYears) {
            if (cy !== fy) {
              return { factId: fact.id, factValue: fact.value };
            }
          }
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Priority scoring
// ---------------------------------------------------------------------------

const PRIORITY_BASE: Record<WikiPageVerifyCategory, number> = {
  'sourced-claim': 50,
  'unfootnoted-claim': 80,
  'cross-ref-claim': 70,
  'stale-temporal-claim': 60,
};

/**
 * Calculate priority score for a sourcing item.
 */
function calculatePriority(category: WikiPageVerifyCategory, claim: ExtractedClaim): number {
  let priority = PRIORITY_BASE[category];

  // Bonus for numeric claims in sourced-claim category (most verifiable)
  if (category === 'sourced-claim' && (claim.type === 'numeric' || claim.keyValue)) {
    priority += 20;
  }

  // High-confidence claims are more worth verifying
  if (claim.confidence === 'high') {
    priority += 5;
  }

  return priority;
}

// ---------------------------------------------------------------------------
// Main extraction pipeline
// ---------------------------------------------------------------------------

/**
 * Extract and categorize verifiable claims from a wiki page's MDX content.
 *
 * This is the main entry point. It:
 * 1. Extracts claims from the MDX using the semantic-diff claim extractor (LLM)
 * 2. Parses footnotes from the MDX
 * 3. Matches claims to footnotes
 * 4. Cross-references claims against FactBase data
 * 5. Detects stale temporal references
 * 6. Categorizes and prioritizes each claim
 *
 * @param pageSlug - Slug/identifier for the wiki page
 * @param mdxContent - Raw MDX content of the page
 * @param factbaseFacts - Optional FactBase facts for cross-referencing
 * @param currentYear - Current year for stale temporal detection (defaults to actual current year)
 * @returns Array of categorized sourcing items, sorted by priority (highest first)
 */
export async function extractWikiPageClaims(
  pageSlug: string,
  mdxContent: string,
  factbaseFacts?: FactBaseFact[],
  currentYear?: number,
): Promise<WikiPageVerifyItem[]> {
  const year = currentYear ?? new Date().getFullYear();
  const facts = factbaseFacts ?? [];

  // Step 1: Extract claims via LLM
  const claims = await extractClaims(mdxContent);
  if (claims.length === 0) return [];

  // Step 2: Parse footnotes from original MDX
  const footnotes = parseFootnotes(mdxContent);

  // Step 3: Categorize each claim
  const items: WikiPageVerifyItem[] = [];

  for (const claim of claims) {
    // Check footnote match first (determines sourced vs unfootnoted)
    const footnoteMatch = matchClaimToFootnote(claim, mdxContent, footnotes);

    // Check cross-reference against FactBase
    const crossRef = crossReferenceClaim(claim, facts);

    // Check stale temporal
    const isStale = detectStaleTemporal(claim, year);

    // A claim can generate multiple sourcing items if it falls
    // into multiple categories. However, we pick the highest-priority
    // single category to avoid duplication noise.

    if (crossRef) {
      // Cross-reference mismatch is highest signal
      items.push({
        pageSlug,
        claimText: claim.text,
        claimType: claim.type,
        category: 'cross-ref-claim',
        factId: crossRef.factId,
        factValue: crossRef.factValue,
        sourceContext: claim.sourceContext,
        priority: calculatePriority('cross-ref-claim', claim),
      });
    } else if (isStale) {
      items.push({
        pageSlug,
        claimText: claim.text,
        claimType: claim.type,
        category: 'stale-temporal-claim',
        sourceContext: claim.sourceContext,
        priority: calculatePriority('stale-temporal-claim', claim),
      });
    } else if (footnoteMatch?.url) {
      // Has a footnote with a URL — sourced claim
      items.push({
        pageSlug,
        claimText: claim.text,
        claimType: claim.type,
        category: 'sourced-claim',
        sourceUrl: footnoteMatch.url,
        footnoteNumber: footnoteMatch.footnoteNumber,
        sourceContext: claim.sourceContext,
        priority: calculatePriority('sourced-claim', claim),
      });
    } else {
      // No footnote or footnote without URL — unfootnoted claim
      items.push({
        pageSlug,
        claimText: claim.text,
        claimType: claim.type,
        category: 'unfootnoted-claim',
        footnoteNumber: footnoteMatch?.footnoteNumber,
        sourceContext: claim.sourceContext,
        priority: calculatePriority('unfootnoted-claim', claim),
      });
    }
  }

  // Sort by priority (highest first)
  items.sort((a, b) => b.priority - a.priority);

  return items;
}
