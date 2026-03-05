#!/usr/bin/env node

/**
 * Validate GitHub Actions workflow YAML files using actionlint.
 *
 * Runs `actionlint` on all `.github/workflows/*.yml` and `.github/workflows/*.yaml`
 * files in the repository. Blocks on real actionlint errors; ignores shellcheck
 * style/info suggestions (SC*:style and SC*:info) since those are advisory only.
 *
 * Gracefully skips if `actionlint` is not installed, with an installation hint.
 *
 * Why this matters: GitHub Actions YAML syntax errors have broken ALL CI on main
 * for days. actionlint catches heredoc-at-column-0 YAML aliases, missing expression
 * wrappers in `if:` conditions, boolean type errors, and injection risks — none of
 * which are caught by the YAML schema validator or MDX checks.
 *
 * Usage: npx tsx crux/validate/validate-actions-yaml.ts
 */

import { execSync, spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const WORKFLOWS_DIR = join(PROJECT_ROOT, '.github', 'workflows');

function isActionlintInstalled(): boolean {
  try {
    execSync('actionlint --version', { stdio: 'pipe', encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

export function runCheck(): { passed: boolean; errors: number; output: string } {
  const c = getColors();
  console.log(`${c.blue}Checking GitHub Actions workflow YAML with actionlint...${c.reset}\n`);

  // Check if actionlint is installed
  if (!isActionlintInstalled()) {
    console.log(`${c.yellow}⚠ actionlint not installed — skipping workflow validation${c.reset}`);
    console.log(`${c.dim}  Install: brew install actionlint${c.reset}`);
    console.log(`${c.dim}  Or: go install github.com/rhysd/actionlint/cmd/actionlint@latest${c.reset}\n`);
    // Fail-open: don't block the gate if the tool isn't installed.
    // CI installs actionlint explicitly so this only affects local runs.
    return { passed: true, errors: 0, output: '' };
  }

  // Find workflow files
  let workflowFiles: string[];
  try {
    workflowFiles = readdirSync(WORKFLOWS_DIR)
      .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map(f => join(WORKFLOWS_DIR, f));
  } catch {
    console.log(`${c.dim}No .github/workflows/ directory found — skipping${c.reset}`);
    return { passed: true, errors: 0, output: '' };
  }

  if (workflowFiles.length === 0) {
    console.log(`${c.dim}No workflow files found in .github/workflows/ — skipping${c.reset}`);
    return { passed: true, errors: 0, output: '' };
  }

  // Run actionlint:
  // - Disable shellcheck integration to avoid style/info noise (SC*:style, SC*:info).
  //   These are advisory suggestions about shell quoting and style, not real bugs.
  //   We only want actionlint's own structural checks (expression injection, type
  //   mismatches, missing wrappers, duplicate IDs, etc.).
  // - Pass absolute paths so error messages are rooted at the repo.
  const absolutePaths = workflowFiles;
  const result = spawnSync(
    'actionlint',
    ['-shellcheck=', '-oneline', ...absolutePaths],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    }
  );

  const output = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
  const exitCode = result.status ?? 1;

  if (result.error) {
    // Spawn error (e.g., command not found after the version check passed — shouldn't happen)
    const errMsg = `Failed to run actionlint: ${result.error.message}`;
    console.log(`${c.red}${errMsg}${c.reset}`);
    return { passed: false, errors: 1, output: errMsg };
  }

  if (exitCode === 0) {
    console.log(`${c.green}actionlint: all ${workflowFiles.length} workflow files are valid${c.reset}`);
    return { passed: true, errors: 0, output: '' };
  }

  // Count distinct errors (one per line in -oneline mode)
  const errorLines = output.split('\n').filter(l => l.trim().length > 0);
  const errorCount = errorLines.length;

  console.log(`${c.red}actionlint found ${errorCount} error(s) in GitHub Actions workflow files:${c.reset}\n`);
  for (const line of errorLines) {
    // Shorten absolute paths to repo-relative for readability
    const displayLine = line.replace(PROJECT_ROOT + '/', '');
    console.log(`  ${c.red}${displayLine}${c.reset}`);
  }
  console.log();
  console.log(`${c.dim}Fix: address the errors above or add to .github/actionlint.yaml to suppress false positives.${c.reset}`);
  console.log(`${c.dim}Docs: https://github.com/rhysd/actionlint/blob/main/docs/checks.md${c.reset}`);

  return { passed: false, errors: errorCount, output };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
