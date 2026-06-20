/**
 * Shared utilities for page sourcing and citation commands.
 */

import type { ExtractedClaim } from '../lib/semantic-diff/types.ts';
import { replaceUntilStable } from '../lib/html-utils.ts';

/**
 * Build a list of cleaned text from paragraphs that contain footnotes.
 * Strips MDX components, footnote markers, and formatting to get clean text
 * that can be compared against extracted claims.
 */
export function extractFootnotedSentences(rawContent: string): string[] {
  const text = rawContent.replace(/^---[\s\S]*?---\n/, '');
  const paragraphs = text.split(/\n\n+/);
  const results: string[] = [];

  for (const para of paragraphs) {
    if (/^\[\^[\w:.-]+\]:/.test(para.trim())) continue;
    if (/^(?:import|export)\s/.test(para.trim())) continue;
    if (/^#{1,6}\s/.test(para.trim())) continue;
    if (!/\[\^[\w:.-]+\]/.test(para)) continue;

    // Strip tags to a fixed point so spliced-together angle brackets can't
    // re-form a tag.
    const tagless = replaceUntilStable(/<[^>]+>/g, para, '');
    const clean = tagless
      .replace(/\[\^[\w:.-]+\]/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\\(\$)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (clean.length > 15) {
      results.push(clean);
    }
  }

  return results;
}

/**
 * Check if a claim appears in text that has footnotes in the original source.
 */
export function claimHasCitation(
  claim: ExtractedClaim,
  footnotedParagraphs: string[],
): boolean {
  const claimLower = claim.text.toLowerCase();
  const searchTerms: string[] = [];

  if (claim.keyValue && claim.keyValue.length > 2) {
    searchTerms.push(claim.keyValue.toLowerCase());
  }

  const numbers = claimLower.match(/\d[\d,.]+/g);
  if (numbers) {
    for (const num of numbers) {
      if (num.length >= 2) searchTerms.push(num);
    }
  }

  const words = claimLower.split(/\s+/).filter(w => w.length > 4);
  if (words.length >= 3) {
    for (let i = 0; i < Math.min(words.length - 2, 3); i++) {
      searchTerms.push(words.slice(i, i + 3).join(' '));
    }
  }

  if (searchTerms.length === 0) return false;

  for (const paragraph of footnotedParagraphs) {
    let matches = 0;
    for (const term of searchTerms) {
      if (paragraph.includes(term)) matches++;
    }
    const singleTermMatch = searchTerms.length === 1 || searchTerms[0] === claim.keyValue?.toLowerCase();
    if (matches >= 2) return true;
    if (matches >= 1 && singleTermMatch) return true;
  }

  return false;
}

/**
 * Loki-inspired checkworthiness filter.
 */
export function isCheckWorthy(claim: ExtractedClaim): boolean {
  if (claim.type === 'definition') return false;
  if (claim.confidence === 'low') return false;
  if (claim.type === 'existence' && !claim.keyValue) return false;
  if (claim.text.length < 20) return false;
  return true;
}
