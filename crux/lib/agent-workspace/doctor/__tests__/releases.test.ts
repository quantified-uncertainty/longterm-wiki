import { describe, it, expect } from 'vitest';
import {
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
  RELEASES_CHECKS,
} from '../releases.ts';
import { FakeDoctorEnv, ok, fail, notFound } from './fake-env.ts';

const NOW_SEC = 1_744_000_000;
const NOW_MS = NOW_SEC * 1000;

function envWithReleasesDir() {
  const env = new FakeDoctorEnv({ now: NOW_SEC });
  env.setFile('/lw/releases', { isDir: true });
  return env;
}

describe('checkDirState', () => {
  it('ok when releases/ on main, clean, .env -> ../.env.base', async () => {
    const env = envWithReleasesDir();
    env.setExec('git -C /lw/releases branch --show-current', ok('main\n'));
    env.setExec('git -C /lw/releases status --porcelain', ok());
    env.setFile('/lw/releases/.env', { isSymlink: true, symlinkTarget: '../.env.base' });
    expect((await checkDirState.run(env)).status).toBe('ok');
  });
  it('fails when on a non-main branch', async () => {
    const env = envWithReleasesDir();
    env.setExec('git -C /lw/releases branch --show-current', ok('hotfix\n'));
    env.setExec('git -C /lw/releases status --porcelain', ok());
    env.setFile('/lw/releases/.env', { isSymlink: true, symlinkTarget: '../.env.base' });
    const r = await checkDirState.run(env);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('hotfix');
  });
  it('fails with mid-rebase state and emits the abort suggestion', async () => {
    const env = envWithReleasesDir();
    env.setFile('/lw/releases/.git/rebase-merge', { isDir: true });
    env.setExec('git -C /lw/releases branch --show-current', ok('main\n'));
    env.setExec('git -C /lw/releases status --porcelain', ok());
    env.setFile('/lw/releases/.env', { isSymlink: true, symlinkTarget: '../.env.base' });
    const r = await checkDirState.run(env);
    expect(r.status).toBe('fail');
    expect(r.action).toContain('rebase --abort');
  });
  it('fails LOUDLY when both releases/ and coord/ exist (rename in flight)', async () => {
    const env = envWithReleasesDir();
    env.setFile('/lw/coord', { isDir: true });
    const r = await checkDirState.run(env);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('BOTH');
  });
  it('falls back to coord/ when only coord/ exists', async () => {
    const env = new FakeDoctorEnv({ now: NOW_SEC });
    env.setFile('/lw/coord', { isDir: true });
    env.setExec('git -C /lw/coord branch --show-current', ok('main\n'));
    env.setExec('git -C /lw/coord status --porcelain', ok());
    env.setFile('/lw/coord/.env', { isSymlink: true, symlinkTarget: '../.env.base' });
    const r = await checkDirState.run(env);
    expect(r.status).toBe('ok');
    expect(r.summary).toContain('coord/');
  });
});

describe('checkDepsCurrent', () => {
  it('ok when lock is older than node_modules/.pnpm', async () => {
    const env = envWithReleasesDir();
    env.setFile('/lw/releases/pnpm-lock.yaml', { mtime: NOW_SEC - 1000 });
    env.setFile('/lw/releases/node_modules/.pnpm', { isDir: true, mtime: NOW_SEC - 500 });
    expect((await checkDepsCurrent.run(env)).status).toBe('ok');
  });
  it('warns when lock is newer than node_modules/.pnpm', async () => {
    const env = envWithReleasesDir();
    env.setFile('/lw/releases/pnpm-lock.yaml', { mtime: NOW_SEC });
    env.setFile('/lw/releases/node_modules/.pnpm', { isDir: true, mtime: NOW_SEC - 1000 });
    expect((await checkDepsCurrent.run(env)).status).toBe('warn');
  });
});

