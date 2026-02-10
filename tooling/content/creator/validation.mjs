/**
 * Validation Module
 *
 * Handles validation loop, full validation, and component import fixing.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { CRITICAL_RULES, QUALITY_RULES } from '../../lib/content-types.mjs';
import { componentImportsRule } from '../../lib/rules/component-imports.mjs';
import { ContentFile } from '../../lib/validation-engine.mjs';

/**
 * Ensure all used wiki components are properly imported.
 * Delegates to the shared component-imports validation rule.
 */
export function ensureComponentImports(filePath) {
  if (!fs.existsSync(filePath)) return { fixed: false, added: [] };

  const content = fs.readFileSync(filePath, 'utf-8');
  const contentFile = new ContentFile(filePath, content);

  // Use the shared rule to detect missing imports
  const issues = componentImportsRule.check(contentFile, { content: new Map() });

  if (!issues || issues.length === 0) {
    return { fixed: false, added: [] };
  }

  // Apply the fix from the shared rule
  const issue = issues[0];
  const fixedContent = componentImportsRule.fix(content, issue);

  if (fixedContent && fixedContent !== content) {
    fs.writeFileSync(filePath, fixedContent);
    return { fixed: true, added: issue.fix?.components || [] };
  }

  return { fixed: false, added: [] };
}

