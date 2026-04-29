#!/usr/bin/env node

/**
 * Validate that every `${{ secrets.NAME }}` reference in .github/workflows/*.yml
 * resolves to a real GitHub secret (repo-level or org-inherited).
 *
 * Background: QUA-676 (PR #4581). PR #4559 plumbed
 * `LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}` into three workflows, but
 * the repo secret `LINEAR_API_KEY` did not exist. The reference silently
 * resolved to empty string for 4 days, which broke Linear-side dedup and
 * caused a duplicate-issue cascade.
 *
 * A YAML reference to a non-existent secret is silently truthy at parse
 * time and produces no signal anywhere — until something downstream notices
 * the value is empty (often days later).
 *
 * Usage: npx tsx crux/validate/validate-workflow-secrets.ts
 *
 * Fail-open conditions (exit 0 with a warning):
 *   - `gh` CLI not installed
 *   - `gh` not authenticated
 *   - `gh secret list` returns a network/permission error
 *
 * These are the same fail-open shape as `assign-ids` and other gate steps
 * that depend on external services. The CI environment runs with
 * GITHUB_TOKEN and full secret-list permission, so the check is effective
 * there; local/fork environments without auth get an advisory pass.
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const WORKFLOWS_DIR = join(PROJECT_ROOT, '.github/workflows');

/**
 * Secrets that are auto-provided by GitHub Actions and never need to be
 * configured manually. Excluding them from the check.
 */
const AUTO_PROVIDED_SECRETS = new Set<string>([
  'GITHUB_TOKEN',
]);

/** Regex matches `${{ secrets.NAME }}` with optional whitespace. */
const SECRET_REF_RE = /\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g;

export interface SecretRef {
  /** Workflow file path relative to PROJECT_ROOT. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Secret name (e.g. "LINEAR_API_KEY"). */
  name: string;
}

export interface CheckResult {
  passed: boolean;
  errors: number;
  violations: SecretRef[];
  /** Whether the check ran (false = fail-open, gh unavailable). */
  checked: boolean;
  /** Human-readable reason when checked=false. */
  skipReason?: string;
}

/**
 * Pure function: scan workflow file contents for secrets references.
 * Exported for testing.
 */
export function findSecretRefs(
  files: Array<{ path: string; content: string }>,
): SecretRef[] {
  const refs: SecretRef[] = [];
  for (const { path, content } of files) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Reset lastIndex for global regex on each line.
      SECRET_REF_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SECRET_REF_RE.exec(line)) !== null) {
        const name = m[1];
        if (AUTO_PROVIDED_SECRETS.has(name)) continue;
        refs.push({ file: path, line: i + 1, name });
      }
    }
  }
  return refs;
}

/**
 * Pure function: given a set of refs and the set of known-good secret
 * names, return the refs that don't resolve.
 * Exported for testing.
 */
export function findMissingSecrets(
  refs: SecretRef[],
  knownSecrets: Set<string>,
): SecretRef[] {
  return refs.filter((r) => !knownSecrets.has(r.name));
}

function readWorkflowFiles(): Array<{ path: string; content: string }> {
  let entries: string[];
  try {
    entries = readdirSync(WORKFLOWS_DIR);
  } catch {
    return [];
  }
  const out: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;
    const full = join(WORKFLOWS_DIR, entry);
    let content: string;
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    out.push({ path: relative(PROJECT_ROOT, full), content });
  }
  return out;
}

/**
 * Read repo + inherited secret names via `gh secret list`. Returns null on
 * any error (fail-open).
 */
