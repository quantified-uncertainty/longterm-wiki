/**
 * Evaluative Framing Validation Rule
 *
 * Catches subtle editorial framing that the existing objectivity rules miss.
 * These patterns are common in LLM-generated content: dramatic adjectives,
 * narrative framing devices, and evaluative labels presented as neutral prose.
 *
 * Bad: "This represents a complete failure of the legislative process"
 * Good: "None of the 150 proposed bills passed into law"
 *
 * Bad: "The company achieved remarkable growth"
 * Good: "Revenue grew 38x year-over-year to $3.8B"
 *
 * Bad: Assessment table with "Concerning" / "Inadequate" / "Weak" labels
 * Good: Assessment table with data: "25 departures from 3,000 staff (0.8%)"
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';

const EVALUATIVE_PATTERNS: { pattern: RegExp; message: string }[] = [
  // Dramatic adjectives before nouns — editorial emphasis disguised as description
  {
    pattern: /\b(?:complete|total|utter|abject|catastrophic|devastating)\s+(?:failure|collapse|breakdown|disaster|inability)\b/gi,
    message: 'Evaluative framing: dramatic adjective + failure noun — state what happened instead of characterizing it',
  },
  // "unprecedented" / "remarkable" / "formidable" — editorializing through adjectives
  {
    pattern: /\b(?:unprecedented|remarkable|formidable|extraordinary|staggering|alarming|troubling|disturbing)\s+(?:\w+\s+){0,2}(?:growth|scale|increase|decline|rise|drop|expansion|progress|success|failure|challenge|threat|achievement)\b/gi,
    message: 'Evaluative framing: loaded adjective — let the numbers speak for themselves',
  },
  // "represents a" as narrative device — imposes interpretation
  {
    pattern: /\b(?:represents?|constitutes?|amounts?\s+to)\s+(?:a\s+)?(?:complete|major|significant|fundamental|critical|dramatic|clear|stark|systematic)\s+/gi,
    message: 'Evaluative framing: "represents a [judgment]" imposes interpretation — state the facts directly',
  },
  // "unique and controversial" / loaded compound characterizations
  {
    pattern: /\b(?:unique and controversial|controversial and (?:unprecedented|alarming)|unprecedented and (?:concerning|troubling))\b/gi,
    message: 'Evaluative framing: loaded compound characterization — describe specific aspects instead',
  },
  // Asymmetric verbs: "claimed" / "admitted" vs neutral "said" / "stated"
  // Only flag "admitted" and "conceded" which imply wrongdoing
  {
    pattern: /\b(?:admitted|conceded|was forced to acknowledge|finally acknowledged)\s+(?:that|to)\b/gi,
    message: 'Evaluative framing: "admitted/conceded" implies wrongdoing — use neutral "stated" or "said"',
  },
  // "proved" for contested claims — presents opinion as established fact
  {
    pattern: /\bproved?\s+(?:decisive|formidable|effective|successful|inadequate|ineffective|counterproductive|devastating)\b/gi,
    message: 'Evaluative framing: "proved [judgment]" presents opinion as established fact — describe the evidence',
  },
];

// Separate patterns for assessment tables — evaluative labels
const ASSESSMENT_LABEL_PATTERNS: { pattern: RegExp; message: string }[] = [
  // Traffic-light labels in table cells: | **Concerning** | or | ⚠️ Concerning |
  {
    pattern: /\|\s*(?:\*\*|⚠️\s*|❌\s*|🔴\s*)?(Concerning|Inadequate|Weak|Poor|Failing|Deteriorating|Worsening|Unacceptable)(?:\*\*)?\s*\|/gi,
    message: 'Evaluative label in table: use data-driven descriptions instead of judgmental labels (e.g., "25 departures / 3,000 staff" not "Concerning")',
  },
];

export const evaluativeFramingRule = {
  id: 'evaluative-framing',
  name: 'Evaluative Framing',
  description: 'Detect subtle editorial framing: dramatic adjectives, narrative devices, and evaluative labels in analytical content',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const content = contentFile.body || '';
    if (!content) return issues;

    const lines = content.split('\n');
    let inCodeBlock = false;
    let inMermaid = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      // Skip Mermaid diagram content
      if (line.includes('<Mermaid')) { inMermaid = true; continue; }
      if (inMermaid && line.includes('/>')) { inMermaid = false; continue; }
      if (inMermaid) continue;

      // Skip imports, comments, headings
      if (line.trim().startsWith('import ')) continue;
      if (line.trim().startsWith('<!--')) continue;

      // Skip footnote definitions — these are quoting sources
      if (/^\[\^\d+\]:/.test(line.trim())) continue;

      // Skip lines that are inside quotes (blockquotes)
      if (line.trim().startsWith('>')) continue;

      // Run evaluative patterns on all content lines
      for (const { pattern, message } of EVALUATIVE_PATTERNS) {
        pattern.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          issues.push(new Issue({
            rule: 'evaluative-framing',
            file: contentFile.path,
            line: lineNum,
            message: `Evaluative framing: "${match[0]}" — ${message}`,
            severity: Severity.WARNING,
          }));
        }
      }

      // Run assessment label patterns only on table rows
      if (line.includes('|')) {
        for (const { pattern, message } of ASSESSMENT_LABEL_PATTERNS) {
          pattern.lastIndex = 0;

          let match: RegExpExecArray | null;
          while ((match = pattern.exec(line)) !== null) {
            issues.push(new Issue({
              rule: 'evaluative-framing',
              file: contentFile.path,
              line: lineNum,
              message: `Evaluative label: "${match[1]}" — ${message}`,
              severity: Severity.WARNING,
            }));
          }
        }
      }
    }

    return issues;
  },
};
