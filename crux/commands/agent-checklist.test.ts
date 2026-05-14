/**
 * Tests for crux/commands/agent-checklist.ts (simplified)
 *
 * Focus areas:
 * - init: generates checklist for each type, handles --issue, validates args
 * - status: parses checklist file, handles missing file
 * - complete: validates all items checked, returns correct exit codes
 * - check: marks items, handles --na
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs operations
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

// Mock GitHub API
vi.mock('../lib/github.ts', () => ({
  REPO: 'quantified-uncertainty/longterm-wiki',
  githubApi: vi.fn(),
}));

// Mock child_process for currentBranch — default to a branch without any
// Linear ID so Linear-detection tests only fire when they opt in via a mock
// override below.
vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'claude/test-branch-ABC'),
}));

// Mock the Linear command module so auto-start doesn't hit the network.
// `vi.mock` is hoisted above imports, so the mock factory uses `vi.hoisted`
// to expose the spy back to the test body.
const { linearStartMock, linearCheckDedupMock, getLinearIssueMock, getSessionContextMock } = vi.hoisted(() => ({
  linearStartMock: vi.fn<(...a: unknown[]) => Promise<{ output: string; exitCode: number }>>(
    async () => ({ output: '', exitCode: 0 }),
  ),
  linearCheckDedupMock: vi.fn<(...a: unknown[]) => Promise<{ output: string; exitCode: number } | null>>(
    async () => null,
  ),
  getLinearIssueMock: vi.fn<(...a: unknown[]) => Promise<Record<string, unknown> | null>>(
    async () => null,
  ),
  getSessionContextMock: vi.fn(() => ({
    slot: null as number | null,
    branch: 'claude/test-branch-ABC',
    host: 'test-host' as string | null,
    agentId: null as number | null,
  })),
}));
vi.mock('./linear.ts', () => ({
  commands: { start: linearStartMock },
  checkDedup: linearCheckDedupMock,
}));
vi.mock('../lib/linear/issues.ts', () => ({
  getIssue: getLinearIssueMock,
}));
vi.mock('../lib/session/session-context.ts', () => ({
  getSessionContext: getSessionContextMock,
  // Re-export so the wiki-server client's slot auto-detection (QUA-616)
  // can call it. Default to "not in a slot" so tests that exercise the
  // wiki-server path don't auto-select PROD_.
  findSlotFromAncestors: vi.fn(() => null),
}));

// Mock wiki-server agent-sessions (best-effort DB sync)
vi.mock('../lib/wiki-server/agent-sessions.ts', () => ({
  upsertAgentSession: vi.fn(async () => ({ ok: true, data: { id: 'test-id' } })),
  updateAgentSession: vi.fn(async () => ({ ok: true })),
  getAgentSessionByBranch: vi.fn(async () => ({ ok: false })),
}));

// Mock the close-time sync helper so the `complete` test can verify
// it's called correctly without exercising the real fs / git / API
// lookups (those are covered by the helper's own tests).
const { syncAndCloseSessionMock } = vi.hoisted(() => ({
  syncAndCloseSessionMock: vi.fn<
    (...a: unknown[]) => Promise<{ fieldsSync: 'ok' | 'failed' | 'noop'; statusSet: boolean }>
  >(async () => ({ fieldsSync: 'ok' as const, statusSet: true })),
}));
vi.mock('../lib/session/session-sync-payload.ts', () => ({
  syncAndCloseSession: syncAndCloseSessionMock,
}));

// Mock the git sync helpers so we can observe which one init picks (QUA-403)
// without actually shelling out to git. The return type is widened (boolean ok,
// optional error/keptBranch) so tests can override with `ok: false` via
// `mockReturnValueOnce`.
const { syncToMainMock, safeSyncMainMock } = vi.hoisted(() => {
  // The hoisted block runs before module imports, so we declare the type
  // inline rather than referencing a top-level type alias.
  type Result = {
    ok: boolean;
    steps: string[];
    error?: string;
    switchedBranch: boolean;
    startBranch: string;
    keptBranch?: boolean;
  };
  return {
    syncToMainMock: vi.fn<() => Result>(() => ({
      ok: true,
      steps: ['Switched claude/foo → main', 'Pulled main (already up to date)'],
      switchedBranch: true,
      startBranch: 'claude/foo',
    })),
    safeSyncMainMock: vi.fn<() => Result>(() => ({
      ok: true,
      steps: ['On feature branch claude/foo — skipping main sync'],
      switchedBranch: false,
      startBranch: 'claude/foo',
      keptBranch: true,
    })),
  };
});
vi.mock('../lib/git.ts', () => ({
  syncToMain: syncToMainMock,
  safeSyncMain: safeSyncMainMock,
}));

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { commands } from './agent-checklist.ts';
import * as githubLib from '../lib/github.ts';
import { buildChecklist, type ChecklistMetadata } from '../lib/session/session-checklist.ts';

const mockGithubApi = vi.mocked(githubLib.githubApi);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);

// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------

describe('agent-checklist init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Wrap `commands.init` so every test bypasses the real git/GitHub side
  // effects (sync-to-main and auto-call to `gh issues start`). Tests that want
  // to exercise those paths can call `commands.init` directly.
  const initNoSideEffects = (args: string[], options: Record<string, unknown> = {}) =>
    commands.init(args, { noSync: true, noIssueStart: true, ...options });

  it('returns usage error when no task description and no --issue', async () => {
    const result = await initNoSideEffects([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
  });

  it('creates checklist with --type=infrastructure', async () => {
    const result = await initNoSideEffects(['Build new feature'], { type: 'infrastructure' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('checklist created');
    expect(result.output).toContain('infrastructure');
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **infrastructure**');
    expect(writtenContent).toContain('Build new feature');
  });

  it('creates checklist with --type=bugfix', async () => {
    const result = await initNoSideEffects(['Fix scoring bug'], { type: 'bugfix' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **bugfix**');
  });

  it('creates checklist with --type=content', async () => {
    const result = await initNoSideEffects(['Write AI safety page'], { type: 'content' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **content**');
    expect(writtenContent).toContain('EntityLinks resolve');
    expect(writtenContent).toContain('MDX escaping');
  });

  it('creates checklist with --type=commands', async () => {
    const result = await initNoSideEffects(['Add session CLI'], { type: 'commands' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **commands**');
  });

  it('creates checklist with --type=refactor', async () => {
    const result = await initNoSideEffects(['Refactor validation'], { type: 'refactor' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **refactor**');
  });

  it('rejects invalid --type', async () => {
    const result = await initNoSideEffects(['Task'], { type: 'invalid' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid type');
    expect(result.output).toContain('content');
  });

  it('auto-detects type from issue labels via --issue', async () => {
    mockGithubApi.mockResolvedValueOnce({
      number: 42,
      title: 'Fix broken scoring',
      labels: [{ name: 'bug' }, { name: 'P1' }],
      html_url: 'https://github.com/test/repo/issues/42',
    });

    const result = await initNoSideEffects([], { issue: '42' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('bugfix');
    expect(result.output).toContain('#42');

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **bugfix**');
    expect(writtenContent).toContain('Issue: #42');
    expect(writtenContent).toContain('Fix broken scoring');
  });

  it('--type overrides issue label detection', async () => {
    mockGithubApi.mockResolvedValueOnce({
      number: 42,
      title: 'Fix something',
      labels: [{ name: 'bug' }],
      html_url: 'https://github.com/test/repo/issues/42',
    });

    const result = await initNoSideEffects([], { issue: '42', type: 'infrastructure' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **infrastructure**');
  });

  it('rejects invalid issue number', async () => {
    const result = await initNoSideEffects([], { issue: 'abc' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid issue number');
  });

  it('handles GitHub API failure gracefully', async () => {
    mockGithubApi.mockRejectedValueOnce(new Error('Not found'));
    const result = await initNoSideEffects([], { issue: '999' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Failed to fetch');
  });

  it('auto-marks issue-tracking as N/A with reason when no issue provided', async () => {
    const result = await initNoSideEffects(['Build a feature'], { type: 'infrastructure' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('issue-tracking auto-marked N/A');

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('[~]');
    expect(writtenContent).toContain('issue-tracking');
    expect(writtenContent).toContain('<!-- N/A: no GitHub issue for this session -->');
  });

  it('does NOT auto-mark issue-tracking as N/A when issue is provided', async () => {
    mockGithubApi.mockResolvedValueOnce({
      number: 5,
      title: 'Add feature',
      labels: [],
      html_url: 'https://github.com/test/repo/issues/5',
    });

    const result = await initNoSideEffects([], { issue: '5' });
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('issue-tracking auto-marked N/A');

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toMatch(/\[ \] `issue-tracking`/);
  });

  it('uses issue title as task when no task arg provided', async () => {
    mockGithubApi.mockResolvedValueOnce({
      number: 10,
      title: 'Add dark mode',
      labels: [{ name: 'enhancement' }],
      html_url: 'https://github.com/test/repo/issues/10',
    });

    const result = await initNoSideEffects([], { issue: '10' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Add dark mode');
  });

  // --- Linear ID detection (QUA-196) ---------------------------------------

  it('auto-detects Linear ID from a claude/qua-NNN-* branch name', async () => {
    // currentBranch() calls execSync with encoding:'utf-8' so the runtime
    // return type is string — the Buffer type the vitest spy sees is a
    // TypeScript artifact from the execSync overloads.
    const { execSync } = await import('child_process');
    (vi.mocked(execSync) as unknown as { mockReturnValueOnce: (v: string) => void })
      .mockReturnValueOnce('claude/qua-184-linear-integration');

    const result = await initNoSideEffects(['Build Linear client library'], {
      type: 'infrastructure',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('QUA-184');

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('> Linear: QUA-184');
  });

  it('accepts an explicit --linear flag', async () => {
    const result = await initNoSideEffects(['A task'], {
      type: 'infrastructure',
      linear: 'QUA-200',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('QUA-200');

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('> Linear: QUA-200');
  });

  it('extracts Linear ID from the task description when the branch is plain', async () => {
    const result = await initNoSideEffects(
      ['working on QUA-91 cleanup'],
      { type: 'infrastructure' }
    );
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('> Linear: QUA-91');
  });

  it('does not render a Linear line when no ID is detected', async () => {
    const result = await initNoSideEffects(['just a plain task'], {
      type: 'infrastructure',
    });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).not.toContain('> Linear:');
    expect(result.output).not.toContain('QUA-');
  });

  it('preserves manually-checked items when re-running init (#3906)', async () => {
    // Simulate an existing checklist with some manually-checked items
    const existingChecklist = `# Session Checklist

> Generated by \`crux agent-checklist init\` at 2026-04-01T12:00:00Z
> Type: **infrastructure**
> Branch: \`claude/test-branch-ABC\`
> Task: Original task

1. [x] \`fix-escaping\` Fix escaping (auto-verify)
2. [ ] \`lockfile-fresh\` Lockfile up to date (auto-verify)
3. [x] \`gate-passes\` Gate passes (auto-verify)
4. [x] \`tests-written\` Tests written for new logic
5. [~] \`retry-safety\` Retries are safe (idempotent endpoints, partial success handled) <!-- N/A: no async endpoints -->
6. [ ] \`security\` No secrets committed; user input sanitized in prompts, SQL, and HTML

## Key Decisions

- Chose approach A over B
`;

    // existsSync returns true for the checklist path (the file already exists)
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(existingChecklist);

    const result = await initNoSideEffects(['New task description'], { type: 'infrastructure' });
    expect(result.exitCode).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    const written = mockWriteFileSync.mock.calls[0][1] as string;

    // Previously-checked items should be preserved
    expect(written).toMatch(/\[x\] `fix-escaping`/);
    expect(written).toMatch(/\[x\] `gate-passes`/);
    expect(written).toMatch(/\[x\] `tests-written`/);

    // N/A items with reason should be preserved
    expect(written).toMatch(/\[~\] `retry-safety`/);
    expect(written).toContain('<!-- N/A: no async endpoints -->');

    // Unchecked items should remain unchecked
    expect(written).toMatch(/\[ \] `security`/);

    // New metadata should be updated (new task, new timestamp)
    expect(written).toContain('New task description');
  });

  it('creates fresh checklist when no existing file (#3906 - first init)', async () => {
    // No existing checklist file
    mockExistsSync.mockReturnValue(false);

    const result = await initNoSideEffects(['Brand new task'], { type: 'infrastructure' });
    expect(result.exitCode).toBe(0);

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    // All items should be unchecked (except issue-tracking which is auto-N/A)
    expect(written).toMatch(/\[ \] `fix-escaping`/);
    expect(written).toMatch(/\[ \] `gate-passes`/);
    expect(written).toMatch(/\[ \] `tests-written`/);
  });

  it('prefers --linear flag over branch or task detection', async () => {
    const { execSync } = await import('child_process');
    (vi.mocked(execSync) as unknown as { mockReturnValueOnce: (v: string) => void })
      .mockReturnValueOnce('claude/qua-184-foo');

    const result = await initNoSideEffects(['mentions QUA-200 in task'], {
      type: 'infrastructure',
      linear: 'QUA-999',
    });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('> Linear: QUA-999');
    expect(writtenContent).not.toContain('> Linear: QUA-184');
  });

  // ── Dedup pre-check (QUA-406) ────────────────────────────────────────────

  describe('Linear dedup pre-check', () => {
    const originalKey = process.env.LINEAR_API_KEY;

    beforeEach(() => {
      // Reset implementations, not just call records. `clearAllMocks` in the
      // outer `beforeEach` doesn't clear queued `mockResolvedValueOnce` values,
      // so without this a test that sets a Once and doesn't consume it (e.g.
      // the `--force` test) will poison the next test's mock queue.
      linearCheckDedupMock.mockReset();
      linearCheckDedupMock.mockResolvedValue(null);
      getLinearIssueMock.mockReset();
      linearStartMock.mockReset();
      linearStartMock.mockResolvedValue({ output: '', exitCode: 0 });

      process.env.LINEAR_API_KEY = 'test-key';
      getLinearIssueMock.mockResolvedValue({
        id: 'uuid-1',
        identifier: 'QUA-406',
        title: 'Test',
        url: 'https://linear.app/qua/QUA-406',
        description: '',
        priority: 2,
        state: { id: 's1', name: 'Backlog', type: 'backlog' },
        team: { id: 't1', key: 'QUA' },
        parent: null,
        project: null,
        labels: { nodes: [] },
      });
    });

    afterEach(() => {
      if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = originalKey;
    });

    it('hard-fails with exit 2 when another session has claimed the issue', async () => {
      linearCheckDedupMock.mockResolvedValueOnce({
        output: 'Active claim from slot a9 on branch claude/qua-406-other',
        exitCode: 2,
      });

      const result = await initNoSideEffects(['Work on QUA-406'], {
        type: 'bugfix',
        linear: 'QUA-406',
      });

      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('Refusing to initialize session');
      expect(result.output).toContain('QUA-406');
      expect(result.output).toContain('--force');
      // CRITICAL: the checklist must NOT have been written.
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      // And the later linear start should not have run either.
      expect(linearStartMock).not.toHaveBeenCalled();
    });

    it('proceeds normally when pre-check finds no collision', async () => {
      linearCheckDedupMock.mockResolvedValueOnce(null);

      const result = await initNoSideEffects(['Work on QUA-406'], {
        type: 'bugfix',
        linear: 'QUA-406',
      });

      expect(result.exitCode).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      expect(linearCheckDedupMock).toHaveBeenCalledTimes(1);
    });

    it('bypasses the pre-check when --force is set', async () => {
      linearCheckDedupMock.mockResolvedValueOnce({
        output: 'Active claim',
        exitCode: 2,
      });

      const result = await initNoSideEffects(['Work on QUA-406'], {
        type: 'bugfix',
        linear: 'QUA-406',
        force: true,
      });

      expect(result.exitCode).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      // Pre-check should not have been consulted at all.
      expect(linearCheckDedupMock).not.toHaveBeenCalled();
      // But the later linear start should still run (with force=true).
      expect(linearStartMock).toHaveBeenCalledWith(
        ['QUA-406'],
        expect.objectContaining({ force: true }),
      );
    });

    it('fails open when the pre-check helper throws', async () => {
      linearCheckDedupMock.mockRejectedValueOnce(new Error('Linear down'));

      const result = await initNoSideEffects(['Work on QUA-406'], {
        type: 'bugfix',
        linear: 'QUA-406',
      });

      expect(result.exitCode).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    });

    it('skips the pre-check when LINEAR_API_KEY is not set', async () => {
      delete process.env.LINEAR_API_KEY;

      const result = await initNoSideEffects(['Work on QUA-406'], {
        type: 'bugfix',
        linear: 'QUA-406',
      });

      expect(result.exitCode).toBe(0);
      expect(linearCheckDedupMock).not.toHaveBeenCalled();
    });
  });

  // ── Fail-loud when agent_sessions write fails (QUA-617) ─────────────────

  describe('agent_sessions write failure', () => {
    let upsertAgentSessionMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const mod = await import('../lib/wiki-server/agent-sessions.ts');
      upsertAgentSessionMock = vi.mocked(mod.upsertAgentSession);
      upsertAgentSessionMock.mockReset();
    });

    it('exits 3 with a loud warning when upsertAgentSession returns ok:false', async () => {
      upsertAgentSessionMock.mockResolvedValueOnce({
        ok: false,
        error: 'unavailable',
        message: 'PROD_LONGTERMWIKI_SERVER_URL not set',
      });

      const result = await initNoSideEffects(['A task'], { type: 'infrastructure' });

      expect(result.exitCode).toBe(3);
      expect(result.output).toContain('agent_sessions row was NOT written');
      expect(result.output).toContain('crux sys sessions list');
      expect(result.output).toContain('QUA-406');
      expect(result.output).toContain('/internal/agent-sessions');
      expect(result.output).toContain('sync-session');
      expect(result.output).toContain('--allow-offline');
      // The specific error message surfaces in the warning.
      expect(result.output).toContain('PROD_LONGTERMWIKI_SERVER_URL not set');
    });

    it('exits 3 when upsertAgentSession throws', async () => {
      upsertAgentSessionMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await initNoSideEffects(['A task'], { type: 'infrastructure' });

      expect(result.exitCode).toBe(3);
      expect(result.output).toContain('agent_sessions row was NOT written');
      expect(result.output).toContain('ECONNREFUSED');
    });

    it('exits 0 when --allow-offline is passed, even if the write failed', async () => {
      upsertAgentSessionMock.mockResolvedValueOnce({
        ok: false,
        error: 'unavailable',
        message: 'boom',
      });

      const result = await initNoSideEffects(['A task'], {
        type: 'infrastructure',
        allowOffline: true,
      });

      expect(result.exitCode).toBe(0);
      // The warning must NOT be printed when --allow-offline opts in.
      expect(result.output).not.toContain('agent_sessions row was NOT written');
    });

    it('exits 0 when the write succeeds', async () => {
      upsertAgentSessionMock.mockResolvedValueOnce({
        ok: true,
        data: { id: 'sess-1' } as never,
      });

      const result = await initNoSideEffects(['A task'], { type: 'infrastructure' });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Synced to wiki-server DB');
      expect(result.output).not.toContain('agent_sessions row was NOT written');
    });
  });

  // ── Branch-safe sync (QUA-403) ─────────────────────────────────────────────

  describe('branch-safe sync', () => {
    beforeEach(() => {
      syncToMainMock.mockClear();
      safeSyncMainMock.mockClear();
    });

    it('default sync uses safeSyncMain — never switches off a feature branch', async () => {
      const result = await commands.init(['A task'], {
        type: 'infrastructure',
        noIssueStart: true,
        noLinearStart: true,
      });

      expect(result.exitCode).toBe(0);
      expect(safeSyncMainMock).toHaveBeenCalledTimes(1);
      expect(syncToMainMock).not.toHaveBeenCalled();
      // Output should reflect the kept-branch path, not the legacy "Synced to main".
      expect(result.output).toContain('Kept feature branch');
      expect(result.output).toContain('skipping main sync');
    });

    it('--reset-to-main opts in to the legacy syncToMain behavior', async () => {
      const result = await commands.init(['A task'], {
        type: 'infrastructure',
        resetToMain: true,
        noIssueStart: true,
        noLinearStart: true,
      });

      expect(result.exitCode).toBe(0);
      expect(syncToMainMock).toHaveBeenCalledTimes(1);
      expect(safeSyncMainMock).not.toHaveBeenCalled();
      expect(result.output).toContain('Synced to main');
      expect(result.output).toContain('Switched claude/foo → main');
    });

    it('--no-sync skips the sync step entirely', async () => {
      const result = await commands.init(['A task'], {
        type: 'infrastructure',
        noSync: true,
        noIssueStart: true,
        noLinearStart: true,
      });

      expect(result.exitCode).toBe(0);
      expect(syncToMainMock).not.toHaveBeenCalled();
      expect(safeSyncMainMock).not.toHaveBeenCalled();
      expect(result.output).not.toContain('Kept feature branch');
      expect(result.output).not.toContain('Synced to main');
    });

    it('aborts with exit 1 when safeSyncMain returns ok:false (dirty tree)', async () => {
      safeSyncMainMock.mockReturnValueOnce({
        ok: false,
        steps: [],
        error: 'Working tree is not clean. Commit, stash, or discard before syncing:\n M file.ts',
        switchedBranch: false,
        startBranch: 'claude/foo',
      });

      const result = await commands.init(['A task'], {
        type: 'infrastructure',
        noIssueStart: true,
        noLinearStart: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Failed to sync to main');
      expect(result.output).toContain('Working tree is not clean');
      // Checklist must NOT be written when sync aborts.
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// default handler — unknown subcommand (QUA-403)
// ---------------------------------------------------------------------------

describe('agent-checklist default (unknown subcommand)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('errors with exit 2 when called with what looks like an unknown subcommand', async () => {
    // Simulates the dispatcher path: `agent-checklist list` →
    //   commandHandler = commands.default; args = ['list', ...]
    const result = await commands.default(['list'], {});
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown subcommand');
    expect(result.output).toContain('"list"');
    expect(result.output).toContain('init, check, verify, status');
    // Crucially, the destructive paths must NOT have been triggered.
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(syncToMainMock).not.toHaveBeenCalled();
    expect(safeSyncMainMock).not.toHaveBeenCalled();
  });

  it('suggests using `init "task description"` for free-text task descriptions', async () => {
    const result = await commands.default(['Add', 'feature'], {});
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('crux sys agent-checklist init "Add feature"');
  });

  it('shows help with exit 1 when no args are given', async () => {
    const result = await commands.default([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('No subcommand specified');
    expect(result.output).toContain('Agent Checklist');
    expect(result.output).toContain('init <task>');
  });

  it('finds the first positional as the unknown subcommand even when flags follow', async () => {
    // The crux dispatcher passes positionals first, flags last:
    // `agent-checklist list --ci` becomes args=['list', '--ci'].
    const result = await commands.default(['list', '--ci'], { ci: true });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown subcommand');
    expect(result.output).toContain('"list"');
  });

  it('quotes the suggested task safely even when it contains shell metacharacters', async () => {
    // If a user types `agent-checklist Add "feature"`, we don't want the
    // suggestion to break shell quoting. JSON.stringify handles this.
    const result = await commands.default(['weird"name', '$VAR'], {});
    expect(result.exitCode).toBe(2);
    // The suggested command should JSON-quote the joined task attempt.
    expect(result.output).toContain('"weird\\"name $VAR"');
  });
});

// ---------------------------------------------------------------------------
// status command
// ---------------------------------------------------------------------------

describe('agent-checklist status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when no checklist file exists', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await commands.status([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('No checklist found');
  });

  it('shows progress for a fresh checklist', async () => {
    const metadata: ChecklistMetadata = {
      task: 'Test',
      branch: 'test-branch',
      timestamp: '2026-02-18T12:00:00Z',
    };
    const md = buildChecklist('infrastructure', metadata);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.status([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Session Checklist');
    expect(result.output).toContain('0%');
  });

  it('shows progress for a partially completed checklist', async () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)
2. [x] \`lockfile-fresh\` Lockfile up to date (auto-verify)
3. [ ] \`gate-passes\` Gate passes (auto-verify)
4. [ ] \`tests-written\` Tests written for new logic
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.status([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('2/4');
    expect(result.output).toContain('50%');
  });

  it('returns JSON when --ci flag set', async () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)
2. [ ] \`gate-passes\` Gate passes (auto-verify)
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.status([], { ci: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.totalChecked).toBe(1);
    expect(parsed.totalItems).toBe(2);
    expect(parsed.allPassing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// complete command
// ---------------------------------------------------------------------------

describe('agent-checklist complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exits 0 with a friendly no-op note when no checklist file exists (QUA-1074)', async () => {
    // /agent-end calls `agent-checklist complete 2>/dev/null || true` — exit 1 here pollutes
    // logs and was getting miscounted as a 10× failure spike by transcript scanners.
    mockExistsSync.mockReturnValue(false);
    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('nothing to complete');
  });

  it('exits 1 when unchecked items remain', async () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)
2. [ ] \`gate-passes\` Gate passes (auto-verify)
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('1 unchecked item');
  });

  it('exits 0 when all items checked', async () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)
2. [x] \`gate-passes\` Gate passes (auto-verify)
3. [x] \`tests-written\` Tests written for new logic
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('All 3 checklist items complete');
  });

  it('treats N/A items as passing', async () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)
2. [~] \`security\` No secrets, no unsanitized input
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('All 2 checklist items complete');
  });

  // QUA-1073: must call syncAndCloseSession so the helper does the
  // split-PATCH (close-time fields, then status as best-effort).
  it('calls syncAndCloseSession with skipPrLookup=true (QUA-1073)', async () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)
2. [x] \`gate-passes\` Gate passes (auto-verify)
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const agentSessions = await import('../lib/wiki-server/agent-sessions.ts');
    const getByBranchMock = vi.mocked(agentSessions.getAgentSessionByBranch);
    syncAndCloseSessionMock.mockClear();

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 42, status: 'active' },
    } as Awaited<ReturnType<typeof agentSessions.getAgentSessionByBranch>>);

    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(0);

    // skipPrLookup: true because `complete` runs before the PR is pushed.
    expect(syncAndCloseSessionMock).toHaveBeenCalledWith(
      42,
      agentSessions.updateAgentSession,
      expect.objectContaining({ branch: 'claude/test-branch-ABC', skipPrLookup: true }),
    );
  });

  // QUA-1073 follow-up: a long session (>2h) gets swept to 'stale'
  // by the periodic sweep before complete runs. We must still
  // populate the close-time fields on explicit close.
  it('calls syncAndCloseSession when session is stale (not just active)', async () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)\n`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const agentSessions = await import('../lib/wiki-server/agent-sessions.ts');
    const getByBranchMock = vi.mocked(agentSessions.getAgentSessionByBranch);
    syncAndCloseSessionMock.mockClear();

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 477, status: 'stale' },
    } as Awaited<ReturnType<typeof agentSessions.getAgentSessionByBranch>>);

    await commands.complete([], {});

    expect(syncAndCloseSessionMock).toHaveBeenCalledWith(
      477,
      expect.any(Function),
      expect.objectContaining({ branch: 'claude/test-branch-ABC', skipPrLookup: true }),
    );
  });

  it('skips sync when session is already completed (terminal state)', async () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)\n`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const agentSessions = await import('../lib/wiki-server/agent-sessions.ts');
    const getByBranchMock = vi.mocked(agentSessions.getAgentSessionByBranch);
    syncAndCloseSessionMock.mockClear();

    getByBranchMock.mockResolvedValueOnce({
      ok: true,
      data: { id: 999, status: 'completed' },
    } as Awaited<ReturnType<typeof agentSessions.getAgentSessionByBranch>>);

    await commands.complete([], {});

    // Re-syncing a completed row would be wasteful (and the status
    // PATCH would be a no-op).
    expect(syncAndCloseSessionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// check command
// ---------------------------------------------------------------------------

describe('agent-checklist check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when --na is used without --reason', async () => {
    const metadata: ChecklistMetadata = {
      task: 'Test',
      branch: 'test-branch',
      timestamp: '2026-02-18T12:00:00Z',
    };
    const md = buildChecklist('infrastructure', metadata);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.check(['fix-escaping'], { na: true });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('--reason is required');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('embeds reason in markdown when --na --reason is used', async () => {
    const metadata: ChecklistMetadata = {
      task: 'Test',
      branch: 'test-branch',
      timestamp: '2026-02-18T12:00:00Z',
    };
    const md = buildChecklist('infrastructure', metadata);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.check(['fix-escaping'], { na: true, reason: 'pure TypeScript, no MDX' });
    expect(result.exitCode).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    const written = mockWriteFileSync.mock.calls[0][1] as string;
    expect(written).toContain('[~]');
    expect(written).toContain('fix-escaping');
    expect(written).toContain('<!-- N/A: pure TypeScript, no MDX -->');
  });

  it('does not require --reason for regular [x] checks', async () => {
    const metadata: ChecklistMetadata = {
      task: 'Test',
      branch: 'test-branch',
      timestamp: '2026-02-18T12:00:00Z',
    };
    const md = buildChecklist('infrastructure', metadata);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.check(['fix-escaping'], {});
    expect(result.exitCode).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// pre-push-check
// ---------------------------------------------------------------------------

describe('agent-checklist pre-push-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exits 0 when no checklist file exists', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await commands['pre-push-check']([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('');
  });

  it('blocks push when checklist is less than 10% complete', async () => {
    const md = `1. [ ] \`fix-escaping\` Fix escaping (auto-verify)
2. [ ] \`lockfile-fresh\` Lockfile up to date (auto-verify)
3. [ ] \`gate-passes\` Gate passes (auto-verify)
4. [ ] \`tests-written\` Tests written for new logic
5. [ ] \`security\` No secrets, no unsanitized input
6. [ ] \`push-ci-green\` Pushed and CI green
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands['pre-push-check']([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Checklist only');
    expect(result.output).toContain('complete');
  });
});