describe('checkOpsState', () => {
  it('ok when clean and recently fetched', async () => {
    const env = new FakeDoctorEnv({ now: NOW_SEC });
    env.setFile('/lw/ops', { isDir: true });
    env.setExec('git -C /lw/ops status --porcelain', ok());
    env.setFile('/lw/ops/.git/FETCH_HEAD', { mtime: NOW_SEC - 600 });
    expect((await checkOpsState.run(env)).status).toBe('ok');
  });
  it('warns when dirty', async () => {
    const env = new FakeDoctorEnv({ now: NOW_SEC });
    env.setFile('/lw/ops', { isDir: true });
    env.setExec('git -C /lw/ops status --porcelain', ok(' M k8s/foo.yaml\n'));
    env.setFile('/lw/ops/.git/FETCH_HEAD', { mtime: NOW_SEC - 60 });
    expect((await checkOpsState.run(env)).status).toBe('warn');
  });
  it('warns when last fetch >60min ago', async () => {
    const env = new FakeDoctorEnv({ now: NOW_SEC });
    env.setFile('/lw/ops', { isDir: true });
    env.setExec('git -C /lw/ops status --porcelain', ok());
    env.setFile('/lw/ops/.git/FETCH_HEAD', { mtime: NOW_SEC - 60 * 60 * 3 });
    expect((await checkOpsState.run(env)).status).toBe('warn');
  });
  it('clamps future FETCH_HEAD mtime (clock skew) to 0, no negative display', async () => {
    const env = new FakeDoctorEnv({ now: NOW_SEC });
    env.setFile('/lw/ops', { isDir: true });
    env.setExec('git -C /lw/ops status --porcelain', ok());
    // mtime in the future — can happen after a restore-from-backup
    env.setFile('/lw/ops/.git/FETCH_HEAD', { mtime: NOW_SEC + 999 });
    const r = await checkOpsState.run(env);
    expect(r.status).toBe('ok');
    expect(r.summary).not.toContain('-');
    expect(r.summary).toContain('0m');
  });
});

describe('checkOpsDivergence', () => {
  it('ok when up to date', async () => {
    const env = new FakeDoctorEnv();
    env.setFile('/lw/ops', { isDir: true });
    env.setExec('git -C /lw/ops rev-list --left-right --count HEAD...origin/main', ok('0\t0\n'));
    expect((await checkOpsDivergence.run(env)).status).toBe('ok');
  });
  it('ok when behind only', async () => {
    const env = new FakeDoctorEnv();
    env.setFile('/lw/ops', { isDir: true });
    env.setExec('git -C /lw/ops rev-list --left-right --count HEAD...origin/main', ok('0\t3\n'));
    expect((await checkOpsDivergence.run(env)).status).toBe('ok');
  });
  it('fails when local commits ahead', async () => {
    const env = new FakeDoctorEnv();
    env.setFile('/lw/ops', { isDir: true });
    env.setExec('git -C /lw/ops rev-list --left-right --count HEAD...origin/main', ok('2\t1\n'));
    const r = await checkOpsDivergence.run(env);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('2');
  });
});

