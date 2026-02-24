/**
 * Rule: Placeholder and Pipeline Filler Text
 *
 * Detects content that was inserted as a stub or left by the pipeline as an
 * artifact rather than real content. This includes:
 *
 * 1. JSX comments of the form "NEEDS CITATION" left in prose
 * 2. "(not yet created)" stub markers in prose
 * 3. Footnotes with description-only text and no URL (e.g. "[^4]: Series G announcement source")
 * 4. Table cells containing filler citation strings like "Internal planning",
 *    "Market consensus", "Aggregated", "Expert consensus" used as sources
 * 5. llmSummary frontmatter containing known grader error phrases
 *
 * Severity: WARNING for most; ERROR for footnotes that block citations.
 *
 * Resolves: https://github.com/quantified-uncertainty/longterm-wiki/issues/916
 */

import { createRule, Issue, Severity } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';

/** Filler strings used as source/evidence citations in table cells */
const FILLER_CITATION_STRINGS = [
  'Internal planning',
  'Market consensus',
  'Industry consensus',
  'Expert consensus',
  'Aggregated',
  'Common knowledge',
  'Various sources',
  'Multiple sources',
];

/** Known grader error phrases that sometimes end up written into llmSummary */
const GRADER_ERROR_PHRASES = [
  'Error generating summary',
  'Failed to generate',
  'Unable to generate',
  'LLM error',
  'API error',
  'Rate limit',
  'Content too long',
  'Could not summarize',
];

export const placeholderTextRule = createRule({
  id: 'placeholder-text',
  name: 'Placeholder/Filler Text',
  description: 'Detect NEEDS CITATION comments, stub markers, filler citations, and grader error artifacts',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Skip internal docs — they intentionally contain examples of these patterns
    const rel = content.relativePath;
    if (rel.startsWith('internal/')) return issues;

    const body = content.body;
    const lines = body.split('\n');

    // --- 1. {/* NEEDS CITATION */} JSX comments ---
    const needsCitationPattern = /\{\/\*\s*NEEDS?\s*CITATION\s*\*\/\}/gi;
    let match: RegExpExecArray | null;
    needsCitationPattern.lastIndex = 0;
    while ((match = needsCitationPattern.exec(body)) !== null) {
      const lineNum = body.substring(0, match.index).split('\n').length;
      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        line: lineNum,
        message: `Found '{/* NEEDS CITATION */}' marker — add a citation or remove the claim before shipping.`,
        severity: Severity.WARNING,
      }));
    }

    // --- 2. "(not yet created)" stub markers in prose ---
    const notYetCreatedPattern = /\(not yet created\)/gi;
    notYetCreatedPattern.lastIndex = 0;
    while ((match = notYetCreatedPattern.exec(body)) !== null) {
      const lineNum = body.substring(0, match.index).split('\n').length;
      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        line: lineNum,
        message: `Found '(not yet created)' stub marker — link to the actual page or remove the reference.`,
        severity: Severity.WARNING,
      }));
    }

    // --- 3. Footnotes with description-only text and no URL ---
    // Pattern: [^N]: Some text that has no http:// link
    // Allow multi-word text but require that it contains a URL or is one of known-ok patterns
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match footnote definitions: [^N]: text (but not [^N]: [link text](url) forms)
      const footnoteMatch = line.match(/^\[\^[^\]]+\]:\s+(.+)$/);
      if (footnoteMatch) {
        const footnoteBody = footnoteMatch[1];
        // If the footnote has no URL at all, it's likely a placeholder
        const hasUrl = /https?:\/\//.test(footnoteBody);
        const hasDoi = /doi:\s*10\./i.test(footnoteBody);
        const hasInternalLink = /\[.*\]\(\//.test(footnoteBody);
        if (!hasUrl && !hasDoi && !hasInternalLink) {
          // Further filter: short description-only text (not a full citation without URL)
          // Heuristic: < 100 chars and no comma (real citations usually have author, year, title)
          const isProbablyPlaceholder = footnoteBody.length < 100 && !footnoteBody.includes('(') && !footnoteBody.includes(',');
          if (isProbablyPlaceholder) {
            issues.push(new Issue({
              rule: this.id,
              file: content.path,
              line: i + 1,
              message: `Footnote appears to be a description-only placeholder (no URL found): "${footnoteBody.substring(0, 60)}${footnoteBody.length > 60 ? '…' : ''}"`,
              severity: Severity.WARNING,
            }));
          }
        }
      }
    }

    // --- 4. Table cells with known filler citation strings ---
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Only check lines that look like table rows (contain pipes)
      if (!line.includes('|')) continue;
      for (const filler of FILLER_CITATION_STRINGS) {
        // Match filler string as the entire content of a table cell (with optional spaces/pipes)
        const cellPattern = new RegExp(`\\|\\s*${filler}\\s*\\|`, 'i');
        if (cellPattern.test(line)) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: i + 1,
            message: `Table cell contains filler citation string "${filler}" — replace with a real source or remove the column.`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    // --- 5. llmSummary grader error phrases in frontmatter ---
    const llmSummary = content.frontmatter?.llmSummary as string | undefined;
    if (llmSummary && typeof llmSummary === 'string') {
      for (const phrase of GRADER_ERROR_PHRASES) {
        if (llmSummary.toLowerCase().includes(phrase.toLowerCase())) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: 1,
            message: `llmSummary contains a grader error phrase "${phrase}" — clear the field or regenerate the summary.`,
            severity: Severity.WARNING,
          }));
          break; // Only report once per file
        }
      }
    }

    return issues;
  },
});

export default placeholderTextRule;
