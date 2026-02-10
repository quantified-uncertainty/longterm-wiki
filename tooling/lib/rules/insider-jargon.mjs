/**
 * Insider Jargon Validation Rule
 *
 * Catches language that assumes familiarity with EA/rationalist communities,
 * making content inaccessible to general readers.
 *
 * Bad: "EA money", "non-EA charities", "the community"
 * Good: "effective altruism-affiliated donors", "charities outside the EA network",
 *        "the effective altruism community"
 *
 * These patterns target insider shorthand, not legitimate descriptive uses.
 */

import { Severity, Issue } from '../validation-engine.js';

const INSIDER_JARGON_PATTERNS = [
  // "EA money", "EA funding", "EA donors" — insider shorthand
  {
    pattern: /\bEA\s+(?:money|funding|donors?|funds?|grants?|giving)\b/g,
    message: 'Insider jargon: spell out "effective altruism" or name specific organizations/donors',
  },
  // "non-EA" as a category — defines outsiders relative to an in-group
  {
    pattern: /\bnon-EA\b/g,
    message: 'Insider jargon: "non-EA" defines outsiders by EA identity — use descriptive language',
  },
  // "the community" without specifying which one
  {
    pattern: /\bthe community\b(?!\s+(?:of|for|at|in|around|within|that))/gi,
    message: 'Vague reference: "the community" — specify which community (e.g., "the effective altruism community")',
  },
  // "EA-aligned" without defining what alignment means
  {
    pattern: /\bEA-aligned\b/g,
    message: 'Insider jargon: "EA-aligned" is undefined — describe the specific alignment criteria',
  },
  // "EA organizations" as a blanket category
  {
    pattern: /\bEA\s+organizations?\b/g,
    message: 'Insider jargon: name specific organizations or say "effective altruism-affiliated organizations"',
  },
  // "EA cause areas" / "EA causes"
  {
    pattern: /\bEA\s+cause(?:\s+areas?)?\b/g,
    message: 'Insider jargon: name the specific cause areas or spell out "effective altruism"',
  },
  // "the movement" without context — implies EA movement
  {
    pattern: /\bthe movement\b(?!\s+(?:of|for|to|toward|towards))/gi,
    message: 'Vague reference: "the movement" — specify which movement',
  },
  // "community building" as EA-specific term
  {
    pattern: /\bcommunity building\b(?:\s+(?:work|efforts?|programs?|grants?))/gi,
    message: 'Possible insider jargon: "community building" is EA-specific terminology — clarify context for general readers',
  },
];

export const insiderJargonRule = {
  id: 'insider-jargon',
  name: 'Insider Jargon',
  description: 'Detect EA/rationalist insider language that reduces accessibility',
  severity: Severity.WARNING,

  check(contentFile, engine) {
    const issues = [];
    const content = contentFile.body || '';
    if (!content) return issues;

    const lines = content.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Track code blocks
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      // Skip import lines and HTML comments
      if (line.trim().startsWith('import ')) continue;
      if (line.trim().startsWith('<!--')) continue;

      for (const { pattern, message } of INSIDER_JARGON_PATTERNS) {
        pattern.lastIndex = 0;

        let match;
        while ((match = pattern.exec(line)) !== null) {
          issues.push(new Issue({
            rule: 'insider-jargon',
            file: contentFile.path,
            line: lineNum,
            message: `Insider jargon: "${match[0]}" — ${message}`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