describe('checkReleasePr', () => {
  it('ok when no open release PR', async () => {
    const env = new FakeDoctorEnv();
    env.setExec(
      'gh pr list --repo quantified-uncertainty/longterm-wiki --base production --state open --json number,title,createdAt,isDraft,mergeable,statusCheckRollup',
      ok('[]'),
    );
    expect((await checkReleasePr.run(env)).status).toBe('ok');
  });
  it('fails when open PR has failing checks', async () => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec(
      'gh pr list --repo quantified-uncertainty/longterm-wiki --base production --state open --json number,title,createdAt,isDraft,mergeable,statusCheckRollup',
      ok(JSON.stringify([{
        number: 1234, title: 'Release', createdAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
        isDraft: false, statusCheckRollup: [{ conclusion: 'failure' }],
      }])),
    );
    const r = await checkReleasePr.run(env);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('#1234');
  });
  it('warns when PR is >24h old without failures', async () => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec(
      'gh pr list --repo quantified-uncertainty/longterm-wiki --base production --state open --json number,title,createdAt,isDraft,mergeable,statusCheckRollup',
      ok(JSON.stringify([{
        number: 9, title: 'Old', createdAt: new Date(NOW_MS - 30 * 60 * 60 * 1000).toISOString(),
        isDraft: false, statusCheckRollup: [{ conclusion: 'success' }],
      }])),
    );
    const r = await checkReleasePr.run(env);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('30h');
  });
  it('info when fresh PR has no checks yet (warming up)', async () => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec(
      'gh pr list --repo quantified-uncertainty/longterm-wiki --base production --state open --json number,title,createdAt,isDraft,mergeable,statusCheckRollup',
      ok(JSON.stringify([{
        number: 11, title: 'Fresh', createdAt: new Date(NOW_MS - 60 * 1000).toISOString(),
        isDraft: false, statusCheckRollup: [],
      }])),
    );
    expect((await checkReleasePr.run(env)).status).toBe('info');
  });
  it('skips when gh CLI missing', async () => {
    const env = new FakeDoctorEnv();
    env.setExec(
      'gh pr list --repo quantified-uncertainty/longterm-wiki --base production --state open --json number,title,createdAt,isDraft,mergeable,statusCheckRollup',
      notFound(),
    );
    expect((await checkReleasePr.run(env)).status).toBe('skipped');
  });

  // GitHub conclusions that should be treated as failing. The pre-fix regex
  // /fail|cancel|error/i MISSED timed_out and action_required. One test per
  // conclusion in FAILING_CONCLUSIONS to prevent future regex drift.
  it.each([
    ['failure'],
    ['cancelled'],
    ['timed_out'],
    ['action_required'],
    ['startup_failure'],
  ])('treats conclusion=%s as a failing check', async (conclusion) => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec(
      'gh pr list --repo quantified-uncertainty/longterm-wiki --base production --state open --json number,title,createdAt,isDraft,mergeable,statusCheckRollup',
      ok(JSON.stringify([{
        number: 77, title: 'T', createdAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
        isDraft: false, statusCheckRollup: [{ conclusion }],
      }])),
    );
    const r = await checkReleasePr.run(env);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('#77');
  });

  it.each([
    ['success'],
    ['neutral'],
    ['skipped'],
  ])('treats conclusion=%s as NOT failing', async (conclusion) => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec(
      'gh pr list --repo quantified-uncertainty/longterm-wiki --base production --state open --json number,title,createdAt,isDraft,mergeable,statusCheckRollup',
      ok(JSON.stringify([{
        number: 88, title: 'T', createdAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
        isDraft: false, statusCheckRollup: [{ conclusion }],
      }])),
    );
    expect((await checkReleasePr.run(env)).status).toBe('ok');
  });
});

describe('checkDeployTasks', () => {
  const KEY = 'pnpm -s crux gh deploy-tasks pending';
  it('ok when no unchecked markers in output', async () => {
    const env = new FakeDoctorEnv();
    env.setExec(KEY, ok('No pending deploy tasks.\n'));
    expect((await checkDeployTasks.run(env)).status).toBe('ok');
  });
  it('counts ☐ markers as pending', async () => {
    const env = new FakeDoctorEnv();
    env.setExec(KEY, ok('PR #1\n  ☐ `ci` Verify CI\n  ☐ `migration` Apply 0173\n'));
    const r = await checkDeployTasks.run(env);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('2');
  });
  it('counts [ ] markers as pending', async () => {
    const env = new FakeDoctorEnv();
    env.setExec(KEY, ok('PR #2\n  [ ] check thing\n'));
    const r = await checkDeployTasks.run(env);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('1');
  });
  it('strips ANSI color codes before counting', async () => {
    const env = new FakeDoctorEnv();
    env.setExec(KEY, ok('\x1b[33m☐\x1b[0m task one\n\x1b[33m☐\x1b[0m task two\n'));
    expect((await checkDeployTasks.run(env)).summary).toContain('2');
  });
  it('skips when pnpm missing', async () => {
    const env = new FakeDoctorEnv();
    env.setExec(KEY, notFound());
    expect((await checkDeployTasks.run(env)).status).toBe('skipped');
  });
});

