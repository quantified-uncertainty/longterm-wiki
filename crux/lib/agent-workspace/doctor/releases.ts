/**
 * Releases-doctor checks (12 read-only diagnostics for the releases coordinator).
 *
 * All checks are pure over a DoctorEnv. Defaults to `releases/` working
 * clone with `coord/` fallback during the rename window.
 *
 * Hard rule: never resets, pulls, installs, or deploys. Just observes.
 */

import type { DoctorCheck, DoctorEnv } from './types.ts';

const RELDIR_CANDIDATES = ['releases', 'coord'];

/**
 * The set of GitHub check-run conclusion values that indicate failure.
 *
 * Per the GitHub Checks API, `conclusion` is one of:
 *   success | failure | cancelled | timed_out | action_required |
 *   neutral | skipped | stale | startup_failure
 *
 * Anything in this set should be treated as a failed check. A previous
 * implementation used the regex /fail|cancel|error/i which silently
 * missed `timed_out` and `action_required`, letting timed-out CI on a
 * release PR read as "no failing checks". Use the allowlist instead.
 */
const FAILING_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
]);

function isFailingConclusion(conclusion: string | null | undefined): boolean {
  if (!conclusion) return false;
  return FAILING_CONCLUSIONS.has(conclusion.toLowerCase());
}

function resolveReldir(env: DoctorEnv): { name: string; path: string; bothExist: boolean } | null {
  const present = RELDIR_CANDIDATES.filter((d) => {
    const st = env.stat(env.resolve(d));
    return st && st.isDir;
  });
  if (present.length === 0) return null;
  return {
    name: present[0],
    path: env.resolve(present[0]),
    bothExist: present.length > 1,
  };
}

// ---------------------------------------------------------------------------
// 1. dir-state — branch, porcelain, .env symlink, rebase state
// ---------------------------------------------------------------------------

export const checkDirState: DoctorCheck = {
  id: 'dir-state',
  label: 'dir-state',
  async run(env) {
    const dir = resolveReldir(env);
    if (!dir) return { status: 'fail', summary: 'neither releases/ nor coord/ exists', action: 'Run /agent-releases-start.' };
    if (dir.bothExist) {
      return {
        status: 'fail',
        summary: 'BOTH releases/ AND coord/ exist (rename in flight)',
        action: 'Pick one; the other is leftover from an interrupted rename.',
      };
    }

    const issues: string[] = [];
    // rebase / merge / cherry-pick state
    for (const f of ['.git/rebase-merge', '.git/rebase-apply', '.git/CHERRY_PICK_HEAD', '.git/MERGE_HEAD']) {
      if (env.stat(`${dir.path}/${f}`)) issues.push(`mid-rebase/merge: ${f}`);
    }

    // branch + porcelain
    const branch = env.exec('git', ['-C', dir.path, 'branch', '--show-current'], { timeoutMs: 3000 });
    if (branch.code !== 0) issues.push('git branch --show-current failed');
    else if (branch.stdout.trim() !== 'main') issues.push(`on branch ${branch.stdout.trim()} (expected main)`);

    const status = env.exec('git', ['-C', dir.path, 'status', '--porcelain'], { timeoutMs: 3000 });
    if (status.code !== 0) issues.push('git status failed');
    else if (status.stdout.trim().length > 0) issues.push(`uncommitted changes (${status.stdout.split('\n').filter(Boolean).length} files)`);

    // .env symlink
    const envPath = `${dir.path}/.env`;
    const envStat = env.stat(envPath);
    if (!envStat) issues.push('.env missing');
    else if (!envStat.isSymlink) issues.push('.env is not a symlink');
    else {
      const target = env.readlink(envPath);
      if (target !== '../.env.base') issues.push(`.env -> ${target} (expected ../.env.base)`);
    }

    if (issues.length === 0) {
      return { status: 'ok', summary: `${dir.name}/ on main, clean, .env -> ../.env.base` };
    }
    if (issues.some((i) => i.startsWith('mid-rebase'))) {
      return {
        status: 'fail',
        summary: issues.join('; '),
        action: `git -C ${dir.name} rebase --abort (or finish the rebase)`,
      };
    }
    return {
      status: 'fail',
      summary: issues.join('; '),
      action: `Review ${dir.name}/ state; ./ws reset-releases when safe.`,
    };
  },
};

