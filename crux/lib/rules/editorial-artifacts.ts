/**
 * Editorial Artifacts Validation Rule
 *
 * Catches phrases that expose the page's own editorial/revision history,
 * breaking the illusion that the reader is seeing a polished final product.
 *
 * Bad: "An earlier version of this analysis showed..."
 * Bad: "We previously estimated..."
 * Good: Present the final analysis directly without referencing drafts.
 *
 * These patterns are intentionally narrow to avoid false positives on
 * descriptions of external entities' histories (e.g., "the original draft
 * of the legislation" or "OpenAI initially used...").
 *
 * See content-quality.md "The Editorial Artifacts Trap" for full guidance.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';

const EDITORIAL_ARTIFACT_PATTERNS: { pattern: RegExp; message: string }[] = [
  // Self-referencing revision history — "this analysis", "this page", etc.
  {
    pattern: /(?:an? )?(?:earlier|previous|prior) version of this (?:analysis|page|section|document|model|framework|table)/gi,
    message: 'References an earlier version of this page — present the final analysis directly',
  },
  // First-person editorial history — "we previously estimated", "I originally showed"
  {
    pattern: /(?:we|I|this (?:page|section|analysis)) (?:previously|originally|initially|formerly) (?:estimated?|showed?|calculated?|assumed?|had|thought|believed)/gi,
    message: 'References the page\'s own editorial history',
  },
  // Explicit rewrite/revision references
  {
    pattern: /this (?:section|page|analysis|table) (?:was|has been) (?:rewritten|revised|updated|corrected|fixed|changed) (?:because|to|since|after)/gi,
    message: 'Exposes editorial process — the page should read as if the current version was always the intended one',
  },
  // "Here's what was wrong" framing
  {
    pattern: /here'?s what was wrong/gi,
    message: 'References errors in a prior version — present the correct analysis directly',
  },
  // Self-referencing structural changes — "we moved to two outcomes because"
  {
    pattern: /(?:previous|earlier|prior) versions? of this (?:framework|model|analysis|page)/gi,
    message: 'References prior versions of this page — justify the current approach directly',
  },
];

export const editorialArtifactsRule = {
  id: 'editorial-artifacts',
  name: 'Editorial Artifacts',
  description: 'Detect phrases that expose the page\'s own revision history or editorial process',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
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

      for (const { pattern, message } of EDITORIAL_ARTIFACT_PATTERNS) {
        // Reset regex state
        pattern.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          issues.push(new Issue({
            rule: 'editorial-artifacts',
            file: contentFile.path,
            line: lineNum,
            message: `Editorial artifact: "${match[0]}" — ${message}`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
