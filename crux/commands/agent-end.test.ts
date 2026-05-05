/**
 * Tests for crux/commands/agent-end.ts
 *
 * Two layers:
 *   1. Pure helpers (parseDirtyMode, resolveLinearId, readDevPort,
 *      readSlotNumber, inspectDirtyState) — straightforward fs/child_process
 *      mocks.
 *   2. Dry-run smoke test — drives the default command with --dry-run and
 *      asserts the printed plan reflects the mocked slot state. Verifies
 *      that no destructive subcommand is invoked when --dry-run is set.
 *
 * Side-effect-heavy steps (linear done, agents close, git checkout, tmux)
 * are exercised separately via the orchestrator paths once the bash skill
 * lands. Here we focus on the gates and dry-run wiring per QUA-1090.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks --------------------------------------------------------

const {
  existsSyncMock,
  readFileSyncMock,
  unlinkSyncMock,
  execSyncMock,
  execFileSyncMock,
  findSlotFromAncestorsMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(p: string) => boolean>(() => false),
  readFileSyncMock: vi.fn<(p: string, enc: string) => string>(() => ''),
  unlinkSyncMock: vi.fn<(p: string) => void>(() => undefined),
  execSyncMock: vi.fn<(cmd: string, opts?: unknown) => string | Buffer>(() => ''),
  execFileSyncMock: vi.fn<(file: string, args?: string[], opts?: unknown) => string | Buffer>(
    () => '',
  ),
  findSlotFromAncestorsMock: vi.fn<(cwd: string) => number | null>(() => null),
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  unlinkSync: unlinkSyncMock,
}));

vi.mock('child_process', () => ({
  execSync: execSyncMock,
  execFileSync: execFileSyncMock,
}));

// Mock the slot-ancestor walker so tests run from any cwd without surprises.
// Tests that need the walker to find a slot can override per-test.
vi.mock('../lib/session/session-context.ts', () => ({
  findSlotFromAncestors: findSlotFromAncestorsMock,
}));

// Stub the orchestrated command modules so dry-run never invokes them and
// non-dry-run paths return predictable results.
const {
  checklistCompleteMock,
  leakCheckMock,
  linearDoneMock,
  patrolStopMock,
  agentsCloseMock,
} = vi.hoisted(() => ({
  checklistCompleteMock: vi.fn(async () => ({ output: '', exitCode: 0 })),
  leakCheckMock: vi.fn(async () => ({ output: '', exitCode: 0 })),
  linearDoneMock: vi.fn(async () => ({ output: '', exitCode: 0 })),
  patrolStopMock: vi.fn(async () => ({ output: 'No patrol daemon running.', exitCode: 0 })),
  agentsCloseMock: vi.fn(async () => ({ output: '', exitCode: 0 })),
}));

vi.mock('./agent-checklist.ts', () => ({
  commands: { complete: checklistCompleteMock },
}));
vi.mock('./linear.ts', () => ({
  commands: { 'leak-check': leakCheckMock, done: linearDoneMock },
}));
vi.mock('./pr-patrol.ts', () => ({
  commands: { stop: patrolStopMock },
}));
vi.mock('./agents.ts', () => ({
  commands: { close: agentsCloseMock },
}));

// ---- Imports (after mocks) ------------------------------------------------

import {
  parseDirtyMode,
  resolveLinearId,
  readDevPort,
  readSlotNumber,
  inspectDirtyState,
  findPortListeners,
  commands,
} from './agent-end.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { join } from 'path';

// ---- Helper: install a virtual filesystem ---------------------------------

function installFs(files: Record<string, string>) {
  existsSyncMock.mockImplementation((p: string) => Object.prototype.hasOwnProperty.call(files, p));
  readFileSyncMock.mockImplementation((p: string) => {
    if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
    throw new Error(`ENOENT: ${p}`);
  });
}

/**
 * Route both shell-style (execSync) and arg-style (execFileSync) calls
 * through one regex-mapping table. `git status --porcelain` and
 * `execFileSync('git', ['status', '--porcelain'])` both match `/status --porcelain/`,
 * so existing tests written against the old shell pipeline keep working.
 */