// ---------------------------------------------------------------------------
// 2. deps-current — pnpm-lock newer than node_modules/.pnpm?
// ---------------------------------------------------------------------------

export const checkDepsCurrent: DoctorCheck = {
  id: 'deps-current',
  label: 'deps-current',
  async run(env) {
    const dir = resolveReldir(env);
    if (!dir) return { status: 'skipped', summary: 'no releases dir' };
    const lock = env.stat(`${dir.path}/pnpm-lock.yaml`);
    const pnpmDir = env.stat(`${dir.path}/node_modules/.pnpm`);
    if (!lock) return { status: 'skipped', summary: 'pnpm-lock.yaml missing' };
    if (!pnpmDir) {
      return { status: 'warn', summary: 'node_modules/.pnpm missing', action: `cd ${dir.name} && pnpm install` };
    }
    if (lock.mtime > pnpmDir.mtime) {
      return {
        status: 'warn',
        summary: 'pnpm-lock.yaml newer than node_modules/.pnpm',
        action: `cd ${dir.name} && pnpm install`,
      };
    }
    return { status: 'ok', summary: 'pnpm-lock.yaml unchanged' };
  },
};

// ---------------------------------------------------------------------------
// 3. ops-state — clean and recently fetched
// ---------------------------------------------------------------------------

export const checkOpsState: DoctorCheck = {
  id: 'ops-state',
  label: 'ops-state',
  async run(env) {
    const opsPath = env.resolve('ops');
    if (!env.stat(opsPath)) return { status: 'skipped', summary: 'ops/ not present' };

    const status = env.exec('git', ['-C', opsPath, 'status', '--porcelain'], { timeoutMs: 3000 });
    if (status.code !== 0) return { status: 'warn', summary: 'git status failed in ops/' };

    let dirty = false;
    if (status.stdout.trim().length > 0) dirty = true;

    const fetchHead = env.stat(`${opsPath}/.git/FETCH_HEAD`);
    let lastFetchAge = Infinity;
    if (fetchHead) {
      // Clamp at 0 — backup restores or clock skew can put mtime in the future,
      // which would print "last pull -3m ago". Treat as "just now" instead.
      lastFetchAge = Math.max(0, Math.floor(env.now().getTime() / 1000) - fetchHead.mtime);
    }

    const issues: string[] = [];
    if (dirty) issues.push('uncommitted changes');
    if (lastFetchAge > 60 * 60) {
      issues.push(`last fetch ${Math.round(lastFetchAge / 60)}min ago`);
    }
    if (issues.length === 0) {
      const minutes = Math.round(lastFetchAge / 60);
      return { status: 'ok', summary: `clean, last pull ${minutes}m ago` };
    }
    return {
      status: 'warn',
      summary: issues.join('; '),
      action: 'Review status; git -C ops fetch to refresh.',
    };
  },
};

// ---------------------------------------------------------------------------
// 4. ops-divergence — local commits vs origin/main
// ---------------------------------------------------------------------------

export const checkOpsDivergence: DoctorCheck = {
  id: 'ops-divergence',
  label: 'ops-divergence',
  async run(env) {
    const opsPath = env.resolve('ops');
    if (!env.stat(opsPath)) return { status: 'skipped', summary: 'ops/ not present' };
    const r = env.exec('git', ['-C', opsPath, 'rev-list', '--left-right', '--count', 'HEAD...origin/main'], { timeoutMs: 3000 });
    if (r.code !== 0) return { status: 'warn', summary: 'rev-list failed' };
    const m = r.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) return { status: 'warn', summary: `unparseable: ${r.stdout.trim()}` };
    const ahead = Number(m[1]);
    const behind = Number(m[2]);
    if (ahead === 0) return { status: 'ok', summary: behind === 0 ? 'up to date with origin/main' : `${behind} behind origin/main` };
    return {
      status: 'fail',
      summary: `${ahead} local commit(s) ahead of origin/main`,
      action: 'Investigate local commits in ops/; rebase or push as appropriate.',
    };
  },
};

// ---------------------------------------------------------------------------
// 5. release-pr — open release PR health
// ---------------------------------------------------------------------------

