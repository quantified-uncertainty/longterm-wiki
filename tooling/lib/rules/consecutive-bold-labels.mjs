/**
 * Rule: Consecutive Bold Labels
 *
 * Detects consecutive lines starting with **Label**: that will render
 * as a single paragraph instead of separate lines.
 *
 * In Markdown, consecutive lines without blank lines between them are
 * merged into a single paragraph. This is problematic for patterns like:
 *
 *   **Concern**: Academic publishing too slow
 *   **Response**: Rigorous evaluation helps      <- All on one line!
 *   **Mitigation**: Faster preprint sharing
 *
 * Fix by adding blank lines between each:
 *
 *   **Concern**: Academic publishing too slow
 *
 *   **Response**: Rigorous evaluation helps      <- Now separate
 *
 *   **Mitigation**: Faster preprint sharing
 */

import { createRule, Issue, Severity, FixType } from '../validation-engine.js';
import { isInCodeBlock } from '../mdx-utils.mjs';

// Pattern: line starting with **SomeLabel**: or **SomeLabel**:
// Matches: **Concern**: text, **Response**: text, etc.
const BOLD_LABEL_PATTERN = /^\*\*[^*]+\*\*:/;

export const consecutiveBoldLabelsRule = createRule({
  id: 'consecutive-bold-labels',
  name: 'Consecutive Bold Labels',
  description: 'Validate bold label lines have blank lines between them for correct rendering',

  check(content, engine) {
    const issues = [];
    const lines = content.body.split('\n');
    let position = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const prevLine = lines[i - 1];
      const lineNum = i + 1;

      // Check if current line starts with a bold label
      if (BOLD_LABEL_PATTERN.test(line)) {
        // Check if previous line also starts with a bold label (consecutive)
        if (BOLD_LABEL_PATTERN.test(prevLine)) {
          // Calculate position of current line for code block check
          const linePosition = position + prevLine.length + 1;

          // Check we're not in a code block
          if (!isInCodeBlock(content.body, linePosition)) {
            const labelMatch = line.match(/^\*\*([^*]+)\*\*:/);
            const label = labelMatch ? labelMatch[1] : 'Label';

            issues.push(new Issue({
              rule: this.id,
              file: content.path,
              line: lineNum,
              message: `Consecutive bold label "**${label}**:" needs a blank line before it (otherwise all labels render on one line). Previous line also has a bold label.`,
              severity: Severity.ERROR,
              fix: {
                type: FixType.INSERT_LINE_BEFORE,
                content: '',
              },
            }));
          }
        }
      }

      position += line.length + 1;
    }

    return issues;
  },
});

export default consecutiveBoldLabelsRule;
