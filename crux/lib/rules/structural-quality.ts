/**
 * Structural Quality Validation Rule
 *
 * Catches structural issues that reduce readability and analytical quality:
 * overly long paragraphs, vague hedging, and missing uncertainty sections
 * on analysis pages.
 *
 * These are content-level checks, not formatting rules.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.js';

/**
 * Count words in a text string (rough but fast)
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

export const structuralQualityRule = {
  id: 'structural-quality',
  name: 'Structural Quality',
  description: 'Detect structural issues: long paragraphs, vague hedging, missing uncertainty sections',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const content = contentFile.body || '';
    if (!content) return issues;

    const lines = content.split('\n');
    let inCodeBlock = false;

    // --- Check 1: Long paragraphs (>200 words) ---
    let paragraphLines: string[] = [];
    let paragraphStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        // Flush paragraph before code block
        if (paragraphLines.length > 0) {
          checkParagraph(paragraphLines, paragraphStart, issues, contentFile);
          paragraphLines = [];
        }
        continue;
      }
      if (inCodeBlock) continue;

      // Skip headings, list items, table rows, imports, components
      if (line.trim().startsWith('#') || line.trim().startsWith('-') || line.trim().startsWith('*') ||
          line.trim().startsWith('|') || line.trim().startsWith('import ') || line.trim().startsWith('<') ||
          line.trim().startsWith('>')) {
        if (paragraphLines.length > 0) {
          checkParagraph(paragraphLines, paragraphStart, issues, contentFile);
          paragraphLines = [];
        }
        continue;
      }

      if (line.trim() === '') {
        // End of paragraph
        if (paragraphLines.length > 0) {
          checkParagraph(paragraphLines, paragraphStart, issues, contentFile);
          paragraphLines = [];
        }
      } else {
        if (paragraphLines.length === 0) {
          paragraphStart = i + 1;
        }
        paragraphLines.push(line);
      }
    }
    // Check last paragraph
    if (paragraphLines.length > 0) {
      checkParagraph(paragraphLines, paragraphStart, issues, contentFile);
    }

    // --- Check 2: Vague "it depends" hedging ---
    inCodeBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;
      if (line.trim().startsWith('import ')) continue;

      // "it depends" without specifying on what
      const dependsMatch = line.match(/\bit depends\b/gi);
      if (dependsMatch) {
        // Check if the line or next line specifies "on"
        const hasContext = /\bit depends on\b/i.test(line) ||
                          (i + 1 < lines.length && /^\s*on\b/i.test(lines[i + 1]));
        if (!hasContext) {
          issues.push(new Issue({
            rule: 'structural-quality',
            file: contentFile.path,
            line: i + 1,
            message: 'Vague hedging: "it depends" without specifying on what — add the conditions',
            severity: Severity.WARNING,
          }));
        }
      }

      // "various factors" / "many factors" / "multiple considerations" without listing them
      const vagueFactorsMatch = line.match(/\b(?:various|many|multiple|numerous|several) (?:factors|considerations|variables|elements|aspects)\b/gi);
      if (vagueFactorsMatch) {
        for (const match of vagueFactorsMatch) {
          issues.push(new Issue({
            rule: 'structural-quality',
            file: contentFile.path,
            line: i + 1,
            message: `Vague language: "${match}" — list the specific factors`,
            severity: Severity.INFO,
          }));
        }
      }
    }

    // --- Check 3: Missing uncertainty section on analysis pages ---
    const relativePath = contentFile.relativePath || '';
    const isAnalysis = relativePath.includes('/models/') ||
                       contentFile.frontmatter?.contentType === 'analysis';

    if (isAnalysis) {
      const hasUncertaintySection = /^#{1,3}\s+.*(?:uncertaint|limitation|caveat|assumption|risk|what could go wrong|why .* might be wrong)/im.test(content);
      if (!hasUncertaintySection) {
        issues.push(new Issue({
          rule: 'structural-quality',
          file: contentFile.path,
          line: 1,
          message: 'Analysis page missing uncertainty/limitations section — add a section discussing key uncertainties',
          severity: Severity.INFO,
        }));
      }
    }

    return issues;
  },
};

/**
 * Check if a paragraph exceeds the word limit
 */
function checkParagraph(paragraphLines: string[], startLine: number, issues: Issue[], contentFile: ContentFile): void {
  const text = paragraphLines.join(' ');
  const wordCount = countWords(text);

  if (wordCount > 200) {
    issues.push(new Issue({
      rule: 'structural-quality',
      file: contentFile.path,
      line: startLine,
      message: `Long paragraph: ${wordCount} words (>200) — consider breaking into smaller paragraphs`,
      severity: Severity.WARNING,
    }));
  }
}