describe('checkProdEdge', () => {
  const URL = 'https://wiki-server.k8s.quantifieduncertainty.org/health';
  it('ok on 200 with status=healthy (actual wiki-server contract)', async () => {
    const env = new FakeDoctorEnv();
    env.setFetch(URL, { ok: true, status: 200, body: '{"status":"healthy"}', headers: {} });
    const r = await checkProdEdge.run(env);
    expect(r.status).toBe('ok');
    expect(r.summary).toContain('healthy');
  });
  it('ok on 200 with status=ok (defensive alternate contract)', async () => {
    const env = new FakeDoctorEnv();
    env.setFetch(URL, { ok: true, status: 200, body: '{"status":"ok"}', headers: {} });
    expect((await checkProdEdge.run(env)).status).toBe('ok');
  });
  it('fails on degraded status', async () => {
    const env = new FakeDoctorEnv();
    env.setFetch(URL, { ok: true, status: 200, body: '{"status":"degraded"}', headers: {} });
    expect((await checkProdEdge.run(env)).status).toBe('fail');
  });
  it('fails on migrationError', async () => {
    const env = new FakeDoctorEnv();
    env.setFetch(URL, {
      ok: true, status: 200, body: '{"status":"degraded","migrationError":"lock_timeout"}', headers: {},
    });
    const r = await checkProdEdge.run(env);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('lock_timeout');
  });
  it('fails on non-200', async () => {
    const env = new FakeDoctorEnv();
    env.setFetch(URL, { ok: false, status: 503, body: '', headers: {} });
    expect((await checkProdEdge.run(env)).status).toBe('fail');
  });
  it('fails on timeout', async () => {
    const env = new FakeDoctorEnv();
    env.setFetch(URL, { ok: false, status: 0, body: '', headers: {}, timedOut: true });
    expect((await checkProdEdge.run(env)).status).toBe('fail');
  });
});

describe('checkProdCiRecent', () => {
  it('ok with no failures in last 24h', async () => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec(
      'gh run list --repo quantified-uncertainty/longterm-wiki --branch production --limit 20 --json status,conclusion,createdAt',
      ok(JSON.stringify([
        { status: 'completed', conclusion: 'success', createdAt: new Date(NOW_MS - 1000).toISOString() },
      ])),
    );
    expect((await checkProdCiRecent.run(env)).status).toBe('ok');
  });
  it('warns on a recent failure', async () => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec(
      'gh run list --repo quantified-uncertainty/longterm-wiki --branch production --limit 20 --json status,conclusion,createdAt',
      ok(JSON.stringify([
        { status: 'completed', conclusion: 'failure', createdAt: new Date(NOW_MS - 1000).toISOString() },
      ])),
    );
    expect((await checkProdCiRecent.run(env)).status).toBe('warn');
  });
  // Previously this check used /failure|cancelled|timed_out/ but MISSED
  // action_required and startup_failure. Share the FAILING_CONCLUSIONS
  // allowlist with checkReleasePr via isFailingConclusion().
  it.each([
    ['action_required'],
    ['startup_failure'],
  ])('catches conclusion=%s', async (conclusion) => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec(
      'gh run list --repo quantified-uncertainty/longterm-wiki --branch production --limit 20 --json status,conclusion,createdAt',
      ok(JSON.stringify([
        { status: 'completed', conclusion, createdAt: new Date(NOW_MS - 1000).toISOString() },
      ])),
    );
    expect((await checkProdCiRecent.run(env)).status).toBe('warn');
  });
});

