/**
 * Conflict Resolution Orchestration
 *
 * Replaces the shell logic from `.github/workflows/resolve-conflicts.yml`.
 * The Tier 1 Sonnet resolver (`.github/scripts/resolve-conflicts.mjs`) stays
 * unchanged — this module handles everything around it:
 *
 *   1. Find conflicted PRs (with retry for lazy GitHub mergeable state)
 *   2. Fingerprint check (skip already-attempted SHA combinations)
 *   3. Tier 1: run resolve-conflicts.mjs --no-push
 *   4. Post-resolution safety: conflict markers, TypeScript, auto-fix, gate
 *   5. Tier 2: Claude Code CLI for agentic escalation
 *   6. Commit, push, and comment
 *
 * Sequential PR processing (no parallelism) to avoid push races.
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { githubApi, REPO } from './github.ts';

// ── Types ────────────────────────────────────────────────────────────────

export interface ConflictedPr {
  number: number;
  branch: string;
}

export interface ResolutionResult {
  number: number;
  branch: string;
  status:
    | 'resolved'
    | 'skipped-fingerprint'
    | 'tier1-failed'
    | 'tier2-failed'
    | 'push-failed';
  tier?: 1 | 2;
  fingerprint: string;
}

// ── Git helpers ──────────────────────────────────────────────────────────

/** Shell-free git execution (matches resolve-conflicts.mjs pattern). */
function git(...args: string[]): string {
  const display = `$ git ${args.join(' ')}`;
  console.log(display);
  return execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function gitSafe(
  ...args: string[]
): { ok: true; output: string } | { ok: false; output: string; stderr: string; code: number | null } {
  try {
    return { ok: true, output: git(...args) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number | null };
    return {
      ok: false,
      output: err.stdout || '',
      stderr: err.stderr || '',
      code: err.status ?? null,
    };
  }
}

// ── Finding Conflicted PRs ───────────────────────────────────────────────

interface GitHubPrListItem {
  number: number;
  headRefName: string;
  mergeable: string;
  isDraft: boolean;
}

/**
 * Find all open, non-draft PRs with merge conflicts.
 *
 * GitHub computes mergeable state lazily — newly opened PRs may show
 * "unknown" for a few seconds. Retries up to `maxRetries` times with
 * a 10s delay so we don't miss freshly-conflicted PRs.
 *
 * Uses the REST API which returns `mergeable_state` with values:
 *   "dirty"   = has conflicts (GraphQL: CONFLICTING)
 *   "unknown" = not yet computed (GraphQL: UNKNOWN)
 *   "clean"   = no conflicts (GraphQL: MERGEABLE)
 */
export async function findConflictedPrs(
  maxRetries = 3,
): Promise<ConflictedPr[]> {
  let allPrs: GitHubPrListItem[] = [];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Use the REST API to list open PRs targeting main
    const rawPrs = await githubApi<Array<{
      number: number;
      head: { ref: string };
      draft: boolean;
      mergeable_state: string;
    }>>(`/repos/${REPO}/pulls?state=open&base=main&per_page=100`);

    allPrs = rawPrs.map((pr) => ({
      number: pr.number,
      headRefName: pr.head.ref,
      // REST API returns lowercase: "dirty", "unknown", "clean", etc.
      mergeable: pr.mergeable_state.toLowerCase(),
      isDraft: pr.draft,
    }));

    const unknownCount = allPrs.filter(
      (pr) => !pr.isDraft && pr.mergeable === 'unknown',
    ).length;

    if (unknownCount === 0 || attempt === maxRetries) {
      break;
    }

    console.log(
      `Attempt ${attempt}: ${unknownCount} PR(s) have unknown mergeable state — waiting 10s for GitHub to compute...`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  // REST API "dirty" = has merge conflicts
  return allPrs
    .filter((pr) => !pr.isDraft && pr.mergeable === 'dirty')
    .map((pr) => ({ number: pr.number, branch: pr.headRefName }));
}

// ── Fingerprint ──────────────────────────────────────────────────────────

/**
 * Compute a fingerprint for this PR+main SHA combination and check if
 * it was already attempted by searching PR comments.
 *
 * Fingerprint format: `${PR_SHA:0:8}+${MAIN_SHA:0:8}`
 */
export async function checkFingerprint(
  prNumber: number,
  branch: string,
): Promise<{ skip: boolean; fingerprint: string }> {
  git('fetch', 'origin', 'main');
  git('fetch', 'origin', branch);

  const mainSha = git('rev-parse', 'origin/main').trim();
  const prSha = git('rev-parse', `origin/${branch}`).trim();
  const fingerprint = `${prSha.slice(0, 8)}+${mainSha.slice(0, 8)}`;

  console.log(
    `Fingerprint: ${fingerprint} (PR ${prSha.slice(0, 8)}, main ${mainSha.slice(0, 8)})`,
  );

  // Search PR comments for this fingerprint
  try {
    const comments = await githubApi<Array<{ body: string }>>(
      `/repos/${REPO}/issues/${prNumber}/comments?per_page=100`,
    );

    const already = comments.some((c) =>
      c.body.includes(`fingerprint: \`${fingerprint}\``),
    );

    if (already) {
      console.log(
        `Skipping PR #${prNumber} — already attempted for fingerprint ${fingerprint} (same branch+main SHAs). Will retry when either branch is updated.`,
      );
      return { skip: true, fingerprint };
    }
  } catch (e: unknown) {
    // If we can't check comments, proceed anyway
    console.warn(
      `Failed to check fingerprint comments: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { skip: false, fingerprint };
}

// ── Conflict Marker Scan ─────────────────────────────────────────────────

/**
 * Scan files for residual conflict markers (<<<<<<< etc).
 * Returns list of files that still contain markers.
 */
export function scanConflictMarkers(files: string[]): string[] {
  const filesWithMarkers: string[] = [];

  for (const file of files) {
    if (!existsSync(file)) continue;

    try {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      const hasMarkers = lines.some((line) =>
        /^(<<<<<<<|=======|>>>>>>>)/.test(line),
      );
      if (hasMarkers) {
        filesWithMarkers.push(file);
      }
    } catch {
      // File unreadable — skip
    }
  }

  return filesWithMarkers;
}

// ── TypeScript Compilation Check ─────────────────────────────────────────

interface TscResult {
  ok: boolean;
  errors: string;
}

/**
 * Run TypeScript compilation check in each directory that has changed TS/TSX files.
 */
export function checkTypeScript(changedFiles: string[]): TscResult {
  const tsFiles = changedFiles.filter((f) => /\.(ts|tsx)$/.test(f));

  if (tsFiles.length === 0) {
    console.log('No TypeScript files changed — skipping tsc.');
    return { ok: true, errors: '' };
  }

  console.log('TypeScript files changed:');
  for (const f of tsFiles) {
    console.log(`  ${f}`);
  }

  let failed = false;
  let allErrors = '';

  // Always check apps/web (most TS files live here)
  const dirs: Array<{ name: string; check: boolean }> = [
    { name: 'apps/web', check: true },
    {
      name: 'apps/wiki-server',
      check: tsFiles.some((f) => f.startsWith('apps/wiki-server/')),
    },
    { name: 'crux', check: tsFiles.some((f) => f.startsWith('crux/')) },
  ];

  for (const dir of dirs) {
    if (!dir.check) continue;

    console.log(`Running tsc in ${dir.name}...`);
    try {
      execFileSync('npx', ['tsc', '--noEmit'], {
        encoding: 'utf-8',
        cwd: dir.name,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`TypeScript compilation passed in ${dir.name}.`);
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string };
      const output = (err.stdout || '') + (err.stderr || '');
      console.error(`TypeScript compilation failed in ${dir.name}`);
      console.error(output);
      failed = true;
      allErrors += `\n--- ${dir.name} ---\n${output}`;
    }
  }

  return { ok: !failed, errors: allErrors };
}

// ── Auto-fixers ──────────────────────────────────────────────────────────

function runAutoFixers(): void {
  console.log('Running auto-fix for MDX escaping and markdown formatting...');

  try {
    execFileSync('pnpm', ['crux', 'fix', 'escaping'], {
      encoding: 'utf-8',
      stdio: 'inherit',
    });
  } catch {
    // Auto-fix is best-effort — continue even if it fails
    console.warn('crux fix escaping failed — continuing');
  }

  try {
    execFileSync('pnpm', ['crux', 'fix', 'markdown'], {
      encoding: 'utf-8',
      stdio: 'inherit',
    });
  } catch {
    // Auto-fix is best-effort — continue even if it fails
    console.warn('crux fix markdown failed — continuing');
  }
}

// ── Validation Gate ──────────────────────────────────────────────────────

interface GateResult {
  ok: boolean;
  output: string;
  /** Last 80 lines for diagnostics in PR comments */
  tail: string;
}

function runGate(): GateResult {
  console.log('Running post-resolution validation gate (with auto-fix)...');

  try {
    const output = execFileSync('pnpm', ['crux', 'validate', 'gate', '--fix'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(output);
    const lines = output.split('\n');
    const tail = lines.slice(-80).join('\n');
    return { ok: true, output, tail };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    const output = (err.stdout || '') + (err.stderr || '');
    console.log(output);
    const lines = output.split('\n');
    const tail = lines.slice(-80).join('\n');
    return { ok: false, output, tail };
  }
}

// ── Tier 1: Sonnet API Resolution ────────────────────────────────────────

export interface Tier1Result {
  ok: boolean;
  mergeAffectedFiles: string[];
  gateOutput?: string;
  diagnosticSummary?: string;
}

/**
 * Run Tier 1 resolution:
 * 1. Checkout PR branch, run resolve-conflicts.mjs --no-push
 * 2. Record merge-affected files
 * 3. Scan for conflict markers
 * 4. TypeScript compilation check
 * 5. Auto-fix escaping and markdown
 * 6. Validate gate
 */
export async function runTier1(pr: ConflictedPr): Promise<Tier1Result> {
  // Configure git identity for commit operations
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', 'github-actions[bot]@users.noreply.github.com');

  // Fetch and checkout the PR branch
  git('fetch', 'origin', 'main');
  git('fetch', 'origin', pr.branch);
  git('checkout', `origin/${pr.branch}`);

  // Run the Sonnet conflict resolver
  console.log(`\nRunning Tier 1 (Sonnet) conflict resolution for PR #${pr.number}...\n`);

  // Set env vars expected by resolve-conflicts.mjs
  const resolveEnv = {
    ...process.env,
    PR_BRANCH: pr.branch,
    PR_NUMBER: String(pr.number),
  };

  try {
    execFileSync(
      'node',
      ['.github/scripts/resolve-conflicts.mjs', '--no-push'],
      {
        encoding: 'utf-8',
        stdio: 'inherit',
        env: resolveEnv,
      },
    );
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    const diagnostic = (err.stdout || '') + (err.stderr || '');
    console.error('Tier 1 resolve-conflicts.mjs failed.');
    return {
      ok: false,
      mergeAffectedFiles: [],
      diagnosticSummary: diagnostic.slice(-500),
    };
  }

  // Record merge-affected files (from the merge commit)
  const mergeFilesOutput = gitSafe('diff', '--name-only', 'HEAD~1', 'HEAD');
  const mergeAffectedFiles = mergeFilesOutput.ok
    ? mergeFilesOutput.output
        .trim()
        .split('\n')
        .filter(Boolean)
    : [];

  console.log('Merge-affected files:');
  for (const f of mergeAffectedFiles) {
    console.log(`  ${f}`);
  }

  // Scan for conflict markers in committed files
  const markerFiles = scanConflictMarkers(mergeAffectedFiles);
  if (markerFiles.length > 0) {
    console.error(
      'Residual conflict markers detected in:',
      markerFiles.join(', '),
    );
    return {
      ok: false,
      mergeAffectedFiles,
      diagnosticSummary: `Conflict markers remain in: ${markerFiles.join(', ')}`,
    };
  }

  // Also scan staged files
  const stagedOutput = gitSafe('diff', '--name-only', '--cached');
  const stagedFiles = stagedOutput.ok
    ? stagedOutput.output.trim().split('\n').filter(Boolean)
    : [];
  const stagedMarkers = scanConflictMarkers(stagedFiles);
  if (stagedMarkers.length > 0) {
    console.error(
      'Residual conflict markers in staged files:',
      stagedMarkers.join(', '),
    );
    return {
      ok: false,
      mergeAffectedFiles,
      diagnosticSummary: `Conflict markers in staged files: ${stagedMarkers.join(', ')}`,
    };
  }

  console.log('No conflict markers found — clean.');

  // TypeScript compilation check
  const tscResult = checkTypeScript(mergeAffectedFiles);
  if (!tscResult.ok) {
    console.error('TypeScript compilation failed after conflict resolution');
    // Don't return failure here — auto-fixers and gate may resolve it, or Tier 2 will handle
  }

  // Auto-fix escaping and markdown
  runAutoFixers();

  // Skip gate if conflict markers or TypeScript failed
  if (!tscResult.ok) {
    return {
      ok: false,
      mergeAffectedFiles,
      gateOutput: tscResult.errors,
      diagnosticSummary: 'TypeScript compilation failed',
    };
  }

  // Validation gate
  const gate = runGate();

  if (gate.ok) {
    console.log('Tier 1 validation passed — safe to push.');
  } else {
    console.warn(
      'Tier 1 validation failed — will escalate to Tier 2 (Claude Code).',
    );
  }

  return {
    ok: gate.ok,
    mergeAffectedFiles,
    gateOutput: gate.tail,
  };
}

// ── Tier 2: Claude Code CLI ──────────────────────────────────────────────

/**
 * Restrict agent changes to merge-affected files only.
 *
 * Security: the agent runs with --dangerously-skip-permissions and could
 * modify anything. Only allow changes to files from the original merge.
 * Reverts unauthorized changes.
 */
export function restrictToMergeFiles(
  mergeAffectedFiles: string[],
): { reverted: string[] } {
  // Get current changed files (unstaged + staged + untracked)
  const unstagedResult = gitSafe('diff', '--name-only');
  const stagedResult = gitSafe('diff', '--name-only', '--cached');

  const allChanged = new Set<string>();
  if (unstagedResult.ok) {
    for (const f of unstagedResult.output.trim().split('\n').filter(Boolean)) {
      allChanged.add(f);
    }
  }
  if (stagedResult.ok) {
    for (const f of stagedResult.output.trim().split('\n').filter(Boolean)) {
      allChanged.add(f);
    }
  }

  // Also check for untracked files
  const untrackedResult = gitSafe(
    'ls-files',
    '--others',
    '--exclude-standard',
  );
  if (untrackedResult.ok) {
    for (const f of untrackedResult.output.trim().split('\n').filter(Boolean)) {
      allChanged.add(f);
    }
  }

  const allowedSet = new Set(mergeAffectedFiles);
  const reverted: string[] = [];

  for (const file of allChanged) {
    if (!allowedSet.has(file)) {
      console.warn(`Reverting unauthorized agent change: ${file}`);
      // Try to restore from HEAD
      const checkout = gitSafe('checkout', 'HEAD', '--', file);
      if (!checkout.ok) {
        // File is newly created — unstage and remove
        gitSafe('reset', 'HEAD', '--', file);
        gitSafe('clean', '-f', '--', file);
      }
      reverted.push(file);
    }
  }

  if (reverted.length > 0) {
    console.log(`Reverted unauthorized changes to: ${reverted.join(', ')}`);
  } else {
    console.log('All agent changes are within the merge-affected file set.');
  }

  return { reverted };
}

export interface Tier2Result {
  ok: boolean;
  gateOutput?: string;
}

/**
 * Run Tier 2 resolution using Claude Code CLI.
 *
 * Only runs when Tier 1 resolved conflicts (merge committed) but gate
 * validation failed. The agent gets the gate output as context and tries
 * to fix the issues.
 */
export async function runTier2(
  pr: ConflictedPr,
  gateOutput: string,
  mergeAffectedFiles: string[],
): Promise<Tier2Result> {
  console.log('Escalating to Claude Code for agentic conflict resolution...');

  // Build prompt with validation error context
  const prompt = `The automated conflict resolution system merged main into this PR branch and
resolved all git conflict markers using Sonnet, but the post-merge validation
failed. Your job is to fix the files so validation passes.

Validation error output:
${gateOutput}

Instructions:
1. Read the failing files to understand what went wrong
2. Fix the issues — common causes after conflict resolution include:
   - YAML files with inconsistent ID formats (mixing slug IDs with hex-hash IDs)
   - TypeScript/JS files with type errors from combining incompatible changes
   - Build-data failures from mismatched entity/fact references between files
   - MDX files with broken EntityLink references
   - Numeric ID conflicts: if two entities/pages claim the same numericId, fix by
     giving one of them a unique ID. IDs are allocated by the wiki server.
   - Unescaped dollar signs in MDX files (e.g. "$100" should be "\\$100")
   - Deprecated frontmatter fields (e.g. "importance" should be "readerImportance")
3. Run auto-fixers first: pnpm crux fix escaping && pnpm crux fix markdown
4. After fixing, verify by running: pnpm crux validate gate --fix
5. Only fix what's needed to pass validation — do not make unrelated changes
6. Stage your changes with git add but do NOT commit or push`;

  try {
    execFileSync(
      'claude',
      [
        '-p',
        prompt,
        '--model',
        'sonnet',
        '--max-turns',
        '10',
        '--dangerously-skip-permissions',
        '--verbose',
      ],
      {
        encoding: 'utf-8',
        stdio: 'inherit',
        timeout: 10 * 60 * 1000, // 10 minute timeout
      },
    );
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    console.error('Tier 2 Claude Code agent failed:', (err.stderr || err.stdout || '').slice(-300));
    return { ok: false };
  }

  // Restrict agent changes to merge-affected files only
  restrictToMergeFiles(mergeAffectedFiles);

  // Re-validate gate
  const gate = runGate();

  if (gate.ok) {
    console.log('Tier 2 validation passed — safe to push.');
  } else {
    console.error('Tier 2 validation also failed — manual resolution needed.');
  }

  return { ok: gate.ok, gateOutput: gate.tail };
}

// ── Commit, Push, and Comment ────────────────────────────────────────────

/**
 * Commit auto-fix changes (if any), staging only merge-affected files.
 */
function commitChanges(
  mergeAffectedFiles: string[],
  tier: 1 | 2,
): boolean {
  // Check if there are any changes to commit
  const unstagedResult = gitSafe('diff', '--quiet');
  const stagedResult = gitSafe('diff', '--cached', '--quiet');

  if (unstagedResult.ok && stagedResult.ok) {
    console.log('No auto-fix changes — merge commit is clean.');
    return false;
  }

  console.log('Auto-fix produced changes — committing fixes...');

  // Stage only files that were part of the original merge
  const allowedSet = new Set(mergeAffectedFiles);
  const changedResult = gitSafe('diff', '--name-only');
  if (changedResult.ok) {
    for (const file of changedResult.output.trim().split('\n').filter(Boolean)) {
      if (allowedSet.has(file)) {
        git('add', '--', file);
      } else {
        console.warn(`Skipping unexpected modified file: ${file}`);
      }
    }
  }

  const tierName = tier === 1 ? 'Sonnet' : 'Claude Code';
  gitSafe('commit', '-m', `Auto-fix after conflict resolution (${tierName})`);
  return true;
}

/**
 * Push resolved merge with retry (up to 3 attempts).
 */
function pushWithRetry(branch: string, maxAttempts = 3): boolean {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = gitSafe('push', 'origin', branch);
    if (result.ok) {
      console.log('Pushed successfully.');
      return true;
    }

    console.warn(
      `Push attempt ${attempt} failed — retrying in ${attempt * 2}s...`,
    );

    // Synchronous sleep for retry delay
    execFileSync('sleep', [String(attempt * 2)]);
  }

  console.error(`Push failed after ${maxAttempts} attempts`);
  return false;
}

/**
 * Post a success or failure comment on the PR.
 */
export async function postResolutionComment(
  pr: ConflictedPr,
  result: ResolutionResult,
  context: {
    fingerprint: string;
    runUrl?: string;
    gateOutput?: string;
    tier1GateOutput?: string;
    tier2GateOutput?: string;
    diagnosticSummary?: string;
    agenticOutcome?: 'success' | 'failure' | 'skipped';
    resolveOutcome?: 'success' | 'failure';
  },
): Promise<void> {
  let body: string;

  if (result.status === 'resolved') {
    const tierLabel =
      result.tier === 1 ? 'Tier 1 (Sonnet)' : 'Tier 2 (Claude Code)';
    body = `Merge conflicts with \`main\` were automatically resolved by the conflict resolver (${tierLabel}). Please review the merge commit to ensure correctness.`;
  } else {
    // Failure comment
    if (context.resolveOutcome === 'failure') {
      body =
        'Automatic conflict resolution failed for this PR. The Sonnet conflict resolver could not merge the files.';
    } else {
      body =
        'Automatic conflict resolution failed for this PR (both Tier 1 Sonnet and Tier 2 Claude Code).';
    }
    body += ' Manual resolution is needed.';

    if (context.diagnosticSummary) {
      body += `\n\n**Resolution diagnostics:**\n${context.diagnosticSummary}`;
    }

    if (context.tier1GateOutput) {
      body +=
        `\n\n<details>\n<summary>Tier 1 (Sonnet) validation output</summary>\n\n\`\`\`\n${context.tier1GateOutput}\n\`\`\`\n\n</details>`;
    }

    if (context.agenticOutcome === 'success' && context.tier2GateOutput) {
      body +=
        `\n\n<details>\n<summary>Tier 2 (Claude Code) validation output</summary>\n\n\`\`\`\n${context.tier2GateOutput}\n\`\`\`\n\n</details>`;
    } else if (context.agenticOutcome === 'failure') {
      body +=
        '\n\n**Tier 2 (Claude Code):** Agent failed to produce a fix.';
    }

    if (context.runUrl) {
      body += `\n\n[View workflow logs](${context.runUrl})`;
    }

    body += `\n\n<!-- fingerprint: \`${context.fingerprint}\` -->`;
  }

  await githubApi(`/repos/${REPO}/issues/${pr.number}/comments`, {
    method: 'POST',
    body: { body },
  });
}

// ── Full Single-PR Pipeline ──────────────────────────────────────────────

/**
 * Full resolution pipeline for a single PR.
 */
export async function resolveConflictsForPr(
  pr: ConflictedPr,
): Promise<ResolutionResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Resolving conflicts for PR #${pr.number} (${pr.branch})`);
  console.log(`${'='.repeat(60)}\n`);

  // Step 1: Fingerprint check
  const { skip, fingerprint } = await checkFingerprint(pr.number, pr.branch);
  if (skip) {
    return {
      number: pr.number,
      branch: pr.branch,
      status: 'skipped-fingerprint',
      fingerprint,
    };
  }

  // Step 2: Tier 1 resolution
  const tier1 = await runTier1(pr);

  if (tier1.mergeAffectedFiles.length === 0 && !tier1.ok) {
    // Resolve script itself failed — the merge was aborted
    await postResolutionComment(pr, {
      number: pr.number,
      branch: pr.branch,
      status: 'tier1-failed',
      tier: 1,
      fingerprint,
    }, {
      fingerprint,
      runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
      diagnosticSummary: tier1.diagnosticSummary,
      resolveOutcome: 'failure',
      agenticOutcome: 'skipped',
    });

    return {
      number: pr.number,
      branch: pr.branch,
      status: 'tier1-failed',
      tier: 1,
      fingerprint,
    };
  }

  if (tier1.ok) {
    // Tier 1 passed — commit and push
    commitChanges(tier1.mergeAffectedFiles, 1);

    const pushed = pushWithRetry(pr.branch);
    if (!pushed) {
      return {
        number: pr.number,
        branch: pr.branch,
        status: 'push-failed',
        tier: 1,
        fingerprint,
      };
    }

    await postResolutionComment(pr, {
      number: pr.number,
      branch: pr.branch,
      status: 'resolved',
      tier: 1,
      fingerprint,
    }, { fingerprint });

    return {
      number: pr.number,
      branch: pr.branch,
      status: 'resolved',
      tier: 1,
      fingerprint,
    };
  }

  // Step 3: Tier 2 — Claude Code CLI escalation
  // Only runs if Tier 1 resolved conflicts (merge committed) but validation failed.
  const tier2 = await runTier2(pr, tier1.gateOutput || '', tier1.mergeAffectedFiles);

  if (tier2.ok) {
    commitChanges(tier1.mergeAffectedFiles, 2);

    const pushed = pushWithRetry(pr.branch);
    if (!pushed) {
      return {
        number: pr.number,
        branch: pr.branch,
        status: 'push-failed',
        tier: 2,
        fingerprint,
      };
    }

    await postResolutionComment(pr, {
      number: pr.number,
      branch: pr.branch,
      status: 'resolved',
      tier: 2,
      fingerprint,
    }, { fingerprint });

    return {
      number: pr.number,
      branch: pr.branch,
      status: 'resolved',
      tier: 2,
      fingerprint,
    };
  }

  // Both tiers failed
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;

  await postResolutionComment(pr, {
    number: pr.number,
    branch: pr.branch,
    status: 'tier2-failed',
    tier: 2,
    fingerprint,
  }, {
    fingerprint,
    runUrl,
    tier1GateOutput: tier1.gateOutput,
    tier2GateOutput: tier2.gateOutput,
    diagnosticSummary: tier1.diagnosticSummary,
    resolveOutcome: 'success',
    agenticOutcome: tier2.ok ? 'success' : 'failure',
  });

  return {
    number: pr.number,
    branch: pr.branch,
    status: 'tier2-failed',
    tier: 2,
    fingerprint,
  };
}

// ── Entry Point ──────────────────────────────────────────────────────────

/**
 * Entry point: find all conflicted PRs and resolve sequentially.
 */
export async function resolveAllConflicts(options: {
  verbose?: boolean;
}): Promise<{ results: ResolutionResult[]; failed: number }> {
  console.log('Finding conflicted PRs...\n');

  const prs = await findConflictedPrs();

  if (prs.length === 0) {
    console.log('No conflicted PRs found.');
    return { results: [], failed: 0 };
  }

  console.log(`Found ${prs.length} conflicted PR(s):`);
  for (const pr of prs) {
    console.log(`  PR #${pr.number} (${pr.branch})`);
  }
  console.log('');

  const results: ResolutionResult[] = [];

  // Process sequentially to avoid push races
  for (const pr of prs) {
    try {
      const result = await resolveConflictsForPr(pr);
      results.push(result);
    } catch (e: unknown) {
      console.error(
        `Unexpected error resolving PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}`,
      );
      results.push({
        number: pr.number,
        branch: pr.branch,
        status: 'tier1-failed',
        fingerprint: 'error',
      });
    }
  }

  const failed = results.filter(
    (r) =>
      r.status !== 'resolved' && r.status !== 'skipped-fingerprint',
  ).length;

  return { results, failed };
}