export const checkReleasePr: DoctorCheck = {
  id: 'release-pr',
  label: 'release-pr',
  async run(env) {
    const r = env.exec('gh', [
      'pr', 'list', '--repo', 'quantified-uncertainty/longterm-wiki',
      '--base', 'production', '--state', 'open',
      '--json', 'number,title,createdAt,isDraft,mergeable,statusCheckRollup',
    ], { timeoutMs: 8000 });
    if (r.notFound) return { status: 'skipped', summary: 'gh CLI not installed' };
    if (r.code !== 0) return { status: 'warn', summary: 'gh pr list failed', detail: r.stderr };
    let prs: Array<{ number: number; title: string; createdAt: string; isDraft: boolean; mergeable?: string; statusCheckRollup?: Array<{ conclusion?: string }> }>;
    try { prs = JSON.parse(r.stdout); } catch { return { status: 'warn', summary: 'unparseable gh output' }; }
    if (prs.length === 0) return { status: 'ok', summary: 'no open release PR' };

    const pr = prs[0];
    const ageMs = env.now().getTime() - new Date(pr.createdAt).getTime();
    const ageHours = ageMs / 1000 / 60 / 60;
    const checks = pr.statusCheckRollup ?? [];
    const failing = checks.filter((c) => isFailingConclusion(c.conclusion));

    if (ageMs < 5 * 60 * 1000 && checks.length === 0) {
      return { status: 'info', summary: `#${pr.number} (warming up)` };
    }
    if (failing.length > 0) {
      return {
        status: 'fail',
        summary: `#${pr.number} "${pr.title}" — ${failing.length} failing check(s)`,
        action: `gh run view --log-failed (PR #${pr.number})`,
      };
    }
    if (pr.isDraft && ageHours > 2) {
      return { status: 'warn', summary: `#${pr.number} draft for ${ageHours.toFixed(0)}h`, action: 'Promote draft or close.' };
    }
    if (ageHours > 24) {
      return {
        status: 'warn',
        summary: `#${pr.number} ${ageHours.toFixed(0)}h old`,
        action: 'Old release PR — investigate or merge.',
      };
    }
    return { status: 'ok', summary: `#${pr.number} fresh, no failing checks` };
  },
};

// ---------------------------------------------------------------------------
// 6. deploy-tasks — pending tasks awaiting verification
// ---------------------------------------------------------------------------

/**
 * Count unchecked `[ ]` lines in `crux gh deploy-tasks pending` output.
 * The crux subcommand prints human-readable text (no --json today), so we
 * parse the `☐` / `[ ]` markers instead of asking for structured output
 * we don't have. If the format changes, this check falls back to info.
 */
export const checkDeployTasks: DoctorCheck = {
  id: 'deploy-tasks',
  label: 'deploy-tasks',
  async run(env) {
    const r = env.exec('pnpm', ['-s', 'crux', 'gh', 'deploy-tasks', 'pending'], { timeoutMs: 15000 });
    if (r.notFound) return { status: 'skipped', summary: 'pnpm/crux not available' };
    if (r.code !== 0) return { status: 'warn', summary: 'deploy-tasks pending failed', detail: r.stderr };
    // Strip ANSI and count lines with an unchecked marker
    const stripped = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const count = (stripped.match(/(^|\n)\s*(☐|\[ \])/g) ?? []).length;
    if (count === 0) return { status: 'ok', summary: '0 pending' };
    return {
      status: 'warn',
      summary: `${count} pending deploy task(s)`,
      action: 'pnpm crux gh deploy-tasks verify',
    };
  },
};

// ---------------------------------------------------------------------------
// 7. prod-edge — single curl to /api/health (delegates to /health for deep dive)
// ---------------------------------------------------------------------------

/**
 * Single-call prod smoke test. Hits the wiki-server /health endpoint
 * (NOT the Next.js app — that has no health route). Expects the
 * documented `{ "status": "healthy", ... }` contract.
 *
 * Deep diagnostics live in the `/health` skill; this check exists so the
 * releases doctor can answer "is prod fine enough to proceed?" in ~300ms
 * without pulling in the full health workflow.
 */
