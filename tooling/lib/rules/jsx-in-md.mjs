/**
 * Rule: JSX in Markdown Files
 *
 * Checks that .md files don't contain JSX components, which won't work.
 * JSX requires .mdx extension to be processed correctly.
 *
 * This catches issues like the getting-started/index.md file that tried
 * to use <EntityLink> components but displayed them as raw text.
 */

import { createRule, Issue, Severity } from '../validation-engine.mjs';

// Common JSX component patterns
const JSX_PATTERNS = [
  /<[A-Z][a-zA-Z]*[\s/>]/,           // <ComponentName or <ComponentName>
  /import\s+\{[^}]+\}\s+from\s+['"]/,  // import { X } from '...'
  /import\s+[A-Z][a-zA-Z]*\s+from/,   // import Component from
  /<\/[A-Z][a-zA-Z]*>/,               // </ComponentName>
];

export const jsxInMdRule = createRule({
  id: 'jsx-in-md',
  name: 'JSX in Markdown Files',
  description: 'Detect JSX components in .md files (should be .mdx)',

  check(content, engine) {
    const issues = [];

    // Only check .md files (not .mdx)
    if (content.extension !== 'md') {
      return issues;
    }

    const lines = content.body.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Track code blocks
      if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }

      if (inCodeBlock) continue;

      // Skip lines that are just inline code mentions (e.g., `<Component>`)
      // Remove inline code before checking for JSX
      const lineWithoutInlineCode = line.replace(/`[^`]+`/g, '');

      // Check each JSX pattern
      for (const pattern of JSX_PATTERNS) {
        if (pattern.test(lineWithoutInlineCode)) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `JSX syntax detected in .md file - rename to .mdx: ${line.trim().slice(0, 50)}...`,
            severity: Severity.ERROR,
            fix: {
              description: 'Rename file from .md to .mdx',
            },
          }));
          break; // One issue per line is enough
        }
      }
    }

    return issues;
  },
});

export default jsxInMdRule;
