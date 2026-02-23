/**
 * Pipeline Artifacts Validation Rule
 *
 * Detects JSON blobs from the improve pipeline accidentally written into MDX
 * body content. This happens when the improve phase's code-block extraction
 * regex matches a JSON analysis block instead of the actual MDX output.
 *
 * The corruption signature is a standalone `{` line (opening brace of a JSON
 * object) followed within a few lines by a `"content":` field — the exact
 * shape of GroundedWriteResult from section-writer.ts.
 *
 * These artifacts render as raw JSON in the browser and indicate that a
 * pipeline run wrote the wrong string to the MDX file.
 *
 * Severity: ERROR (blocking) — the page will render broken JSON to readers.
 *
 * Root cause reference: claude/fix-footer-rendering-ttIYJ
 */

import { Severity, Issue } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';

/** Lines after a standalone `{` to search for the JSON field signature. */
const LOOKAHEAD_LINES = 8;

/**
 * Fields that appear in GroundedWriteResult / section-writer JSON responses.
 * Two or more of these in the lookahead window strongly indicate a JSON blob.
 */
const JSON_FIELD_PATTERNS = [
  /"content"\s*:/,
  /"claimMap"\s*:/,
  /"unsourceableClaims"\s*:/,
  /"citationAnalysis"\s*:/,
];

export const pipelineArtifactsRule = {
  id: 'pipeline-artifacts',
  name: 'Pipeline Artifacts',
  description: 'Detect JSON blobs from the improve pipeline accidentally written into MDX body content',
  severity: Severity.ERROR,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const body = contentFile.body || '';
    if (!body) return issues;

    const lines = body.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track fenced code blocks — don't flag JSON inside legitimate ``` blocks
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      // A standalone `{` on its own line is the opener of a leaked JSON object.
      if (line.trim() !== '{') continue;

      // Look ahead for JSON field signatures within the next LOOKAHEAD_LINES lines.
      const window = lines.slice(i + 1, i + 1 + LOOKAHEAD_LINES).join('\n');
      const matchCount = JSON_FIELD_PATTERNS.filter(p => p.test(window)).length;

      // Two or more matching fields = very likely a leaked JSON blob.
      if (matchCount >= 2) {
        issues.push(new Issue({
          rule: 'pipeline-artifacts',
          file: contentFile.path,
          line: i + 1,
          message:
            `Pipeline artifact: standalone \`{\` with JSON fields ("content", "claimMap", etc.) ` +
            `detected in MDX body. This is a leaked improve-pipeline JSON response — ` +
            `the page will render as raw JSON. Remove the blob and restore the MDX content.`,
          severity: Severity.ERROR,
        }));
      }
    }

    return issues;
  },
};

export default pipelineArtifactsRule;