function fetchKnownSecrets(repo: string): { secrets: Set<string>; reason?: string } | null {
  // Runs `gh secret list` once for repo-scoped secrets and once with
  // --include-inherited for org-level. The union is what the workflows
  // actually see at runtime.
  const sets: Set<string> = new Set();
  for (const args of [
    ['secret', 'list', '-R', repo, '--json', 'name'],
    ['secret', 'list', '-R', repo, '--include-inherited', '--json', 'name'],
  ]) {
    let raw: string;
    try {
      raw = execSync(`gh ${args.map((a) => `'${a}'`).join(' ')}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // --include-inherited may not be supported on older gh versions, or
      // the user/CI may lack org-level read. Fall through if the
      // repo-scoped call already gave us names.
      if (sets.size > 0) continue;
      const msg = err instanceof Error ? err.message : String(err);
      return { secrets: sets, reason: `gh secret list failed: ${msg.split('\n')[0]}` };
    }
    let parsed: Array<{ name: string }>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const item of parsed) {
      if (item && typeof item.name === 'string') sets.add(item.name);
    }
  }
  return { secrets: sets };
}

function ghAvailable(): { ok: boolean; reason?: string } {
  try {
    execSync('gh --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return { ok: false, reason: 'gh CLI not installed' };
  }
  try {
    execSync('gh auth status', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return { ok: false, reason: 'gh CLI not authenticated' };
  }
  return { ok: true };
}

const DEFAULT_REPO = 'quantified-uncertainty/longterm-wiki';

export function runCheck(opts: { repo?: string } = {}): CheckResult {
  const c = getColors();
  const repo = opts.repo ?? DEFAULT_REPO;

  console.log(`${c.blue}Checking workflow secret references against ${repo}...${c.reset}\n`);

  const files = readWorkflowFiles();
  if (files.length === 0) {
    console.log(`${c.dim}No workflow files found.${c.reset}`);
    return { passed: true, errors: 0, violations: [], checked: true };
  }

  const refs = findSecretRefs(files);
  if (refs.length === 0) {
    console.log(`${c.dim}No secret references found in ${files.length} workflow(s).${c.reset}`);
    return { passed: true, errors: 0, violations: [], checked: true };
  }

  const gh = ghAvailable();
  if (!gh.ok) {
    console.log(`${c.yellow}⚠ Skipping: ${gh.reason}.${c.reset}`);
    console.log(`${c.dim}  This check needs gh CLI auth to read the repo secret list.${c.reset}`);
    return { passed: true, errors: 0, violations: [], checked: false, skipReason: gh.reason };
  }

  const fetched = fetchKnownSecrets(repo);
  if (!fetched) {
    console.log(`${c.yellow}⚠ Skipping: gh secret list unavailable.${c.reset}`);
    return {
      passed: true,
      errors: 0,
      violations: [],
      checked: false,
      skipReason: 'gh secret list unavailable',
    };
  }

  const missing = findMissingSecrets(refs, fetched.secrets);

  if (missing.length === 0) {
    console.log(
      `${c.green}All ${refs.length} secret reference(s) resolve to a known secret (${fetched.secrets.size} secrets visible).${c.reset}`,
    );
    return { passed: true, errors: 0, violations: [], checked: true };
  }

  console.log(`${c.red}Found ${missing.length} workflow secret reference(s) with no matching repo/inherited secret:${c.reset}\n`);
  // Group by secret name for readability.
  const byName = new Map<string, SecretRef[]>();
  for (const r of missing) {
    const arr = byName.get(r.name) ?? [];
    arr.push(r);
    byName.set(r.name, arr);
  }
  for (const [name, occurrences] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${c.red}secrets.${name}${c.reset} (${occurrences.length} reference${occurrences.length === 1 ? '' : 's'})`);
    for (const r of occurrences) {
      console.log(`    ${c.dim}${r.file}:${r.line}${c.reset}`);
    }
  }
  console.log(`\n${c.dim}Fix: add the secret with \`gh secret set <NAME> -R ${repo}\`,`);
  console.log(`     or remove the reference from the workflow if it's no longer needed.${c.reset}`);

  return { passed: false, errors: missing.length, violations: missing, checked: true };
}

if (process.argv[1]?.includes('validate-workflow-secrets')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
