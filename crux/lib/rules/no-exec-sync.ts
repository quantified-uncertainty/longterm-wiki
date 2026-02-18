/**
 * Rule: No execSync with String Interpolation
 *
 * Scans crux/ source files for dangerous execSync usage patterns where
 * external data could be interpolated into shell commands.
 *
 * Safe: execFileSync("curl", ["-s", url], ...)
 * Unsafe: execSync(\`curl "\${url}"\`, ...)
 *
 * This is a global rule that scans TypeScript/JavaScript source files,
 * not wiki content. It prevents shell injection regressions.
 */

import { createRule, Issue, Severity } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../content-types.ts';
import { findFiles } from '../file-utils.ts';

const CRUX_DIR = join(PROJECT_ROOT, 'crux');

// Match execSync with template literal argument (backtick strings)
const EXEC_SYNC_TEMPLATE_RE = /\bexecSync\s*\(\s*`/;

export const noExecSyncRule = createRule({
  id: 'no-exec-sync',
  name: 'No execSync with Interpolation',
  description: 'Prevent shell injection by flagging execSync with template literals in crux/ source',
  scope: 'global',

  check(_content: ContentFile[], _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Scan all .ts, .mjs, .js files in crux/
    const extensions = ['.ts', '.mjs', '.js'];
    const files = findFiles(CRUX_DIR, extensions);

    for (const filePath of files) {
      // Skip test files and node_modules
      if (filePath.includes('node_modules') || filePath.includes('.test.')) continue;

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      let inBlockComment = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Track block comments (/* ... */)
        if (trimmed.startsWith('/*')) inBlockComment = true;
        if (inBlockComment) {
          if (trimmed.includes('*/')) inBlockComment = false;
          continue;
        }

        // Skip single-line comments
        if (trimmed.startsWith('//')) continue;
        // Skip lines that are part of JSDoc-style comments (start with *)
        if (trimmed.startsWith('*')) continue;

        // Check for execSync with template literal (actual code only)
        if (EXEC_SYNC_TEMPLATE_RE.test(line)) {
          const relPath = relative(PROJECT_ROOT, filePath);
          issues.push(new Issue({
            rule: 'no-exec-sync',
            file: filePath,
            line: i + 1,
            message: `execSync with template literal in ${relPath}:${i + 1}. Use execFileSync with argument array to prevent shell injection.`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    return issues;
  },
});

export default noExecSyncRule;