function setExec(mapping: Array<{ match: RegExp; out: string | Error }>) {
  const dispatch = (rendered: string) => {
    for (const { match, out } of mapping) {
      if (match.test(rendered)) {
        if (out instanceof Error) throw out;
        return out;
      }
    }
    return '';
  };
  execSyncMock.mockImplementation((cmd: string) => dispatch(cmd));
  execFileSyncMock.mockImplementation((file: string, args: string[] = []) =>
    dispatch(`${file} ${args.join(' ')}`),
  );
}

beforeEach(() => {
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
  unlinkSyncMock.mockReset();
  execSyncMock.mockReset();
  execFileSyncMock.mockReset();
  findSlotFromAncestorsMock.mockReset();
  checklistCompleteMock.mockClear();
  leakCheckMock.mockClear();
  linearDoneMock.mockClear();
  patrolStopMock.mockClear();
  agentsCloseMock.mockClear();
});

// ---- parseDirtyMode -------------------------------------------------------

describe('parseDirtyMode', () => {
  it('returns "fail" by default', () => {
    expect(parseDirtyMode(undefined)).toBe('fail');
    expect(parseDirtyMode(null)).toBe('fail');
    expect(parseDirtyMode('')).toBe('fail');
    expect(parseDirtyMode('garbage')).toBe('fail');
  });
  it('returns "force" only for the literal "force"', () => {
    expect(parseDirtyMode('force')).toBe('force');
    expect(parseDirtyMode('fail')).toBe('fail');
    // "ask" was dropped from v1 because it was indistinguishable from "fail".
    expect(parseDirtyMode('ask')).toBe('fail');
  });
});

// ---- resolveLinearId ------------------------------------------------------

describe('resolveLinearId', () => {
  it('reads `> Linear: QUA-NNN` from the wip checklist', () => {
    installFs({
      [join(PROJECT_ROOT, '.claude/wip-checklist.md')]:
        '# Session\n\n> Linear: QUA-1090\n> Branch: claude/qua-1090\n',
    });
    setExec([{ match: /rev-parse --abbrev-ref/, out: 'main' }]);
    expect(resolveLinearId()).toBe('QUA-1090');
  });

  it('falls back to the branch name when no checklist is present', () => {
    installFs({});
    setExec([{ match: /rev-parse --abbrev-ref/, out: 'claude/qua-9999-some-feature' }]);
    expect(resolveLinearId()).toBe('QUA-9999');
  });

  it('returns null when neither source has an ID', () => {
    installFs({});
    setExec([{ match: /rev-parse --abbrev-ref/, out: 'main' }]);
    expect(resolveLinearId()).toBeNull();
  });

  it('handles checklist without a Linear marker by falling through to branch', () => {
    installFs({
      [join(PROJECT_ROOT, '.claude/wip-checklist.md')]: '# Session\n\nno linear marker here\n',
    });
    setExec([{ match: /rev-parse --abbrev-ref/, out: 'claude/qua-555-x' }]);
    expect(resolveLinearId()).toBe('QUA-555');
  });
});

// ---- readDevPort ----------------------------------------------------------

describe('readDevPort', () => {
  it('reads DEV_PORT from .env', () => {
    installFs({
      [join(PROJECT_ROOT, '.env')]: 'FOO=bar\nDEV_PORT=3017\nBAZ=qux\n',
    });
    expect(readDevPort()).toBe(3017);
  });

  it('returns null when .env is missing', () => {
    installFs({});
    expect(readDevPort()).toBeNull();
  });

  it('returns null when DEV_PORT is not set', () => {
    installFs({ [join(PROJECT_ROOT, '.env')]: 'FOO=bar\nBAZ=qux\n' });
    expect(readDevPort()).toBeNull();
  });

  it('rejects non-numeric values', () => {
    installFs({ [join(PROJECT_ROOT, '.env')]: 'DEV_PORT=banana\n' });
    expect(readDevPort()).toBeNull();
  });
});

