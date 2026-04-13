import { describe, it, expect } from 'vitest';
import {
  checkRenameLoop,
  checkPrPatrol,
  checkRenameLogAge,
  checkEnvDrift,
  checkAgentSlotMarker,
  checkMergedDirty,
  checkMidRebase,
  checkDevServerInventory,
  checkTmuxNamedWindows,
  checkDiskSpace,
  checkHungWikiServer,
  SLOTS_CHECKS,
} from '../slots.ts';
import { FakeDoctorEnv, ok, fail, notFound } from './fake-env.ts';

const NOW_SEC = 1_744_000_000;

function envWithSlots(slots: number[]) {
  const env = new FakeDoctorEnv({ now: NOW_SEC });
  env.setDir('/lw', slots.map((n) => `a${n}`));
  for (const n of slots) env.setFile(`/lw/a${n}`, { isDir: true });
  return env;
}

describe('checkRenameLoop', () => {
  it('ok when exactly one process', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('pgrep -fa tmux-rename-loop.sh', ok('41832 /bin/bash scripts/tmux-rename-loop.sh\n'));
    expect(await checkRenameLoop.run(env)).toMatchObject({ status: 'ok' });
  });
  it('warns when not running', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('pgrep -fa tmux-rename-loop.sh', { stdout: '', stderr: '', code: 1 });
    const r = await checkRenameLoop.run(env);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('not running');
  });
  it('warns when multiple processes', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('pgrep -fa tmux-rename-loop.sh', ok('1 /bin/bash scripts/tmux-rename-loop.sh\n2 /bin/bash scripts/tmux-rename-loop.sh\n'));
    const r = await checkRenameLoop.run(env);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('2');
  });
  it('skips when pgrep is missing', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('pgrep -fa tmux-rename-loop.sh', notFound());
    expect((await checkRenameLoop.run(env)).status).toBe('skipped');
  });
});

describe('checkPrPatrol', () => {
  it('always informational', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('pgrep -fa pr-patrol', { stdout: '', stderr: '', code: 1 });
    expect((await checkPrPatrol.run(env)).status).toBe('info');
  });
});

describe('checkRenameLogAge', () => {
  it('ok when log is fresh and clean', async () => {
    const env = new FakeDoctorEnv({ now: NOW_SEC });
    env.setDir('/tmp', ['lw-fix-tabs.log']);
    env.setFile('/tmp/lw-fix-tabs.log', { content: 'renamed: a3:main\n', mtime: NOW_SEC - 30 });
    const r = await checkRenameLogAge.run(env);
    expect(r.status).toBe('ok');
    expect(r.summary).toContain('30s');
  });
  it('warns on errors', async () => {
    const env = new FakeDoctorEnv({ now: NOW_SEC });
    env.setDir('/tmp', ['lw-fix-tabs.log']);
    env.setFile('/tmp/lw-fix-tabs.log', { content: 'error: tmux died\n', mtime: NOW_SEC - 30 });
    const r = await checkRenameLogAge.run(env);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('error');
  });
  it('warns when stale', async () => {
    const env = new FakeDoctorEnv({ now: NOW_SEC });
    env.setDir('/tmp', ['lw-fix-tabs.log']);
    env.setFile('/tmp/lw-fix-tabs.log', { content: '', mtime: NOW_SEC - 60 * 60 });
    const r = await checkRenameLogAge.run(env);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('stalled');
  });
  it('info when log is missing', async () => {
    const env = new FakeDoctorEnv();
    env.setDir('/tmp', []);
    expect((await checkRenameLogAge.run(env)).status).toBe('info');
  });
});