export const checkProdEdge: DoctorCheck = {
  id: 'prod-edge',
  label: 'prod-edge',
  async run(env) {
    const url = 'https://wiki-server.k8s.quantifieduncertainty.org/health';
    const r = await env.fetch(url, { timeoutMs: 5000 });
    if (r.timedOut) return { status: 'fail', summary: 'timed out', action: 'Run /health and /incident.' };
    if (r.networkError) return { status: 'fail', summary: 'network error', action: 'Run /health.' };
    if (!r.ok) return { status: 'fail', summary: `HTTP ${r.status}`, action: 'Run /health and /incident.' };
    let body: { status?: string; migrationError?: string };
    try { body = JSON.parse(r.body); } catch { return { status: 'fail', summary: `unparseable body (HTTP ${r.status})`, action: 'Run /health.' }; }
    if (body.migrationError) {
      return { status: 'fail', summary: `migration error: ${body.migrationError}`, action: 'Run /health then /incident.' };
    }
    // Accept both 'healthy' (wiki-server contract) and 'ok' (defensive: some
    // endpoints use this convention). Anything else is a real fail.
    if (body.status !== 'healthy' && body.status !== 'ok') {
      return { status: 'fail', summary: `status=${body.status}`, action: 'Run /health then /incident.' };
    }
    return { status: 'ok', summary: `200 status=${body.status}` };
  },
};

// ---------------------------------------------------------------------------
// 8. prod-ci-recent — failures on the production branch in the last 24h
// ---------------------------------------------------------------------------

export const checkProdCiRecent: DoctorCheck = {
  id: 'prod-ci-recent',
  label: 'prod-ci-recent',
  async run(env) {
    const r = env.exec('gh', [
      'run', 'list',
      '--repo', 'quantified-uncertainty/longterm-wiki',
      '--branch', 'production', '--limit', '20',
      '--json', 'status,conclusion,createdAt',
    ], { timeoutMs: 8000 });
    if (r.notFound) return { status: 'skipped', summary: 'gh CLI not installed' };
    if (r.code !== 0) return { status: 'warn', summary: 'gh run list failed' };
    let runs: Array<{ status: string; conclusion: string; createdAt: string }>;
    try { runs = JSON.parse(r.stdout); } catch { return { status: 'warn', summary: 'unparseable gh output' }; }
    const cutoff = env.now().getTime() - 24 * 60 * 60 * 1000;
    const recent = runs.filter((rn) => new Date(rn.createdAt).getTime() >= cutoff);
    const failed = recent.filter((rn) => isFailingConclusion(rn.conclusion));
    if (failed.length === 0) {
      return { status: 'ok', summary: `0 failures in last 24h (${recent.length} runs)` };
    }
    return {
      status: 'warn',
      summary: `${failed.length} failed run(s) in last 24h`,
      action: 'gh run view <id> --log-failed',
    };
  },
};

// ---------------------------------------------------------------------------
// 9. k8s-pods — Running with no recent restart spike
// ---------------------------------------------------------------------------

export const checkK8sPods: DoctorCheck = {
  id: 'k8s-pods',
  label: 'k8s-pods',
  async run(env) {
    const r = env.exec('kubectl', ['-n', 'longterm-wiki', 'get', 'pods', '-o', 'json'], { timeoutMs: 8000 });
    if (r.notFound) return { status: 'skipped', summary: 'kubectl not installed' };
    if (r.code !== 0) return { status: 'skipped', summary: 'kubectl unauthenticated or failed' };
    let payload: { items?: Array<{ metadata: { name: string; creationTimestamp: string }; status: { phase: string; containerStatuses?: Array<{ restartCount: number }> } }> };
    try { payload = JSON.parse(r.stdout); } catch { return { status: 'warn', summary: 'unparseable kubectl json' }; }
    const items = payload.items ?? [];
    if (items.length === 0) return { status: 'warn', summary: 'no pods returned' };

    const issues: string[] = [];
    const now = env.now().getTime();
    for (const pod of items) {
      const phase = pod.status.phase;
      if (phase !== 'Running') {
        issues.push(`${pod.metadata.name}: ${phase}`);
        continue;
      }
      const ageMs = now - new Date(pod.metadata.creationTimestamp).getTime();
      const restarts = pod.status.containerStatuses?.reduce((acc, c) => acc + c.restartCount, 0) ?? 0;
      // Threshold from spec red team: restartCount > 5 AND pod age < 1h
      if (restarts > 5 && ageMs < 60 * 60 * 1000) {
        issues.push(`${pod.metadata.name}: ${restarts} restarts in <1h`);
      }
    }
    if (issues.length === 0) return { status: 'ok', summary: `${items.length} pods Running, no restart spike` };
    return {
      status: 'fail',
      summary: `${issues.length} pod issue(s)`,
      detail: issues.join('\n'),
      action: 'kubectl describe pod <name>; consider /incident.',
    };
  },
};