// ---- readSlotNumber -------------------------------------------------------

describe('readSlotNumber', () => {
  it('reads digits from .agent-slot', () => {
    installFs({ [join(PROJECT_ROOT, '.agent-slot')]: '7\n' });
    expect(readSlotNumber()).toBe('7');
  });

  it('returns null for missing file', () => {
    installFs({});
    expect(readSlotNumber()).toBeNull();
  });

  it('returns null for non-numeric content', () => {
    installFs({ [join(PROJECT_ROOT, '.agent-slot')]: 'main\n' });
    expect(readSlotNumber()).toBeNull();
  });
});

// ---- inspectDirtyState ----------------------------------------------------

describe('inspectDirtyState', () => {
  it('categorises expected paths separately from unexpected ones', () => {
    setExec([
      { match: /status --porcelain/, out:
        ' M .claude/wip-checklist.md\n' +     // expected
        '?? .claude/wip-context.md\n' +        // expected (untracked)
        ' M .claude/hooks/pre-commit.sh\n' +   // expected (under .claude/hooks/)
        ' M apps/web/src/app/page.tsx\n' +     // unexpected
        '?? scratch.md\n'                      // unexpected
      },
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /rev-list --count/, out: '0' },
    ]);
    const r = inspectDirtyState();
    expect(r.expectedFiles).toHaveLength(3);
    expect(r.unexpectedFiles).toHaveLength(2);
    const unexpectedJoined = r.unexpectedFiles.join('\n');
    expect(unexpectedJoined).toContain('apps/web/src/app/page.tsx');
    expect(unexpectedJoined).toContain('scratch.md');
  });

  it('reports unpushed commits on a non-main branch', () => {
    setExec([
      { match: /status --porcelain/, out: '' },
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /rev-list --count/, out: '3' },
    ]);
    expect(inspectDirtyState().unpushedCommits).toBe(3);
  });

  it('does not query unpushed commits on main', () => {
    let revListCalls = 0;
    execSyncMock.mockImplementation((cmd: string) => {
      if (/status --porcelain/.test(cmd)) return '';
      if (/rev-parse --abbrev-ref/.test(cmd)) return 'main';
      if (/rev-list --count/.test(cmd)) {
        revListCalls++;
        return '5';
      }
      return '';
    });
    expect(inspectDirtyState().unpushedCommits).toBe(0);
    expect(revListCalls).toBe(0);
  });

  it('treats branches with no upstream as 0 unpushed commits (no upstream → execSafe returns null)', () => {
    setExec([
      { match: /status --porcelain/, out: '' },
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-9999-fresh' },
      { match: /rev-list --count/, out: new Error('no upstream') },
    ]);
    expect(inspectDirtyState().unpushedCommits).toBe(0);
  });

  it('treats a rename row that maps an expected file to another expected path as expected', () => {
    setExec([
      // Rename of .claude/wip-checklist.md → .claude/wip-context.md (both expected)
      { match: /status --porcelain/, out: 'R  .claude/wip-checklist.md -> .claude/wip-context.md\n' },
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /rev-list --count/, out: '0' },
    ]);
    const r = inspectDirtyState();
    expect(r.expectedFiles).toHaveLength(1);
    expect(r.unexpectedFiles).toHaveLength(0);
  });

  it('treats a rename row that touches an unexpected path as unexpected', () => {
    setExec([
      // Rename of an expected wip file → an unexpected app source path
      { match: /status --porcelain/, out: 'R  .claude/wip-checklist.md -> apps/web/leak.md\n' },
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /rev-list --count/, out: '0' },
    ]);
    const r = inspectDirtyState();
    expect(r.expectedFiles).toHaveLength(0);
    expect(r.unexpectedFiles).toHaveLength(1);
    expect(r.unexpectedFiles[0]).toContain('apps/web/leak.md');
  });
});

// ---- findPortListeners ----------------------------------------------------