describe('checkEnvDrift', () => {
  it('ok when all slot envs are fresh files', async () => {
    const env = envWithSlots([1, 2]);
    env.setFile('/lw/.env.base', { content: '', mtime: NOW_SEC - 100 });
    env.setFile('/lw/a1/.env', { content: '', mtime: NOW_SEC - 50 });
    env.setFile('/lw/a2/.env', { content: '', mtime: NOW_SEC - 50 });
    expect((await checkEnvDrift.run(env)).status).toBe('ok');
  });
  it('warns on stale, missing, and symlinked envs', async () => {
    const env = envWithSlots([1, 2, 3]);
    env.setFile('/lw/.env.base', { content: '', mtime: NOW_SEC - 100 });
    env.setFile('/lw/a1/.env', { content: '', mtime: NOW_SEC - 200 }); // stale
    env.setFile('/lw/a2/.env', { isSymlink: true, symlinkTarget: '../.env.base' }); // symlink
    // a3 missing entirely
    const r = await checkEnvDrift.run(env);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('a1');
    expect(r.detail).toContain('a2');
    expect(r.detail).toContain('a3');
  });
  it('skips when .env.base missing', async () => {
    const env = envWithSlots([1]);
    expect((await checkEnvDrift.run(env)).status).toBe('skipped');
  });
});

describe('checkAgentSlotMarker', () => {
  it('ok when all markers match', async () => {
    const env = envWithSlots([1, 2]);
    env.setFile('/lw/a1/.agent-slot', { content: '1\n' });
    env.setFile('/lw/a2/.agent-slot', { content: '2' });
    expect((await checkAgentSlotMarker.run(env)).status).toBe('ok');
  });
  it('warns on mismatch', async () => {
    const env = envWithSlots([3]);
    env.setFile('/lw/a3/.agent-slot', { content: '99' });
    const r = await checkAgentSlotMarker.run(env);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('a3');
  });
  it('warns on missing marker', async () => {
    const env = envWithSlots([5]);
    expect((await checkAgentSlotMarker.run(env)).status).toBe('warn');
  });
});

describe('checkMergedDirty', () => {
  it('ok with no merged-dirty slots', async () => {
    const env = envWithSlots([1]);
    env.setExec('git -C /lw/a1 branch --show-current', ok('main\n'));
    expect((await checkMergedDirty.run(env)).status).toBe('ok');
  });
  it('warns when merged branch has uncommitted work', async () => {
    const env = envWithSlots([4]);
    env.setExec('git -C /lw/a4 branch --show-current', ok('claude/old-thing\n'));
    env.setExec('git -C /lw/a4 status --porcelain', ok(' M file.ts\n'));
    env.setExec('git -C /lw/a4 merge-base --is-ancestor HEAD origin/main', ok());
    const r = await checkMergedDirty.run(env);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('a4');
  });
  it('ok when dirty but branch is NOT merged', async () => {
    const env = envWithSlots([4]);
    env.setExec('git -C /lw/a4 branch --show-current', ok('claude/active\n'));
    env.setExec('git -C /lw/a4 status --porcelain', ok(' M f\n'));
    env.setExec('git -C /lw/a4 merge-base --is-ancestor HEAD origin/main', fail('', 1));
    expect((await checkMergedDirty.run(env)).status).toBe('ok');
  });
});

describe('checkMidRebase', () => {
  it('ok when no rebase state exists', async () => {
    const env = envWithSlots([1]);
    expect((await checkMidRebase.run(env)).status).toBe('ok');
  });
  it('fails when rebase-merge directory exists', async () => {
    const env = envWithSlots([2]);
    env.setFile('/lw/a2/.git/rebase-merge', { isDir: true });
    const r = await checkMidRebase.run(env);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('a2');
  });
  it('fails on CHERRY_PICK_HEAD', async () => {
    const env = envWithSlots([3]);
    env.setFile('/lw/a3/.git/CHERRY_PICK_HEAD', { content: 'abc' });
    expect((await checkMidRebase.run(env)).status).toBe('fail');
  });
});

describe('checkDevServerInventory', () => {
  it('info when no listeners', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('lsof -iTCP:3010-3030 -sTCP:LISTEN -P -n', { stdout: '', stderr: '', code: 1 });
    const r = await checkDevServerInventory.run(env);
    expect(r.status).toBe('info');
  });
  it('info (never auto-act) when listeners present', async () => {
    const env = new FakeDoctorEnv();
    env.setExec(
      'lsof -iTCP:3010-3030 -sTCP:LISTEN -P -n',
      ok('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnext 12345 ozzie 21u IPv4 0t0 TCP *:3014 (LISTEN)\n'),
    );
    const r = await checkDevServerInventory.run(env);
    expect(r.status).toBe('info');
    expect(r.summary).toContain('NEVER auto-kill');
    expect(r.detail).toContain('3014');
  });
  it('skips when lsof missing', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('lsof -iTCP:3010-3030 -sTCP:LISTEN -P -n', notFound());
    expect((await checkDevServerInventory.run(env)).status).toBe('skipped');
  });
});