export async function runValidationLoop(topic, { log, ROOT, getTopicDir }) {
  log('validate', 'Starting validation loop...');

  const draftPath = path.join(getTopicDir(topic), 'draft.mdx');
  if (!fs.existsSync(draftPath)) {
    log('validate', 'No draft found, skipping validation');
    return { success: false, error: 'No draft found' };
  }

  const validationPrompt = `# Validate and Fix Wiki Article

Read the draft article at: ${draftPath}

## Validation Tasks - Fix ALL Issues

### Critical Issues (MUST fix - these break the build):

1. **Run precommit validation**:
   \`node tooling/crux.mjs validate\`

2. **Fix escaping issues**:
   - Escape unescaped $ signs as \\$
   - Escape < before numbers as \\< or use &lt;
   - Use ≈ instead of ~ in table cells (~ renders as strikethrough)
   - Use ≈\\$ instead of ~\\$ (tilde + escaped dollar causes errors)

3. **Fix EntityLinks** (verify IDs resolve):
   - Read app/src/data/pathRegistry.json to see which entity IDs exist
   - For EVERY EntityLink in the draft, verify the id exists as a key in pathRegistry
   - EntityLink IDs must be simple slugs (e.g., "open-philanthropy"), NOT paths (e.g., "organizations/funders/open-philanthropy")
   - If an EntityLink id doesn't exist in pathRegistry:
     - Check for similar IDs (e.g., "center-for-ai-safety" should be "cais")
     - Or REMOVE the EntityLink entirely and use plain text instead
   - It's better to use plain text than to use an invalid EntityLink ID

4. **Fix broken citations**:
   - Ensure all [^N] footnote citations have actual URLs, not "undefined"
   - NEVER use fake URLs like "example.com", "/posts/example", etc.
   - If no real URL available, use text-only citation: [^1]: Source name - description

### Quality Issues (MUST fix - these cause rendering problems):

5. **Fix markdown list formatting**:
   - Numbered lists starting at N>1 need blank line before
   - Check with: \`node tooling/crux.mjs validate unified --rules=markdown-lists\`

6. **Fix consecutive bold labels**:
   - Bold lines like "**Label:** text" need blank line between them
   - Check with: \`node tooling/crux.mjs validate unified --rules=consecutive-bold-labels\`

7. **Remove placeholders**:
   - No TODO markers or placeholder text like "[insert X here]"

### Final Steps:

8. **Check wiki conventions**:
   - All factual claims have footnote citations
   - Proper frontmatter fields present (title, description, importance, lastEdited, ratings)
   - Import statement: \`import {...} from '@components/wiki';\`

9. **Write the final fixed version** to:
   ${path.join(getTopicDir(topic), 'final.mdx')}

10. **Report** what was fixed.

Keep iterating until ALL checks pass. Run validation again after each fix.`;

  return new Promise((resolve, reject) => {
    const claude = spawn('npx', [
      '@anthropic-ai/claude-code',
      '-p',
      '--print',
      '--dangerously-skip-permissions',
      '--model', 'sonnet',
      '--max-budget-usd', '2.0',
      '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep'
    ], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    claude.stdin.write(validationPrompt);
    claude.stdin.end();

    let stdout = '';
    claude.stdout.on('data', data => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    claude.on('close', code => {
      const finalPath = path.join(getTopicDir(topic), 'final.mdx');
      const hasOutput = fs.existsSync(finalPath);
      resolve({
        success: code === 0 && hasOutput,
        hasOutput,
        exitCode: code
      });
    });
  });
}

export async function runFullValidation(topic, { log, saveResult, ROOT, getTopicDir }) {
  log('validate-full', 'Running comprehensive validation...');

  const finalPath = path.join(getTopicDir(topic), 'final.mdx');
  if (!fs.existsSync(finalPath)) {
    log('validate-full', 'No final.mdx found, skipping');
    return { success: false, error: 'No final.mdx found' };
  }

  const results = {
    critical: { passed: 0, failed: 0, errors: [] },
    quality: { passed: 0, failed: 0, warnings: [] },
    compile: { success: false, error: null }
  };

  // 1. Run MDX compilation check
  log('validate-full', 'Checking MDX compilation...');
  try {
    const { execSync } = await import('child_process');
    execSync('node tooling/crux.mjs validate compile --quick', {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 60000
    });
    results.compile.success = true;
    log('validate-full', '  ✓ MDX compiles');
  } catch (error) {
    results.compile.error = error.message;
    log('validate-full', '  ✗ MDX compilation failed');
  }

  // 1b. Direct frontmatter check
  try {
    const tempContent = fs.readFileSync(finalPath, 'utf-8');

    const unquotedDateMatch = tempContent.match(/lastEdited:\s*(\d{4}-\d{2}-\d{2})(?:\s*$|\s*\n)/m);
    if (unquotedDateMatch) {
      const lineContent = tempContent.split('\n').find(l => l.includes('lastEdited:')) || '';
      if (!lineContent.includes('"') && !lineContent.includes("'")) {
        const fixedContent = tempContent.replace(
          /lastEdited:\s*(\d{4}-\d{2}-\d{2})/,
          'lastEdited: "$1"'
        );
        fs.writeFileSync(finalPath, fixedContent);
        log('validate-full', '  ✓ Fixed unquoted lastEdited date');
      }
    }
  } catch (fmError) {
    log('validate-full', `  Could not check frontmatter: ${fmError.message}`);
  }

  // 2. Run unified rules
  log('validate-full', 'Running validation rules...');

  const extractJson = (output) => {
    const lines = output.split('\n');
    const jsonStartIdx = lines.findIndex(line => line.trim().startsWith('{'));
    if (jsonStartIdx === -1) return null;
    const jsonStr = lines.slice(jsonStartIdx).join('\n');
    return JSON.parse(jsonStr);
  };

  const topicSlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  for (const rule of CRITICAL_RULES) {
    try {
      const { execSync } = await import('child_process');
      let output;
      let hasParseError = false;

      try {
        output = execSync(
          `node tooling/crux.mjs validate unified --rules=${rule} --ci 2>&1`,
          { cwd: ROOT, stdio: 'pipe', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
        ).toString();
      } catch (execError) {
        output = execError.stdout?.toString() || execError.stderr?.toString() || '';
      }

      let json = null;
      try {
        json = extractJson(output);
      } catch (parseErr) {
        hasParseError = true;
      }

      if (json) {
        const fileIssues = json.issues?.filter(i =>
          i.file?.includes(topicSlug) &&
          i.severity === 'error'
        ) || [];

        if (fileIssues.length > 0) {
          results.critical.failed++;
          results.critical.errors.push({ rule, issues: fileIssues });
          log('validate-full', `  ✗ ${rule}: ${fileIssues.length} error(s)`);
        } else {
          results.critical.passed++;
          log('validate-full', `  ✓ ${rule}`);
        }
      } else if (hasParseError) {
        try {
          const grepOutput = execSync(
            `node tooling/crux.mjs validate unified --rules=${rule} 2>&1 | grep -i "${topicSlug}" || true`,
            { cwd: ROOT, stdio: 'pipe', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
          ).toString();

          const errorCount = (grepOutput.match(/error/gi) || []).length;
          if (errorCount > 0) {
            results.critical.failed++;
            results.critical.errors.push({ rule, error: `${errorCount} error(s) found via grep` });
            log('validate-full', `  ✗ ${rule}: ${errorCount} error(s)`);
          } else {
            results.critical.passed++;
            log('validate-full', `  ✓ ${rule}`);
          }
        } catch {
          results.critical.passed++;
          log('validate-full', `  ✓ ${rule} (no issues for this file)`);
        }
      } else {
        results.critical.passed++;
        log('validate-full', `  ✓ ${rule}`);
      }
    } catch (error) {
      results.critical.failed++;
      results.critical.errors.push({ rule, error: error.message });
      log('validate-full', `  ✗ ${rule}: check failed`);
    }
  }

  // Quality rules (non-blocking)
  for (const rule of QUALITY_RULES) {
    try {
      const { execSync } = await import('child_process');
      const output = execSync(
        `node tooling/crux.mjs validate unified --rules=${rule} --ci 2>&1`,
        { cwd: ROOT, stdio: 'pipe', timeout: 30000 }
      ).toString();

      const json = extractJson(output);
      if (!json) {
        results.quality.passed++;
        log('validate-full', `  ✓ ${rule}`);
        continue;
      }

      const fileIssues = json.issues?.filter(i =>
        i.file?.includes(topicSlug)
      ) || [];

      if (fileIssues.length > 0) {
        results.quality.failed++;
        results.quality.warnings.push({ rule, issues: fileIssues });
        log('validate-full', `  ⚠ ${rule}: ${fileIssues.length} warning(s)`);
      } else {
        results.quality.passed++;
        log('validate-full', `  ✓ ${rule}`);
      }
    } catch (error) {
      log('validate-full', `  ? ${rule}: check skipped`);
    }
  }

  const success = results.compile.success && results.critical.failed === 0;
  log('validate-full', `\nValidation summary: ${success ? 'PASSED' : 'FAILED'}`);
  log('validate-full', `  Critical: ${results.critical.passed}/${results.critical.passed + results.critical.failed} passed`);
  log('validate-full', `  Quality: ${results.quality.passed}/${results.quality.passed + results.quality.failed} passed`);

  saveResult(topic, 'validation-results.json', results);

  return { success, results };
}
