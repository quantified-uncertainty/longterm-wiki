/**
 * Exaggeration Injector
 *
 * Finds hedged or moderate claims and inflates them. For example:
 * - "contributed to" → "led"
 * - "may help with" → "solves"
 * - "one of the larger" → "the largest"
 * - "several researchers" → "most experts"
 *
 * Tests whether adversarial review catches speculation and whether
 * citation auditor catches claims that overstate what sources say.
 */

import type { InjectedError } from '../types.ts';
import { stripFrontmatter } from '../../lib/patterns.ts';

// ---------------------------------------------------------------------------
// Exaggeration patterns: [regex, original capture, exaggerated replacement]
// ---------------------------------------------------------------------------

interface ExaggerationRule {
  /** Pattern to match. Capture group 1 is the text to replace. */
  pattern: RegExp;
  /** Replacement function. Receives the full match and capture groups. */
  replace: (match: string, ...groups: string[]) => string;
  /** Human-readable description. */
  description: string;
  /** How hard is this to detect? */
  detectability: 'easy' | 'medium' | 'hard';
}

const RULES: ExaggerationRule[] = [
  {
    pattern: /\b(contributed to)\b/gi,
    replace: (_m, _g) => 'led',
    description: '"contributed to" → "led"',
    detectability: 'medium',
  },
  {
    pattern: /\b(may help (?:to )?(?:address|reduce|mitigate|solve|improve))\b/gi,
    replace: (_m, g) => g.replace(/^may help (?:to )?/, 'effectively '),
    description: '"may help [verb]" → "effectively [verb]s"',
    detectability: 'medium',
  },
  {
    pattern: /\b(one of the (?:larger|leading|more prominent|more influential))\b/gi,
    replace: (_m, _g) => 'the largest and most influential',
    description: '"one of the larger/leading" → "the largest and most influential"',
    detectability: 'easy',
  },
  {
    pattern: /\b(several|some|a number of) (researchers|experts|scientists|organizations)\b/gi,
    replace: (_m, _quantifier, noun) => `most ${noun}`,
    description: '"several/some researchers" → "most researchers"',
    detectability: 'medium',
  },
  {
    pattern: /\b(has been (?:somewhat|partially|partly) (?:successful|effective))\b/gi,
    replace: (_m, _g) => 'has been highly successful',
    description: '"partially successful" → "highly successful"',
    detectability: 'easy',
  },
  {
    pattern: /\b(suggests|indicates|implies)\b/gi,
    replace: (_m, _g) => 'conclusively demonstrates',
    description: '"suggests/indicates" → "conclusively demonstrates"',
    detectability: 'easy',
  },
  {
    pattern: /\b(could potentially|might|may)\b/gi,
    replace: (_m, _g) => 'will inevitably',
    description: '"could potentially/might" → "will inevitably"',
    detectability: 'easy',
  },
  {
    pattern: /\b(is (?:sometimes|often|occasionally) (?:considered|regarded|seen) as)\b/gi,
    replace: (_m, _g) => 'is universally recognized as',
    description: '"often considered" → "universally recognized"',
    detectability: 'easy',
  },
  {
    pattern: /\b(has received (?:some|moderate|growing) (?:attention|interest|support))\b/gi,
    replace: (_m, _g) => 'has received overwhelming support',
    description: '"moderate attention" → "overwhelming support"',
    detectability: 'medium',
  },
];

// ---------------------------------------------------------------------------
// Injector
// ---------------------------------------------------------------------------

/**
 * Find hedged/moderate claims and exaggerate them.
 */
export async function injectExaggerations(
  content: string,
  count: number,
  _useLlm: boolean,
): Promise<{ content: string; errors: InjectedError[] }> {
  const body = stripFrontmatter(content);
  const errors: InjectedError[] = [];
  let corrupted = content;
  let applied = 0;

  // Find all matches across all rules
  const allMatches: Array<{
    rule: ExaggerationRule;
    match: RegExpExecArray;
    paragraphIndex: number;
  }> = [];

  const paragraphs = body.split(/\n\n+/);
  let charOffset = 0;

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];

    for (const rule of RULES) {
      // Clone regex to reset lastIndex
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(para)) !== null) {
        allMatches.push({ rule, match, paragraphIndex: pi });
      }
    }

    charOffset += para.length + 2;
  }

  // Shuffle and select
  const shuffled = allMatches.sort(() => Math.random() - 0.5);

  for (const { rule, match, paragraphIndex } of shuffled) {
    if (applied >= count) break;

    const original = match[0];
    const replacement = rule.replace(match[0], ...match.slice(1));

    if (original === replacement) continue;

    // Only replace the first occurrence to avoid double-replacing
    const before = corrupted;
    corrupted = corrupted.replace(original, replacement);

    if (corrupted !== before) {
      errors.push({
        id: `exaggeration-${applied}`,
        category: 'exaggeration',
        description: rule.description,
        originalText: original,
        corruptedText: replacement,
        paragraphIndex,
        detectability: rule.detectability,
      });
      applied++;
    }
  }

  return { content: corrupted, errors };
}
