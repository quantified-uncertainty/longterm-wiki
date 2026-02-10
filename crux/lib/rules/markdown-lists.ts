/**
 * Rule: Markdown List Formatting
 *
 * Checks for numbered lists that may not render correctly:
 * 1. Lists starting with numbers > 1 without a blank line before them
 *    (MDX may not recognize these as lists, rendering them as inline text)
 *
 * Example of problematic pattern:
 *   **Header:**
 *   6. First item    <- Won't render as a list!
 *   7. Second item
 *
 * Fix by adding a blank line:
 *   **Header:**
 *
 *   6. First item    <- Now renders correctly
 *   7. Second item
 */

import { createRule, Issue, Severity, FixType, type ContentFile, type ValidationEngine } from '../validation-engine.js';
import { isInCodeBlock } from '../mdx-utils.ts';

// Pattern: line starting with a number > 1 followed by period and space
const NUMBERED_LIST_PATTERN = /^(\d+)\.\s+/;

export const markdownListsRule = createRule({
  id: 'markdown-lists',
  name: 'Markdown List Formatting',
  description: 'Validate numbered lists have proper spacing for correct rendering',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const lines = content.body.split('\n');
    let position = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const prevLine = i > 0 ? lines[i - 1] : '';

      // Check if this line starts a numbered list with number > 1
      const match: RegExpMatchArray | null = line.match(NUMBERED_LIST_PATTERN);
      if (match) {
        const listNumber = parseInt(match[1], 10);

        // Only flag if list starts with number > 1
        if (listNumber > 1) {
          // Check if previous line is:
          // - Not blank
          // - Not itself a numbered list item
          const prevIsBlank = prevLine.trim() === '';
          const prevIsListItem = NUMBERED_LIST_PATTERN.test(prevLine);

          if (!prevIsBlank && !prevIsListItem) {
            // Check we're not in a code block
            if (!isInCodeBlock(content.body, position)) {
              issues.push(new Issue({
                rule: this.id,
                file: content.path,
                line: lineNum,
                message: `Numbered list starting with "${listNumber}." needs a blank line before it (otherwise won't render as a list). Previous line: "${prevLine.slice(0, 50)}${prevLine.length > 50 ? '...' : ''}"`,
                severity: Severity.ERROR,
                fix: {
                  type: FixType.INSERT_LINE_BEFORE,
                  content: '',
                },
              }));
            }
          }
        }
      }

      position += line.length + 1;
    }

    return issues;
  },
});

export default markdownListsRule;
