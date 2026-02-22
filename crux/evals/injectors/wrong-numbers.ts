/**
 * Wrong Numbers Injector
 *
 * Finds numeric facts in wiki content (dates, dollar amounts, headcounts,
 * percentages) and corrupts them by a plausible amount. The corruption is
 * designed to be subtle enough to fool surface-level reading but detectable
 * by a system that cross-references against citations.
 */

import type { InjectedError } from '../types.ts';
import { stripFrontmatter } from '../../lib/patterns.ts';

/** Patterns that match numeric claims in wiki prose. */
const NUMBER_PATTERNS: { regex: RegExp; label: string }[] = [
  // Years: "founded in 2015", "established 2019", "since 2020"
  { regex: /\b((?:founded|established|created|launched|started|formed|incorporated)\s+(?:in\s+)?)((?:19|20)\d{2})\b/gi, label: 'founding-year' },
  // Dollar amounts: "$100 million", "$2.5 billion", "$500,000"
  { regex: /(\$)([\d,.]+)\s*(million|billion|thousand|[MBK])\b/gi, label: 'dollar-amount' },
  // Plain dollar amounts: "$100", "$2,500"
  { regex: /(\$)([\d,]+)(?!\s*(?:million|billion|thousand|[MBK]))/gi, label: 'dollar-plain' },
  // Employee/staff counts: "50 employees", "200 researchers", "~150 staff"
  { regex: /(~?\s*)([\d,]+)\s*(employees?|researchers?|staff|people|members?|engineers?|scientists?)\b/gi, label: 'headcount' },
  // Percentages: "25%", "increased by 50%"
  { regex: /([\d.]+)(%)/g, label: 'percentage' },
  // Year references: "in 2023", "by 2025", "since 2019"
  { regex: /\b(in|by|since|from|during|around)\s+((?:19|20)\d{2})\b/gi, label: 'year-reference' },
];

/** Corrupt a number by a plausible amount. */
function corruptNumber(value: string, label: string): string {
  const num = parseFloat(value.replace(/,/g, ''));
  if (isNaN(num)) return value;

  // Different corruption strategies based on the type
  switch (label) {
    case 'founding-year':
    case 'year-reference': {
      // Shift by 1-3 years (subtle but verifiable)
      const shift = Math.random() < 0.5 ? -Math.ceil(Math.random() * 3) : Math.ceil(Math.random() * 3);
      return String(num + shift);
    }
    case 'dollar-amount':
    case 'dollar-plain': {
      // Multiply or divide by 1.5-3x
      const factor = 1.5 + Math.random() * 1.5;
      const corrupted = Math.random() < 0.5 ? num * factor : num / factor;
      // Preserve comma formatting if original had it
      if (value.includes(',')) {
        return Math.round(corrupted).toLocaleString('en-US');
      }
      return value.includes('.') ? corrupted.toFixed(1) : String(Math.round(corrupted));
    }
    case 'headcount': {
      // Change by 2-5x
      const factor = 2 + Math.random() * 3;
      const corrupted = Math.random() < 0.5 ? num * factor : num / factor;
      return String(Math.max(1, Math.round(corrupted)));
    }
    case 'percentage': {
      // Shift by 10-30 percentage points
      const shift = 10 + Math.random() * 20;
      const corrupted = Math.random() < 0.5 ? num + shift : Math.max(1, num - shift);
      return corrupted.toFixed(value.includes('.') ? 1 : 0);
    }
    default:
      return value;
  }
}

/**
 * Find all numeric facts in the content body (after frontmatter).
 */
function findNumericFacts(content: string): Array<{
  fullMatch: string;
  prefix: string;
  number: string;
  suffix: string;
  label: string;
  index: number;
  paragraphIndex: number;
}> {
  const body = stripFrontmatter(content);
  const bodyStart = content.indexOf(body);
  const facts: Array<{
    fullMatch: string;
    prefix: string;
    number: string;
    suffix: string;
    label: string;
    index: number;
    paragraphIndex: number;
  }> = [];

  // Split into paragraphs for paragraph indexing.
  // Track actual char offsets from the body string (don't assume separator width).
  const paragraphs = body.split(/\n\n+/);
  let charOffset = 0;

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];
    // Find where this paragraph actually starts in the body
    const paraStart = body.indexOf(para, charOffset);

    for (const { regex, label } of NUMBER_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(para)) !== null) {
        // The number is always in capture group 2 for our patterns
        // But the structure varies — extract prefix, number, suffix
        const fullMatch = match[0];
        let prefix = match[1] || '';
        let number = match[2] || '';
        let suffix = match[3] || '';

        // For percentage pattern, groups are different
        if (label === 'percentage') {
          prefix = '';
          number = match[1];
          suffix = match[2];
        }

        facts.push({
          fullMatch,
          prefix,
          number,
          suffix,
          label,
          index: bodyStart + paraStart + match.index,
          paragraphIndex: pi,
        });
      }
    }

    charOffset = paraStart + para.length;
  }

  return facts;
}

/**
 * Inject wrong numbers into wiki content.
 *
 * Finds numeric facts and corrupts `count` of them, choosing diverse locations.
 */
export async function injectWrongNumbers(
  content: string,
  count: number,
  _useLlm: boolean,
): Promise<{ content: string; errors: InjectedError[] }> {
  const facts = findNumericFacts(content);
  if (facts.length === 0) {
    return { content, errors: [] };
  }

  // Select `count` facts, preferring diverse paragraphs
  const selected: typeof facts = [];
  const usedParagraphs = new Set<number>();
  const shuffled = [...facts].sort(() => Math.random() - 0.5);

  for (const fact of shuffled) {
    if (selected.length >= count) break;
    // Prefer facts in paragraphs we haven't used yet
    if (!usedParagraphs.has(fact.paragraphIndex) || selected.length < count) {
      selected.push(fact);
      usedParagraphs.add(fact.paragraphIndex);
    }
  }

  // Apply corruptions (work backwards by index to preserve positions)
  let corrupted = content;
  const errors: InjectedError[] = [];

  const sortedByIndex = [...selected].sort((a, b) => b.index - a.index);

  for (const fact of sortedByIndex) {
    const newNumber = corruptNumber(fact.number, fact.label);
    if (newNumber === fact.number) continue;

    const newFullMatch = fact.fullMatch.replace(fact.number, newNumber);

    // Use index-based splicing instead of String.replace to target the exact
    // occurrence (String.replace hits the *first* match, which may not be ours).
    const before = corrupted.slice(0, fact.index);
    const after = corrupted.slice(fact.index + fact.fullMatch.length);
    if (corrupted.slice(fact.index, fact.index + fact.fullMatch.length) === fact.fullMatch) {
      corrupted = before + newFullMatch + after;
      errors.push({
        id: `wrong-number-${errors.length}`,
        category: 'wrong-number',
        description: `Changed ${fact.label}: "${fact.number}" → "${newNumber}" (original: "${fact.fullMatch}")`,
        originalText: fact.fullMatch,
        corruptedText: newFullMatch,
        paragraphIndex: fact.paragraphIndex,
        detectability: fact.label === 'founding-year' ? 'easy' : 'medium',
      });
    }
  }

  return { content: corrupted, errors };
}