describe('findPortListeners', () => {
  it('parses one PID per line', () => {
    setExec([{ match: /lsof -ti:3017/, out: '12345\n67890' }]);
    expect(findPortListeners(3017)).toEqual([12345, 67890]);
  });

  it('returns [] when nothing listens', () => {
    setExec([{ match: /lsof/, out: new Error('no match') }]);
    expect(findPortListeners(3017)).toEqual([]);
  });
});

// ---- Dry-run smoke --------------------------------------------------------

describe('agent-end --dry-run', () => {
  it('prints the plan and does not invoke any side-effect commands', async () => {
    installFs({
      [join(PROJECT_ROOT, '.claude/wip-checklist.md')]:
        '# Session\n\n> Linear: QUA-1090\n',
      [join(PROJECT_ROOT, '.env')]: 'DEV_PORT=3017\n',
      [join(PROJECT_ROOT, '.agent-slot')]: '7\n',
    });
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /status --porcelain/, out: ' M .claude/wip-checklist.md\n' }, // expected only
      { match: /rev-list --count/, out: '0' },
      { match: /lsof -ti:3017/, out: '4567' },
      { match: /pgrep/, out: '' },
    ]);

    const result = await commands.default([], { dryRun: true, ci: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/dry-run/);
    expect(result.output).toMatch(/linear:\s+QUA-1090/);
    expect(result.output).toMatch(/branch:\s+claude\/qua-1090-foo/);
    expect(result.output).toMatch(/dev port:\s+3017/);
    expect(result.output).toMatch(/PIDs: 4567/);
    expect(result.output).toMatch(/Re-run without --dry-run to execute/);

    // Must NOT have called any side-effect command.
    expect(checklistCompleteMock).not.toHaveBeenCalled();
    expect(leakCheckMock).not.toHaveBeenCalled();
    expect(linearDoneMock).not.toHaveBeenCalled();
    expect(patrolStopMock).not.toHaveBeenCalled();
    expect(agentsCloseMock).not.toHaveBeenCalled();
  });

  it('shows "Linear → Done" when no PR URL is supplied', async () => {
    installFs({
      [join(PROJECT_ROOT, '.claude/wip-checklist.md')]: '> Linear: QUA-1\n',
      [join(PROJECT_ROOT, '.env')]: '',
      [join(PROJECT_ROOT, '.agent-slot')]: '7\n',
    });
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1-x' },
      { match: /status --porcelain/, out: '' },
      { match: /rev-list --count/, out: '0' },
    ]);
    const result = await commands.default([], { dryRun: true, ci: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/QUA-1 → Done/);
  });

  it('shows "Linear → In Review" when --pr is supplied', async () => {
    installFs({
      [join(PROJECT_ROOT, '.claude/wip-checklist.md')]: '> Linear: QUA-1\n',
      [join(PROJECT_ROOT, '.env')]: '',
      [join(PROJECT_ROOT, '.agent-slot')]: '7\n',
    });
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1-x' },
      { match: /status --porcelain/, out: '' },
      { match: /rev-list --count/, out: '0' },
    ]);
    const result = await commands.default(
      [],
      { dryRun: true, ci: true, pr: 'https://example/pr/1' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/QUA-1 → In Review/);
    expect(result.output).toMatch(/PR https:\/\/example\/pr\/1/);
  });
});

// ---- Dirty-state gate -----------------------------------------------------

