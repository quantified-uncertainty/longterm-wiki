/**
 * Human Attribution Validation Rule
 *
 * Catches text that incorrectly attributes LLM-generated work to humans.
 * This wiki's quality ratings, grades, and page content are all generated
 * by LLMs — references to "human-assigned", "human-rated", etc. are incorrect
 * when describing this wiki's own systems.
 *
 * Legitimate uses (e.g., "human-written Wikipedia articles") are excluded
 * by only matching phrases where "human" modifies an action this wiki performs
 * (assigning, rating, grading, reviewing quality).
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { matchLinesOutsideCode } from '../mdx-utils.ts';

const HUMAN_ATTRIBUTION_PATTERNS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /\bhuman[- ]assigned\b/gi,
    message: 'This wiki\'s ratings are LLM-assigned, not human-assigned',
  },
  {
    pattern: /\bhuman[- ]rated\b/gi,
    message: 'This wiki\'s ratings are LLM-generated, not human-rated',
  },
  {
    pattern: /\bhuman[- ]graded\b/gi,
    message: 'This wiki\'s grades are LLM-generated, not human-graded',
  },
];

export const humanAttributionRule = {
  id: 'human-attribution',
  name: 'Human Attribution',
  description: 'Detect incorrect attribution of LLM-generated work to humans',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    for (const { pattern, message } of HUMAN_ATTRIBUTION_PATTERNS) {
      matchLinesOutsideCode(
        contentFile.body,
        pattern,
        ({ match, lineNum }) => {
          issues.push(new Issue({
            rule: 'human-attribution',
            file: contentFile.path,
            line: lineNum,
            message: `False human attribution: "${match[0]}" — ${message}`,
            severity: Severity.WARNING,
          }));
        }
      );
    }

    return issues;
  },
};