describe('checkK8sPods', () => {
  it('skips when kubectl missing', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('kubectl -n longterm-wiki get pods -o json', notFound());
    expect((await checkK8sPods.run(env)).status).toBe('skipped');
  });
  it('ok when all pods Running with no restart spike', async () => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec('kubectl -n longterm-wiki get pods -o json', ok(JSON.stringify({
      items: [{
        metadata: { name: 'wiki-server-0', creationTimestamp: new Date(NOW_MS - 86400000).toISOString() },
        status: { phase: 'Running', containerStatuses: [{ restartCount: 0 }] },
      }],
    })));
    expect((await checkK8sPods.run(env)).status).toBe('ok');
  });
  it('fails when a pod is not Running', async () => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec('kubectl -n longterm-wiki get pods -o json', ok(JSON.stringify({
      items: [{
        metadata: { name: 'wiki-server-0', creationTimestamp: new Date(NOW_MS - 1000).toISOString() },
        status: { phase: 'Pending', containerStatuses: [] },
      }],
    })));
    expect((await checkK8sPods.run(env)).status).toBe('fail');
  });
  it('fails on restart spike (>5 restarts in <1h)', async () => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setExec('kubectl -n longterm-wiki get pods -o json', ok(JSON.stringify({
      items: [{
        metadata: { name: 'wiki-server-0', creationTimestamp: new Date(NOW_MS - 30 * 60 * 1000).toISOString() },
        status: { phase: 'Running', containerStatuses: [{ restartCount: 6 }] },
      }],
    })));
    expect((await checkK8sPods.run(env)).status).toBe('fail');
  });
});

describe('checkArgocdSync', () => {
  it('skips when argocd missing', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('argocd app list -o json', notFound());
    expect((await checkArgocdSync.run(env)).status).toBe('skipped');
  });
  it('ok when all longterm apps Synced/Healthy', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('argocd app list -o json', ok(JSON.stringify([
      { metadata: { name: 'longterm-wiki-server' }, status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } } },
    ])));
    expect((await checkArgocdSync.run(env)).status).toBe('ok');
  });
  it('fails on OutOfSync or Degraded', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('argocd app list -o json', ok(JSON.stringify([
      { metadata: { name: 'longterm-wiki-server' }, status: { sync: { status: 'OutOfSync' }, health: { status: 'Healthy' } } },
    ])));
    expect((await checkArgocdSync.run(env)).status).toBe('fail');
  });
});

describe('checkReleaseBranchStale', () => {
  it('info when no release branches', async () => {
    const env = new FakeDoctorEnv();
    env.setExec(
      'gh api repos/quantified-uncertainty/longterm-wiki/branches --paginate -q .[].name',
      ok('main\nproduction\n'),
    );
    expect((await checkReleaseBranchStale.run(env)).status).toBe('info');
  });
  it('info with count when release branches exist', async () => {
    const env = new FakeDoctorEnv();
    env.setExec(
      'gh api repos/quantified-uncertainty/longterm-wiki/branches --paginate -q .[].name',
      ok('main\nrelease/v1\nrelease/v2\n'),
    );
    const r = await checkReleaseBranchStale.run(env);
    expect(r.status).toBe('info');
    expect(r.summary).toContain('2');
  });
});

describe('checkSessionClockSkew', () => {
  it('ok when within 60s', async () => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setFetch('https://api.github.com', {
      ok: true, status: 200, body: '', headers: { date: new Date(NOW_MS - 5000).toUTCString() },
    });
    expect((await checkSessionClockSkew.run(env)).status).toBe('ok');
  });
  it('warns on >60s skew', async () => {
    const env = new FakeDoctorEnv({ now: new Date(NOW_MS) });
    env.setFetch('https://api.github.com', {
      ok: true, status: 200, body: '', headers: { date: new Date(NOW_MS - 5 * 60 * 1000).toUTCString() },
    });
    expect((await checkSessionClockSkew.run(env)).status).toBe('warn');
  });
  it('skips on network error', async () => {
    const env = new FakeDoctorEnv();
    env.setFetch('https://api.github.com', {
      ok: false, status: 0, body: '', headers: {}, networkError: true,
    });
    expect((await checkSessionClockSkew.run(env)).status).toBe('skipped');
  });
});

describe('RELEASES_CHECKS registry', () => {
  it('contains all 12 checks', () => {
    expect(RELEASES_CHECKS).toHaveLength(12);
  });
  it('all checks have unique ids', () => {
    const ids = new Set(RELEASES_CHECKS.map((c) => c.id));
    expect(ids.size).toBe(RELEASES_CHECKS.length);
  });
});
