/**
 * Missing Nuance Injector
 *
 * Removes hedging language, uncertainty qualifiers, and conditional framing
 * from claims, making uncertain statements appear as established facts.
 *
 * This tests the adversarial review's speculation detection and the
 * citation auditor's ability to catch overclaiming.
 */

import type { InjectedError } from '../types.ts';
import { stripFrontmatter } from '../../lib/patterns.ts';

// ---------------------------------------------------------------------------
// Nuance removal patterns
// ---------------------------------------------------------------------------

interface NuanceRule {
  pattern: RegExp;
  /** Text to remove or replace. */
  replace: string;
  description: string;
  detectability: 'easy' | 'medium' | 'hard';
}

const RULES: NuanceRule[] = [
  // Remove uncertainty qualifiers
  {
    pattern: /\b(?:It is )?(?:widely |generally )?(?:believed|thought|considered|estimated|suspected) (?:that |to be )?/gi,
    replace: '',
    description: 'Removed "believed/estimated that" qualifier',
    detectability: 'medium',
  },
  {
    pattern: /\b(?:Some|Many|A few|Several) (?:researchers|experts|analysts|commentators) (?:have )?(?:argued|suggested|noted|proposed|claimed) (?:that )?/gi,
    replace: '',
    description: 'Removed "researchers argued that" attribution',
    detectability: 'medium',
  },
  {
    pattern: /\bAccording to (?:some )?(?:estimates|reports|analyses|sources|researchers),?\s*/gi,
    replace: '',
    description: 'Removed "according to" attribution',
    detectability: 'easy',
  },
  // Remove conditional framing
  {
    pattern: /\b(?:If|Assuming|Provided that|In the event that) .{10,60}, ((?:this|the|it|they)\b)/gi,
    replace: '$1',
    description: 'Removed conditional "if X, then" framing',
    detectability: 'hard',
  },
  // Remove temporal qualifiers
  {
    pattern: /\bAs of (?:early |late |mid-)?(?:20\d{2}|January|February|March|April|May|June|July|August|September|October|November|December) ?\d*,?\s*/gi,
    replace: '',
    description: 'Removed "as of [date]" temporal qualifier',
    detectability: 'medium',
  },
  // Remove hedging adverbs
  {
    pattern: /\b(approximately|roughly|about|around|nearly|an estimated)\s+/gi,
    replace: '',
    description: 'Removed hedging adverb (approximately/roughly/about)',
    detectability: 'medium',
  },
  // Remove limitation acknowledgments
  {
    pattern: /,?\s*(?:though|although|however|but) (?:this|these|the) (?:estimate|figure|number|assessment)s? (?:are|is|remain|may be) (?:uncertain|preliminary|contested|debated|approximate)[^.]*\./gi,
    replace: '.',
    description: 'Removed limitation acknowledgment clause',
    detectability: 'hard',
  },
];

// ---------------------------------------------------------------------------
// Injector
// ---------------------------------------------------------------------------

/**
 * Remove hedging and nuance from claims.
 */
export async function injectMissingNuance(
  content: string,
  count: number,
  _useLlm: boolean,
): Promise<{ content: string; errors: InjectedError[] }> {
  const body = stripFrontmatter(content);
  const errors: InjectedError[] = [];
  let corrupted = content;
  let applied = 0;

  // Find all matches
  const allMatches: Array<{
    rule: NuanceRule;
    match: RegExpExecArray;
    paragraphIndex: number;
  }> = [];

  const paragraphs = body.split(/\n\n+/);

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];

    for (const rule of RULES) {
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(para)) !== null) {
        allMatches.push({ rule, match, paragraphIndex: pi });
      }
    }
  }

  // Shuffle and select
  const shuffled = allMatches.sort(() => Math.random() - 0.5);

  for (const { rule, match, paragraphIndex } of shuffled) {
    if (applied >= count) break;

    const original = match[0];
    // Apply the replacement
    const replacement = original.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replace);

    if (original === replacement) continue;

    const before = corrupted;
    // Only replace the first occurrence
    corrupted = corrupted.replace(original, replacement);

    if (corrupted !== before) {
      errors.push({
        id: `missing-nuance-${applied}`,
        category: 'missing-nuance',
        description: rule.description,
        originalText: original.trim(),
        corruptedText: replacement.trim(),
        paragraphIndex,
        detectability: rule.detectability,
      });
      applied++;
    }
  }

  return { content: corrupted, errors };
}