describe('checkTmuxNamedWindows', () => {
  it('skipped when not in tmux', async () => {
    const env = new FakeDoctorEnv();
    expect((await checkTmuxNamedWindows.run(env)).status).toBe('skipped');
  });
  it('ok when all slot windows match real slots', async () => {
    const env = envWithSlots([1, 2]);
    env.env = { TMUX: 'x' };
    env.setExec('tmux list-windows -a -F #{window_name}', ok('A1:main\nA2:main\nLW\n'));
    expect((await checkTmuxNamedWindows.run(env)).status).toBe('ok');
  });
  it('warns on orphan windows', async () => {
    const env = envWithSlots([1]);
    env.env = { TMUX: 'x' };
    env.setExec('tmux list-windows -a -F #{window_name}', ok('A1:main\nA9:dead\n'));
    const r = await checkTmuxNamedWindows.run(env);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('A9');
  });
});

describe('checkDiskSpace', () => {
  it('ok with plenty of space', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('df -k /lw', ok(
      'Filesystem 1K-blocks Used Avail Capacity Mounted\n' +
      '/dev/disk1 268435456 100000000 168435456 38% /\n',
    ));
    const r = await checkDiskSpace.run(env);
    expect(r.status).toBe('ok');
  });
  it('warns when below 5GB', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('df -k /lw', ok(
      'Filesystem 1K-blocks Used Avail Capacity Mounted\n' +
      '/dev/disk1 268435456 264435456 4000000 99% /\n',
    ));
    expect((await checkDiskSpace.run(env)).status).toBe('warn');
  });
  it('warns when below 10%', async () => {
    const env = new FakeDoctorEnv();
    env.setExec('df -k /lw', ok(
      'Filesystem 1K-blocks Used Avail Capacity Mounted\n' +
      '/dev/disk1 100000000 95000000 5000000 95% /\n',
    ));
    expect((await checkDiskSpace.run(env)).status).toBe('warn');
  });
});

describe('checkHungWikiServer', () => {
  it('ok when none in slot dirs', async () => {
    const env = envWithSlots([1]);
    env.setExec('pgrep -fa wiki-server', ok('100 node /lw/main/apps/wiki-server/dist/index.js\n'));
    expect((await checkHungWikiServer.run(env)).status).toBe('ok');
  });
  it('warns when wiki-server runs from a slot', async () => {
    const env = envWithSlots([7]);
    env.setExec('pgrep -fa wiki-server', ok('200 node /lw/a7/apps/wiki-server/dist/index.js\n'));
    const r = await checkHungWikiServer.run(env);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('a7');
  });
  // Regression: pre-fix substring match flagged /lw/a10 processes as
  // running in /lw/a1 because "/lw/a10".includes("/lw/a1") is true.
  it('does NOT match /lw/a10 process against /lw/a1 slot (prefix collision)', async () => {
    const env = envWithSlots([1]); // ONLY a1 is a real slot here
    env.setExec('pgrep -fa wiki-server', ok('300 node /lw/a10/apps/wiki-server/dist/index.js\n'));
    const r = await checkHungWikiServer.run(env);
    expect(r.status).toBe('ok');
  });
  it('correctly attributes when both a1 and a10 are real slots', async () => {
    const env = envWithSlots([1, 10]);
    env.setExec(
      'pgrep -fa wiki-server',
      ok('300 node /lw/a10/apps/wiki-server/dist/index.js\n'),
    );
    const r = await checkHungWikiServer.run(env);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('a10');
  });
});

describe('SLOTS_CHECKS registry', () => {
  it('contains all 11 checks', () => {
    expect(SLOTS_CHECKS).toHaveLength(11);
  });
  it('all checks have unique ids', () => {
    const ids = new Set(SLOTS_CHECKS.map((c) => c.id));
    expect(ids.size).toBe(SLOTS_CHECKS.length);
  });
});