describe('agent-end dirty-state gate', () => {
  it('exits 2 when unexpected files are present and --dirty=fail (default)', async () => {
    installFs({});
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /status --porcelain/, out: ' M apps/web/src/app/page.tsx\n' },
      { match: /rev-list --count/, out: '0' },
    ]);
    const result = await commands.default([], { ci: true });
    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/Dirty state requires attention/);
    expect(result.output).toMatch(/apps\/web\/src\/app\/page\.tsx/);
    expect(result.output).toMatch(/--dirty=force/);
  });

  it('exits 2 when there are unpushed commits on a non-main branch', async () => {
    installFs({});
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /status --porcelain/, out: '' },
      { match: /rev-list --count/, out: '2' },
    ]);
    const result = await commands.default([], { ci: true });
    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/2 unpushed commit/);
  });

  it('passes through to dry-run when --dirty=force overrides unexpected paths', async () => {
    installFs({
      [join(PROJECT_ROOT, '.env')]: '',
      [join(PROJECT_ROOT, '.agent-slot')]: '7\n',
    });
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /status --porcelain/, out: ' M apps/web/src/app/page.tsx\n' },
      { match: /rev-list --count/, out: '0' },
    ]);
    const result = await commands.default(
      [],
      { ci: true, dryRun: true, dirty: 'force' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/Would execute/);
  });
});

// ---- Destructive execution path ------------------------------------------