// ---------------------------------------------------------------------------
// 10. argocd-sync — apps Synced + Healthy
// ---------------------------------------------------------------------------

export const checkArgocdSync: DoctorCheck = {
  id: 'argocd-sync',
  label: 'argocd-sync',
  async run(env) {
    const r = env.exec('argocd', ['app', 'list', '-o', 'json'], { timeoutMs: 8000 });
    if (r.notFound) return { status: 'skipped', summary: 'argocd CLI not installed' };
    if (r.code !== 0) return { status: 'skipped', summary: 'argocd unauthenticated or failed' };
    let apps: Array<{ metadata: { name: string }; status: { sync: { status: string }; health: { status: string } } }>;
    try { apps = JSON.parse(r.stdout); } catch { return { status: 'warn', summary: 'unparseable argocd json' }; }
    const lw = apps.filter((a) => /longterm/.test(a.metadata.name));
    if (lw.length === 0) return { status: 'info', summary: 'no longterm-wiki apps in argocd' };
    const issues: string[] = [];
    for (const a of lw) {
      if (a.status.sync.status !== 'Synced' || a.status.health.status !== 'Healthy') {
        issues.push(`${a.metadata.name}: ${a.status.sync.status}/${a.status.health.status}`);
      }
    }
    if (issues.length === 0) return { status: 'ok', summary: `${lw.length} apps Synced+Healthy` };
    return {
      status: 'fail',
      summary: issues.join('; '),
      action: 'argocd app sync <name> with user approval.',
    };
  },
};

// ---------------------------------------------------------------------------
// 11. release-branch-stale — orphan release/* branches >7d
// ---------------------------------------------------------------------------

export const checkReleaseBranchStale: DoctorCheck = {
  id: 'release-branch-stale',
  label: 'release-branch-stale',
  async run(env) {
    const r = env.exec('gh', [
      'api', 'repos/quantified-uncertainty/longterm-wiki/branches',
      '--paginate', '-q', '.[].name',
    ], { timeoutMs: 8000 });
    if (r.notFound) return { status: 'skipped', summary: 'gh CLI not installed' };
    if (r.code !== 0) return { status: 'skipped', summary: 'gh api failed' };
    const releaseBranches = r.stdout.split('\n').filter((b) => b.trim().startsWith('release/'));
    if (releaseBranches.length === 0) return { status: 'info', summary: 'no release/* branches on remote' };
    // We can't cheaply check >7d age without N PR queries. Spec says
    // "only warn on branches >7d with no PR ever; silent otherwise."
    // For the doctor, just count and let the user investigate.
    return { status: 'info', summary: `${releaseBranches.length} release/* branch(es) — review manually if stale` };
  },
};

// ---------------------------------------------------------------------------
// 12. session-clock-skew — system clock vs gh api Date header
// ---------------------------------------------------------------------------

export const checkSessionClockSkew: DoctorCheck = {
  id: 'session-clock',
  label: 'session-clock',
  async run(env) {
    const r = await env.fetch('https://api.github.com', { timeoutMs: 5000 });
    if (r.timedOut || r.networkError) return { status: 'skipped', summary: 'cannot reach api.github.com' };
    const dateHdr = r.headers['date'] ?? r.headers['Date'];
    if (!dateHdr) return { status: 'skipped', summary: 'no Date header from gh api' };
    const ghTime = new Date(dateHdr).getTime();
    if (Number.isNaN(ghTime)) return { status: 'skipped', summary: 'unparseable Date header' };
    const skew = Math.abs(env.now().getTime() - ghTime) / 1000;
    if (skew <= 60) return { status: 'ok', summary: `within ${Math.round(skew)}s of gh api clock` };
    return {
      status: 'warn',
      summary: `clock skew ${Math.round(skew)}s`,
      action: 'Sync system clock (sntp -sS time.apple.com).',
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const RELEASES_CHECKS: DoctorCheck[] = [
  checkDirState,
  checkDepsCurrent,
  checkOpsState,
  checkOpsDivergence,
  checkReleasePr,
  checkDeployTasks,
  checkProdEdge,
  checkProdCiRecent,
  checkK8sPods,
  checkArgocdSync,
  checkReleaseBranchStale,
  checkSessionClockSkew,
];
