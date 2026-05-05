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

const { existsSyncMock, readFileSyncMock, unlinkSyncMock, execSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(p: string) => boolean>(() => false),
  readFileSyncMock: vi.fn<(p: string, enc: string) => string>(() => ''),
  unlinkSyncMock: vi.fn<(p: string) => void>(() => undefined),
  execSyncMock: vi.fn<(cmd: string, opts?: unknown) => string | Buffer>(() => ''),
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  unlinkSync: unlinkSyncMock,
}));

vi.mock('child_process', () => ({
  execSync: execSyncMock,
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

function setExec(mapping: Array<{ match: RegExp; out: string | Error }>) {
  execSyncMock.mockImplementation((cmd: string) => {
    for (const { match, out } of mapping) {
      if (match.test(cmd)) {
        if (out instanceof Error) throw out;
        return out;
      }
    }
    return '';
  });
}

beforeEach(() => {
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
  unlinkSyncMock.mockReset();
  execSyncMock.mockReset();
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
  it('accepts the three valid modes', () => {
    expect(parseDirtyMode('ask')).toBe('ask');
    expect(parseDirtyMode('fail')).toBe('fail');
    expect(parseDirtyMode('force')).toBe('force');
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
    expect(result.output).toMatch(/PIDs 4567/);
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