describe('agent-end execute (non-dry-run)', () => {
  it('runs every step and reports them in the summary', async () => {
    installFs({
      [join(PROJECT_ROOT, '.claude/wip-checklist.md')]: '> Linear: QUA-1090\n',
      [join(PROJECT_ROOT, '.env')]: 'DEV_PORT=3017\n',
      [join(PROJECT_ROOT, '.agent-slot')]: '7\n',
    });
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      // Clean working tree → no dirty bail.
      { match: /status --porcelain/, out: '' },
      { match: /rev-list --count @\{u\}\.\.HEAD/, out: '0' },
      { match: /rev-list --count origin\/main\.\.main/, out: '0' },
      // No dev-server listener.
      { match: /lsof -ti:3017/, out: '' },
      { match: /pgrep/, out: '' },
      // git plumbing — succeed silently.
      { match: /git checkout -- \./, out: '' },
      { match: /git clean -fd/, out: '' },
      { match: /git checkout main/, out: '' },
      { match: /git fetch origin main/, out: '' },
      { match: /git pull --ff-only/, out: '' },
      { match: /git branch -D/, out: '' },
      { match: /git checkout -- /, out: '' },
    ]);

    const result = await commands.default([], { ci: true });

    // Mocked sub-commands all succeeded → exit 0
    expect(result.exitCode).toBe(0);

    // Each step contributed a line
    expect(result.output).toMatch(/Checklist/);
    expect(result.output).toMatch(/Linear leak-check/);
    expect(result.output).toMatch(/Linear done/);
    expect(result.output).toMatch(/Patrol daemon/);
    expect(result.output).toMatch(/Dev server/);
    expect(result.output).toMatch(/WIP artifacts/);
    expect(result.output).toMatch(/Review artifacts/);
    expect(result.output).toMatch(/Agent session/);
    expect(result.output).toMatch(/Branch reset/);
    expect(result.output).toMatch(/Tmux rename/);

    // Side-effect mocks were called
    expect(checklistCompleteMock).toHaveBeenCalledOnce();
    expect(leakCheckMock).toHaveBeenCalledOnce();
    expect(linearDoneMock).toHaveBeenCalledOnce();
    expect(patrolStopMock).toHaveBeenCalledOnce();
    expect(agentsCloseMock).toHaveBeenCalledOnce();

    // Summary footer
    expect(result.output).toMatch(/Done\./);
  });

  it('REFUSES to reset main when local main has commits not in origin/main', async () => {
    // This is the QUA-1090 review-found data-loss guard. Without it, an
    // accidental local commit on main would be silently discarded by
    // `git reset --hard origin/main`.
    installFs({
      [join(PROJECT_ROOT, '.claude/wip-checklist.md')]: '> Linear: QUA-1090\n',
      [join(PROJECT_ROOT, '.env')]: '',
      [join(PROJECT_ROOT, '.agent-slot')]: '7\n',
    });
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /status --porcelain/, out: '' },
      { match: /rev-list --count @\{u\}\.\.HEAD/, out: '0' },
      // 2 local-only commits on main → safety guard fires.
      { match: /rev-list --count origin\/main\.\.main/, out: '2' },
      { match: /git checkout -- \./, out: '' },
      { match: /git clean -fd/, out: '' },
      { match: /git checkout main/, out: '' },
      { match: /git fetch origin main/, out: '' },
      // git pull / reset --hard / branch -D should NOT fire if guard works.
      { match: /git pull --ff-only/, out: new Error('would not be called') },
      { match: /git reset --hard/, out: new Error('would not be called') },
      { match: /git branch -D/, out: new Error('would not be called') },
    ]);

    const result = await commands.default([], { ci: true });

    expect(result.exitCode).toBe(1); // at least one step failed
    expect(result.output).toMatch(/2 local commit\(s\) on main not in origin\/main/);
    expect(result.output).toMatch(/refusing to reset/);
  });

  it('reports failure when checklist has unchecked items but still runs the rest', async () => {
    installFs({
      [join(PROJECT_ROOT, '.claude/wip-checklist.md')]: '> Linear: QUA-1090\n[ ] item-a\n[ ] item-b\n',
      [join(PROJECT_ROOT, '.env')]: '',
      [join(PROJECT_ROOT, '.agent-slot')]: '7\n',
    });
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /status --porcelain/, out: '' },
      { match: /rev-list --count/, out: '0' },
      { match: /lsof/, out: '' },
      { match: /pgrep/, out: '' },
    ]);
    // checklist complete returns exit 1 with output containing two `[ ]` markers
    checklistCompleteMock.mockResolvedValueOnce({
      output: '✗ 2 unchecked item(s):\n  [ ] item-a\n  [ ] item-b\n',
      exitCode: 1,
    });

    const result = await commands.default([], { ci: true });
    // checklist failure surfaces in the per-step report, but the rest of the
    // session-close still runs to completion — the slot would otherwise leak.
    expect(result.output).toMatch(/Checklist/);
    expect(result.output).toMatch(/2 item\(s\) unchecked/);
    expect(linearDoneMock).toHaveBeenCalled();
    expect(agentsCloseMock).toHaveBeenCalled();
  });

  it('bails (exit 2) on a detached HEAD without invoking any step', async () => {
    // Per CodeRabbit finding on PR #4878: `git rev-parse --abbrev-ref HEAD`
    // returns the literal string 'HEAD' for a detached worktree (not the
    // commit hash). Without an upfront guard, the parallel side-effects
    // (Linear close, agents close, file unlinks) would run before
    // stepBranchReset's downstream guard caught the bad state.
    installFs({
      [join(PROJECT_ROOT, '.claude/wip-checklist.md')]: '> Linear: QUA-1090\n',
      [join(PROJECT_ROOT, '.env')]: '',
      [join(PROJECT_ROOT, '.agent-slot')]: '7\n',
    });
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'HEAD' }, // ← detached
      { match: /status --porcelain/, out: '' },
      { match: /rev-list --count/, out: '0' },
    ]);

    const result = await commands.default([], { ci: true });

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/detached or unknown git HEAD/);
    // Crucially: no step was invoked.
    expect(checklistCompleteMock).not.toHaveBeenCalled();
    expect(linearDoneMock).not.toHaveBeenCalled();
    expect(agentsCloseMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  it('skips dev-server kill cleanly when no DEV_PORT is configured', async () => {
    installFs({
      [join(PROJECT_ROOT, '.claude/wip-checklist.md')]: '> Linear: QUA-1090\n',
      [join(PROJECT_ROOT, '.env')]: 'FOO=bar\n', // no DEV_PORT
      [join(PROJECT_ROOT, '.agent-slot')]: '7\n',
    });
    setExec([
      { match: /rev-parse --abbrev-ref/, out: 'claude/qua-1090-foo' },
      { match: /status --porcelain/, out: '' },
      { match: /rev-list --count/, out: '0' },
      { match: /pgrep/, out: '' },
      { match: /git/, out: '' },
    ]);
    const result = await commands.default([], { ci: true });
    expect(result.output).toMatch(/Dev server.*no DEV_PORT in \.env/);
  });
});
