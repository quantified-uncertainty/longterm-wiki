/**
 * Tests for crux/commands/linear.ts — the CLI handlers that wrap the
 * Linear issue helpers. The transport is fully mocked via vi.hoisted +
 * vi.mock so these tests never hit the network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mocks — vi.mock runs before imports so we hoist the spies.
const {
  getIssueMock,
  getCommentsMock,
  updateIssueMock,
  updateIssueStateMock,
  commentOnIssueMock,
  searchIssuesMock,
  createIssueMock,
  fetchRemoteWorkflowStatesMock,
  listProjectsMock,
  getProjectMock,
  updateProjectMock,
  createProjectUpdateMock,
  githubApiMock,
  getSessionContextMock,
} = vi.hoisted(() => ({
  getIssueMock: vi.fn(),
  getCommentsMock: vi.fn(),
  updateIssueMock: vi.fn(),
  updateIssueStateMock: vi.fn(),
  commentOnIssueMock: vi.fn(),
  searchIssuesMock: vi.fn(),
  createIssueMock: vi.fn(),
  fetchRemoteWorkflowStatesMock: vi.fn(),
  listProjectsMock: vi.fn(),
  getProjectMock: vi.fn(),
  updateProjectMock: vi.fn(),
  createProjectUpdateMock: vi.fn(),
  githubApiMock: vi.fn(),
  getSessionContextMock: vi.fn(() => ({
    slot: 5 as number | null,
    branch: 'claude/qua-184-test-branch',
    host: 'test-host' as string | null,
    agentId: null as number | null,
  })),
}));

vi.mock('../../lib/linear/issues.ts', () => ({
  getIssue: getIssueMock,
  getComments: getCommentsMock,
  updateIssue: updateIssueMock,
  updateIssueState: updateIssueStateMock,
  commentOnIssue: commentOnIssueMock,
  searchIssues: searchIssuesMock,
  createIssue: createIssueMock,
}));

vi.mock('../../lib/linear/projects.ts', () => ({
  listProjects: listProjectsMock,
  getProject: getProjectMock,
  updateProject: updateProjectMock,
  createProjectUpdate: createProjectUpdateMock,
}));

vi.mock('../../lib/linear/workflow-states.ts', () => ({
  fetchRemoteWorkflowStates: fetchRemoteWorkflowStatesMock,
}));

// Mock the GitHub transport so the dedup PR search doesn't hit the network.
vi.mock('../../lib/github.ts', () => ({
  githubApi: githubApiMock,
  REPO: 'quantified-uncertainty/longterm-wiki',
}));

// Mock the session context so the slot is deterministic. Without this,
// `getSessionContext()` walks ancestor dirs and picks up whatever `a<N>`
// the test runner happens to sit in — which is `a5` on the dev laptop
// but `null` on GitHub Actions runners at `/home/runner/work/...`.
// That divergence makes same-slot vs cross-slot dedup tests flaky.
// `buildStartCommentBody` is passed through via importActual since we
// want the production formatting.
vi.mock('../../lib/session/session-context.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/session/session-context.ts')>(
    '../../lib/session/session-context.ts',
  );
  return {
    ...actual,
    getSessionContext: getSessionContextMock,
  };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'claude/qua-184-test-branch'),
}));

import { commands } from '../linear.ts';

const mockIssue = {
  id: 'uuid-1',
  identifier: 'QUA-184',
  title: 'Test issue',
  description: 'body content',
  priority: 2,
  url: 'https://linear.app/quantifieduncertainty/issue/QUA-184',
  state: { id: 'state-1', name: 'Backlog', type: 'backlog' },
  team: { id: 'team-1', key: 'QUA' },
  parent: null,
  project: null,
  labels: { nodes: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset mock implementations too — clearAllMocks only clears call records
  // and leaves queued `mockResolvedValueOnce` values intact. Without this,
  // a test that queues a Once value without consuming it will poison the
  // next test's mock queue.
  getIssueMock.mockReset();
  getCommentsMock.mockReset();
  githubApiMock.mockReset();
  // Default: dedup checks find nothing. Individual tests override.
  getCommentsMock.mockResolvedValue([]);
  githubApiMock.mockResolvedValue({ items: [] });
});

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

describe('linear view', () => {
  it('prints usage when no identifier is given', async () => {
    const r = await commands.view([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('prints not-found when the issue does not exist', async () => {
    getIssueMock.mockResolvedValueOnce(null);
    const r = await commands.view(['QUA-9999'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not found');
  });

  it('prints the full issue on success', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    getCommentsMock.mockResolvedValueOnce([]);

    const r = await commands.view(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('QUA-184');
    expect(r.output).toContain('Test issue');
    expect(r.output).toContain('Backlog');
  });

  it('emits JSON when --json is set', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    getCommentsMock.mockResolvedValueOnce([]);

    const r = await commands.view(['QUA-184'], { ci: true, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.output);
    expect(parsed.issue.identifier).toBe('QUA-184');
    expect(parsed.comments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('linear search', () => {
  it('prints usage when the query is empty', async () => {
    const r = await commands.search([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('filters out --flag args from the query string', async () => {
    // The CLI dispatcher appends flags as positional args — the handler
    // must filter them out so `--limit=5` doesn't leak into the query.
    searchIssuesMock.mockResolvedValueOnce([]);
    await commands.search(['agent', 'tooling', '--limit=5'], { ci: true, limit: '5' });

    expect(searchIssuesMock).toHaveBeenCalledWith('agent tooling', 5);
  });

  it('passes --limit as the numeric limit', async () => {
    searchIssuesMock.mockResolvedValueOnce([]);
    await commands.search(['foo'], { ci: true, limit: '3' });
    expect(searchIssuesMock).toHaveBeenCalledWith('foo', 3);
  });

  it('prints a tidy no-matches message on empty results', async () => {
    searchIssuesMock.mockResolvedValueOnce([]);
    const r = await commands.search(['foo'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('No matches');
  });

  it('prints results in a readable format', async () => {
    searchIssuesMock.mockResolvedValueOnce([
      {
        identifier: 'QUA-1',
        title: 'A title',
        priority: 2,
        state: { name: 'Backlog', type: 'backlog' },
        url: 'u',
      },
    ]);
    const r = await commands.search(['foo'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('QUA-1');
    expect(r.output).toContain('A title');
    expect(r.output).toContain('high'); // priority 2 = high
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('linear create', () => {
  const createdIssue = {
    identifier: 'QUA-999',
    url: 'https://linear.app/quantifieduncertainty/issue/QUA-999',
  };

  beforeEach(() => {
    createIssueMock.mockResolvedValue(createdIssue);
  });

  it('prints usage when no title is given', async () => {
    const r = await commands.create([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('creates an issue with just a title', async () => {
    const r = await commands.create(['My', 'ticket'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(createIssueMock).toHaveBeenCalledWith({
      title: 'My ticket',
      description: '',
      priority: undefined,
      parentId: undefined,
      projectId: undefined,
    });
    expect(r.output).toContain('QUA-999');
  });

  it('resolves --parent QUA-NNN to the parent UUID', async () => {
    getIssueMock.mockResolvedValueOnce({ ...mockIssue, id: 'parent-uuid', title: 'Epic' });
    const r = await commands.create(['Child ticket'], { ci: true, parent: 'QUA-184' });
    expect(r.exitCode).toBe(0);
    expect(getIssueMock).toHaveBeenCalledWith('QUA-184');
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'parent-uuid' }),
    );
    expect(r.output).toContain('parent:');
    expect(r.output).toContain('QUA-184');
  });

  it('fails cleanly when --parent issue does not exist', async () => {
    getIssueMock.mockResolvedValueOnce(null);
    const r = await commands.create(['Child'], { ci: true, parent: 'QUA-9999' });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Parent issue not found');
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it('resolves --project name to the project UUID', async () => {
    getProjectMock.mockResolvedValueOnce({
      id: 'project-uuid',
      name: 'Data Model Unwind',
    });
    const r = await commands.create(['Ticket'], {
      ci: true,
      project: 'Data Model Unwind',
    });
    expect(r.exitCode).toBe(0);
    expect(getProjectMock).toHaveBeenCalledWith('Data Model Unwind');
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-uuid' }),
    );
    expect(r.output).toContain('project:');
    expect(r.output).toContain('Data Model Unwind');
  });

  it('fails cleanly when --project does not exist', async () => {
    getProjectMock.mockResolvedValueOnce(null);
    const r = await commands.create(['Ticket'], { ci: true, project: 'Nonexistent' });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Project not found');
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it('combines --parent, --project, and --priority in one call', async () => {
    getIssueMock.mockResolvedValueOnce({ ...mockIssue, id: 'parent-uuid', title: 'Epic' });
    getProjectMock.mockResolvedValueOnce({ id: 'project-uuid', name: 'Proj' });
    const r = await commands.create(['Ticket'], {
      ci: true,
      parent: 'QUA-408',
      project: 'Proj',
      priority: '2',
    });
    expect(r.exitCode).toBe(0);
    expect(createIssueMock).toHaveBeenCalledWith({
      title: 'Ticket',
      description: '',
      priority: 2,
      parentId: 'parent-uuid',
      projectId: 'project-uuid',
    });
  });

  // ── QUA-516: parent-project inheritance ───────────────────────────────────

  it('inherits the parent project when --project is omitted', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...mockIssue,
      id: 'parent-uuid',
      title: 'Epic',
      project: { id: 'inherited-project-uuid', name: 'Data Model Unwind' },
    });
    const r = await commands.create(['Child ticket'], {
      ci: true,
      parent: 'QUA-408',
    });
    expect(r.exitCode).toBe(0);
    // No getProject lookup needed — the inherited UUID is on the parent.
    expect(getProjectMock).not.toHaveBeenCalled();
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: 'parent-uuid',
        projectId: 'inherited-project-uuid',
      }),
    );
    expect(r.output).toContain('Data Model Unwind');
    expect(r.output).toContain('inherited from parent');
  });

  it('explicit --project overrides parent inheritance', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...mockIssue,
      id: 'parent-uuid',
      title: 'Epic',
      project: { id: 'parent-project-uuid', name: 'Parent Project' },
    });
    getProjectMock.mockResolvedValueOnce({
      id: 'override-project-uuid',
      name: 'Other Project',
    });
    const r = await commands.create(['Child'], {
      ci: true,
      parent: 'QUA-408',
      project: 'Other Project',
    });
    expect(r.exitCode).toBe(0);
    expect(getProjectMock).toHaveBeenCalledWith('Other Project');
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: 'parent-uuid',
        projectId: 'override-project-uuid',
      }),
    );
    expect(r.output).toContain('Other Project');
    expect(r.output).not.toContain('inherited from parent');
  });

  it('does not set a project when parent has none and --project is omitted', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...mockIssue,
      id: 'parent-uuid',
      title: 'Epic',
      project: null,
    });
    const r = await commands.create(['Child'], { ci: true, parent: 'QUA-408' });
    expect(r.exitCode).toBe(0);
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: 'parent-uuid',
        projectId: undefined,
      }),
    );
    expect(r.output).not.toContain('inherited from parent');
  });

  // ── Ticket-sizing red flags (QUA-575) ────────────────────────────────────

  it('refuses creation with exit=2 when title contains red-flag tokens', async () => {
    const r = await commands.create(['Phase 2: closeout'], { ci: true });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('phase-or-wave');
    expect(r.output).toContain('--allow-big');
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it('refuses creation when description contains red-flag tokens', async () => {
    const r = await commands.create(['Update tooling'], {
      ci: true,
      description: 'We need to migrate 5,000 facts into the new schema.',
    });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('row-count-batching');
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it('does not warn on ordinary tickets', async () => {
    const r = await commands.create(['Fix typo in README'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain('red flag');
    expect(createIssueMock).toHaveBeenCalled();
  });

  it('proceeds when --allow-big is set despite red flags', async () => {
    // Capture stderr so the test environment doesn't print the warning.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const r = await commands.create(
        ['Phase 2: migrate 5,000 rows across `foo`, `bar`, `baz`'],
        { ci: true, allowBig: true },
      );
      expect(r.exitCode).toBe(0);
      expect(createIssueMock).toHaveBeenCalled();
      // Warning was printed to stderr (not stdout) so --json consumers don't see it.
      expect(stderrSpy).toHaveBeenCalled();
      const stderrContent = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrContent).toContain('phase-or-wave');
      expect(stderrContent).toContain('row-count-batching');
      expect(stderrContent).toContain('multi-table-enumeration');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('detects all three flags from the canonical example', async () => {
    const r = await commands.create(
      ['Phase 2: migrate 5,000 rows across `foo`, `bar`, `baz`'],
      { ci: true },
    );
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('phase-or-wave');
    expect(r.output).toContain('row-count-batching');
    expect(r.output).toContain('multi-table-enumeration');
  });

  it('emits structured JSON on red-flag refusal when --json is set', async () => {
    const r = await commands.create(['Phase 2: closeout'], {
      ci: true,
      json: true,
    });
    expect(r.exitCode).toBe(2);
    // Output must be valid JSON — no ANSI color codes, no warning text.
    const parsed = JSON.parse(r.output);
    expect(parsed.error).toBe('ticket-sizing-red-flag');
    expect(Array.isArray(parsed.flags)).toBe(true);
    expect(parsed.flags[0].kind).toBe('phase-or-wave');
    expect(parsed.hint).toContain('--allow-big');
    expect(createIssueMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// update — QUA-516
// ---------------------------------------------------------------------------

describe('linear update', () => {
  beforeEach(() => {
    updateIssueMock.mockResolvedValue({ identifier: 'QUA-184' });
  });

  it('prints usage when no ID is given', async () => {
    const r = await commands.update([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('prints not-found when the issue does not exist', async () => {
    getIssueMock.mockResolvedValueOnce(null);
    const r = await commands.update(['QUA-9999'], {
      ci: true,
      project: 'Some Project',
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not found');
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it('rejects when no fields are provided', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Nothing to update');
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it('updates the project by name', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    getProjectMock.mockResolvedValueOnce({
      id: 'project-uuid',
      name: 'Data Model Unwind',
    });
    const r = await commands.update(['QUA-184'], {
      ci: true,
      project: 'Data Model Unwind',
    });
    expect(r.exitCode).toBe(0);
    expect(updateIssueMock).toHaveBeenCalledWith('QUA-184', {
      projectId: 'project-uuid',
    });
    expect(r.output).toContain('Data Model Unwind');
  });

  it('clears the project with --project=none', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      project: 'none',
    });
    expect(r.exitCode).toBe(0);
    expect(getProjectMock).not.toHaveBeenCalled();
    expect(updateIssueMock).toHaveBeenCalledWith('QUA-184', {
      projectId: null,
    });
    expect(r.output).toContain('cleared');
  });

  it('fails cleanly when --project does not match a known project', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    getProjectMock.mockResolvedValueOnce(null);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      project: 'Nonexistent',
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Project not found');
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it('updates priority + title in one call', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      priority: '2',
      title: 'Clearer title',
    });
    expect(r.exitCode).toBe(0);
    expect(updateIssueMock).toHaveBeenCalledWith('QUA-184', {
      priority: 2,
      title: 'Clearer title',
    });
  });

  it('rejects an out-of-range priority', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      priority: '99',
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Invalid priority');
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it('clears the parent with --parent=none', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      parent: 'none',
    });
    expect(r.exitCode).toBe(0);
    expect(updateIssueMock).toHaveBeenCalledWith('QUA-184', {
      parentId: null,
    });
  });

  it('resolves --parent QUA-NNN to the parent UUID', async () => {
    getIssueMock
      .mockResolvedValueOnce(mockIssue) // initial issue lookup
      .mockResolvedValueOnce({ ...mockIssue, id: 'parent-uuid', identifier: 'QUA-408' }); // parent lookup
    const r = await commands.update(['QUA-184'], {
      ci: true,
      parent: 'QUA-408',
    });
    expect(r.exitCode).toBe(0);
    expect(updateIssueMock).toHaveBeenCalledWith('QUA-184', {
      parentId: 'parent-uuid',
    });
  });

  it('emits JSON when --json is set', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      json: true,
      priority: '3',
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.output);
    expect(parsed.identifier).toBe('QUA-184');
    expect(parsed.changed).toEqual(['priority=medium']);
  });

  // ── Bare-flag rejection (boolean coercion guard) ────────────────────────

  it('rejects bare --project (boolean true) instead of crashing', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      // Mimics the CLI parser: `--project` with no value becomes boolean true.
      project: true as unknown as string,
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('--project requires a value');
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it('rejects bare --parent', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      parent: true as unknown as string,
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('--parent requires a value');
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it('rejects bare --title', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      title: true as unknown as string,
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('--title requires a value');
  });

  it('rejects empty --title (would clobber the issue title)', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      title: '',
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('--title cannot be empty');
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it('updates description from --description-file', async () => {
    const { writeFileSync, unlinkSync, mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'linear-test-'));
    const file = join(dir, 'desc.md');
    writeFileSync(file, '## New body');

    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      descriptionFile: file,
    });
    expect(r.exitCode).toBe(0);
    expect(updateIssueMock).toHaveBeenCalledWith('QUA-184', {
      description: '## New body',
    });
    unlinkSync(file);
  });

  it('reports failure when parent issue does not exist', async () => {
    getIssueMock
      .mockResolvedValueOnce(mockIssue) // initial issue lookup OK
      .mockResolvedValueOnce(null);     // parent lookup fails
    const r = await commands.update(['QUA-184'], {
      ci: true,
      parent: 'QUA-9999',
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Parent issue not found');
    expect(updateIssueMock).not.toHaveBeenCalled();
  });

  it('rejects negative priority', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      priority: '-1',
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Invalid priority');
  });

  it('rejects priority above 4', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const r = await commands.update(['QUA-184'], {
      ci: true,
      priority: '5',
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Invalid priority');
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe('linear start', () => {
  it('prints usage when no ID is given', async () => {
    const r = await commands.start([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('prints not-found when the issue does not exist', async () => {
    getIssueMock.mockResolvedValueOnce(null);
    const r = await commands.start(['QUA-9999'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not found');
  });

  it('moves the issue to In Progress and posts a start comment', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'In Progress',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.start(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(updateIssueStateMock).toHaveBeenCalledWith('QUA-184', 'In Progress');
    expect(commentOnIssueMock).toHaveBeenCalledWith(
      'QUA-184',
      expect.stringContaining('starting work')
    );
    const commentBody = commentOnIssueMock.mock.calls[0][1];
    // Branch name (from mocked execSync) is in the comment
    expect(commentBody).toContain('claude/qua-184-test-branch');
    // Enriched fields (QUA-336): branch is a claude/* branch so no main warning
    expect(commentBody).not.toContain('⚠');
    // Host is always set (from os.hostname()) — assert the field label is present
    expect(commentBody).toContain('**Host:**');
  });

  // ── Dedup (QUA-406) ──────────────────────────────────────────────────────

  it('blocks with exit=2 when another slot has a recent unreleased start claim', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    // Recent start from a9 (different slot) — no finish comment after it.
    getCommentsMock.mockResolvedValueOnce([
      {
        id: 'c1',
        body:
          '🤖 Claude Code starting work on this issue.\n\n' +
          '**Slot:** a9\n' +
          '**Branch:** `claude/qua-184-other-work`\n' +
          '**Host:** MacBook-Pro-4.local\n',
        createdAt: new Date().toISOString(),
        user: { name: 'bot' },
      },
    ]);

    const r = await commands.start(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('already claimed');
    expect(r.output).toContain('a9');
    expect(r.output).toContain('claude/qua-184-other-work');
    expect(r.output).toContain('--force');
    // No state change or comment should have been posted.
    expect(updateIssueStateMock).not.toHaveBeenCalled();
    expect(commentOnIssueMock).not.toHaveBeenCalled();
  });

  it('allows re-running start from the same slot (init crash recovery)', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    // Prior start from the SAME slot as the test runner. The tests run from
    // `.../lw/a5/...` so `getSessionContext().slot === 5`. A prior claim from
    // a5 is treated as our own earlier session resuming, not a collision.
    getCommentsMock.mockResolvedValueOnce([
      {
        id: 'c1',
        body:
          '🤖 Claude Code starting work on this issue.\n\n' +
          '**Slot:** a5\n' +
          '**Branch:** `claude/qua-184-earlier-attempt`\n',
        createdAt: new Date().toISOString(),
        user: { name: 'bot' },
      },
    ]);
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'In Progress',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.start(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(updateIssueStateMock).toHaveBeenCalled();
  });

  it('treats stale (>24h) start comments as released', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const oldTs = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    getCommentsMock.mockResolvedValueOnce([
      {
        id: 'c1',
        body:
          '🤖 Claude Code starting work on this issue.\n\n' +
          '**Slot:** a9\n**Branch:** `claude/qua-184-stale`\n',
        createdAt: oldTs,
        user: { name: 'bot' },
      },
    ]);
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'In Progress',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.start(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
  });

  it('treats a finish comment as releasing prior start claims', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    const now = Date.now();
    getCommentsMock.mockResolvedValueOnce([
      {
        id: 'c1',
        body:
          '🤖 Claude Code starting work on this issue.\n\n' +
          '**Slot:** a9\n**Branch:** `claude/qua-184-done`\n',
        createdAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
        user: { name: 'bot' },
      },
      {
        id: 'c2',
        body: '🤖 Claude Code finished work on this issue.',
        createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        user: { name: 'bot' },
      },
    ]);
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'In Progress',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.start(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
  });

  it('blocks with exit=2 when an open PR mentions the Linear ID', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    githubApiMock.mockResolvedValueOnce({
      items: [
        {
          number: 4296,
          title: 'fix(sourcing): eliminate raw ID leaks (QUA-184)',
          html_url: 'https://github.com/quantified-uncertainty/longterm-wiki/pull/4296',
          body: 'Fixes QUA-184',
          pull_request: {},
        },
      ],
    });

    const r = await commands.start(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain('#4296');
    expect(r.output).toContain('already claimed');
    expect(updateIssueStateMock).not.toHaveBeenCalled();
    expect(commentOnIssueMock).not.toHaveBeenCalled();
  });

  it('--force bypasses dedup and annotates the start comment', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    getCommentsMock.mockResolvedValueOnce([
      {
        id: 'c1',
        body:
          '🤖 Claude Code starting work on this issue.\n\n' +
          '**Slot:** a9\n**Branch:** `claude/qua-184-other`\n',
        createdAt: new Date().toISOString(),
        user: { name: 'bot' },
      },
    ]);
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'In Progress',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.start(['QUA-184'], { ci: true, force: true });
    expect(r.exitCode).toBe(0);
    expect(updateIssueStateMock).toHaveBeenCalled();
    const commentBody = commentOnIssueMock.mock.calls[0][1];
    expect(commentBody).toContain('Claimed with `--force`');
    // When --force is set, the dedup API shouldn't have been called at all.
    expect(getCommentsMock).not.toHaveBeenCalled();
    expect(githubApiMock).not.toHaveBeenCalled();
  });

  it('fails open when the Linear comments API throws', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    getCommentsMock.mockRejectedValueOnce(new Error('Linear is down'));
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'In Progress',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.start(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(updateIssueStateMock).toHaveBeenCalled();
  });

  it('fails open when the GitHub search API throws', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    githubApiMock.mockRejectedValueOnce(new Error('rate limit exceeded'));
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'In Progress',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.start(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(updateIssueStateMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// done — CRITICAL: branching logic between "In Review" (with PR) and "Done"
// ---------------------------------------------------------------------------

describe('linear done', () => {
  it('prints usage when no ID is given', async () => {
    const r = await commands.done([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('moves to In Review and includes the PR URL in the comment when --pr is set', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'In Review',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.done(['QUA-184'], {
      ci: true,
      pr: 'https://github.com/example/repo/pull/42',
    });
    expect(r.exitCode).toBe(0);
    expect(updateIssueStateMock).toHaveBeenCalledWith('QUA-184', 'In Review');

    const commentBody = commentOnIssueMock.mock.calls[0][1];
    expect(commentBody).toContain('finished work');
    expect(commentBody).toContain('https://github.com/example/repo/pull/42');
    expect(r.output).toContain('In Review');
  });

  it('moves straight to Done when --pr is NOT set', async () => {
    getIssueMock.mockResolvedValueOnce(mockIssue);
    updateIssueStateMock.mockResolvedValueOnce({
      identifier: 'QUA-184',
      state: 'Done',
    });
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.done(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(updateIssueStateMock).toHaveBeenCalledWith('QUA-184', 'Done');

    const commentBody = commentOnIssueMock.mock.calls[0][1];
    expect(commentBody).not.toContain('**PR:**');
    expect(r.output).toContain('Done');
  });

  it('prints not-found when the issue does not exist', async () => {
    getIssueMock.mockResolvedValueOnce(null);
    const r = await commands.done(['QUA-99999'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not found');
    expect(updateIssueStateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// comment
// ---------------------------------------------------------------------------

describe('linear comment', () => {
  it('prints usage when no ID is given', async () => {
    const r = await commands.comment([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
  });

  it('rejects an empty body', async () => {
    const r = await commands.comment(['QUA-184'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('empty');
  });

  it('posts the inline body when provided', async () => {
    commentOnIssueMock.mockResolvedValueOnce(undefined);

    const r = await commands.comment(['QUA-184', 'hello', 'world'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(commentOnIssueMock).toHaveBeenCalledWith('QUA-184', 'hello world');
  });

  it('filters out --flag args from the inline body', async () => {
    commentOnIssueMock.mockResolvedValueOnce(undefined);
    await commands.comment(
      ['QUA-184', 'a', 'note', '--body-file=ignored.md'],
      { ci: true }
    );
    // args.slice(1) with flag filter should produce "a note" (no --body-file=...)
    const [, body] = commentOnIssueMock.mock.calls[0];
    expect(body).toBe('a note');
  });
});

// ---------------------------------------------------------------------------
// states-list
// ---------------------------------------------------------------------------

describe('linear states-list', () => {
  it('prints state names in position order', async () => {
    fetchRemoteWorkflowStatesMock.mockResolvedValueOnce([
      { id: 's1', name: 'Done', type: 'completed', position: 3 },
      { id: 's2', name: 'Backlog', type: 'backlog', position: 0 },
      { id: 's3', name: 'In Progress', type: 'started', position: 2 },
    ]);

    const r = await commands['states-list']([], { ci: true });
    expect(r.exitCode).toBe(0);
    // Should be sorted: Backlog (0), In Progress (2), Done (3)
    const backlogIdx = r.output.indexOf('Backlog');
    const progressIdx = r.output.indexOf('In Progress');
    const doneIdx = r.output.indexOf('Done');
    expect(backlogIdx).toBeGreaterThanOrEqual(0);
    expect(progressIdx).toBeGreaterThan(backlogIdx);
    expect(doneIdx).toBeGreaterThan(progressIdx);
  });

  it('emits JSON when --json is set', async () => {
    fetchRemoteWorkflowStatesMock.mockResolvedValueOnce([
      { id: 's1', name: 'Backlog', type: 'backlog', position: 0 },
    ]);
    const r = await commands['states-list']([], { ci: true, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Backlog');
  });
});

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe('linear parse', () => {
  it('prints the canonical ID when one is found', async () => {
    const r = await commands.parse(['claude/qua-184-foo'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe('QUA-184');
  });

  it('exits non-zero when no ID is found', async () => {
    const r = await commands.parse(['no id'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('No Linear ID found');
  });

  it('filters out --flag args from the parse input', async () => {
    const r = await commands.parse(['claude/qua-184-foo', '--json'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe('QUA-184');
  });
});

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

const mockProject = {
  id: '6f9c8f44-7d33-4573-a017-a2200b8b22da',
  name: 'Content Quality & Enrichment',
  description: 'Editorial workstreams.',
  content: '# Long-form body',
  state: 'backlog',
  progress: 0.2,
  startDate: null,
  targetDate: '2026-05-01',
  url: 'https://linear.app/quantifieduncertainty/project/content-quality-enrichment-xyz',
  updatedAt: '2026-04-13T00:00:00Z',
  lead: null,
};

describe('linear project', () => {
  it('prints help when no subcommand given', async () => {
    const r = await commands.project([], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Usage');
    expect(r.output).toContain('list');
    expect(r.output).toContain('view');
    expect(r.output).toContain('update');
    expect(r.output).toContain('comment');
  });

  it('prints help for "help" subcommand with exit 0', async () => {
    const r = await commands.project(['help'], { ci: true });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('Usage');
  });

  it('rejects unknown subcommand', async () => {
    const r = await commands.project(['foo'], { ci: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Unknown subcommand');
  });

  describe('list', () => {
    it('prints all projects grouped by state', async () => {
      listProjectsMock.mockResolvedValueOnce([
        mockProject,
        { ...mockProject, id: 'x', name: 'Done Project', state: 'completed', progress: 1 },
      ]);
      const r = await commands.project(['list'], { ci: true });
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('Content Quality & Enrichment');
      expect(r.output).toContain('Done Project');
    });

    it('emits JSON with --json', async () => {
      listProjectsMock.mockResolvedValueOnce([mockProject]);
      const r = await commands.project(['list'], { ci: true, json: true });
      const parsed = JSON.parse(r.output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('Content Quality & Enrichment');
    });
  });

  describe('view', () => {
    it('prints usage when no ref given', async () => {
      const r = await commands.project(['view'], { ci: true });
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('Usage');
    });

    it('prints not-found when project is missing', async () => {
      getProjectMock.mockResolvedValueOnce(null);
      const r = await commands.project(['view', 'Nope'], { ci: true });
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('not found');
    });

    it('prints the project body on success', async () => {
      getProjectMock.mockResolvedValueOnce(mockProject);
      const r = await commands.project(['view', 'Content Quality & Enrichment'], { ci: true });
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('Content Quality & Enrichment');
      expect(r.output).toContain('Long-form body');
      expect(r.output).toContain('Editorial workstreams');
    });

    it('emits JSON with --json', async () => {
      getProjectMock.mockResolvedValueOnce(mockProject);
      const r = await commands.project(['view', 'Content Quality & Enrichment'], { ci: true, json: true });
      const parsed = JSON.parse(r.output);
      expect(parsed.name).toBe('Content Quality & Enrichment');
    });
  });

  describe('update', () => {
    it('prints usage when no ref given', async () => {
      const r = await commands.project(['update'], { ci: true });
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('Usage');
    });

    it('rejects when no fields to update', async () => {
      getProjectMock.mockResolvedValueOnce(mockProject);
      const r = await commands.project(['update', 'Content Quality & Enrichment'], { ci: true });
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('Nothing to update');
      expect(updateProjectMock).not.toHaveBeenCalled();
    });

    it('applies inline --description and --content updates', async () => {
      getProjectMock.mockResolvedValueOnce(mockProject);
      updateProjectMock.mockResolvedValueOnce({ ...mockProject, description: 'New', content: 'New body' });
      const r = await commands.project(
        ['update', 'Content Quality & Enrichment'],
        { ci: true, description: 'New', content: 'New body' },
      );
      expect(r.exitCode).toBe(0);
      expect(updateProjectMock).toHaveBeenCalledWith(mockProject.id, {
        description: 'New',
        content: 'New body',
      });
    });

    it('reads content from --content-file', async () => {
      // writeFileSync before import: use a temp file path that exists
      const { writeFileSync, unlinkSync, mkdtempSync } = await import('fs');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const dir = mkdtempSync(join(tmpdir(), 'linear-test-'));
      const file = join(dir, 'content.md');
      writeFileSync(file, '# From file');

      getProjectMock.mockResolvedValueOnce(mockProject);
      updateProjectMock.mockResolvedValueOnce({ ...mockProject, content: '# From file' });

      const r = await commands.project(
        ['update', 'Content Quality & Enrichment'],
        { ci: true, contentFile: file },
      );
      expect(r.exitCode).toBe(0);
      expect(updateProjectMock).toHaveBeenCalledWith(mockProject.id, {
        content: '# From file',
      });
      unlinkSync(file);
    });

    it('applies name/state/start-date/target-date updates', async () => {
      getProjectMock.mockResolvedValueOnce(mockProject);
      updateProjectMock.mockResolvedValueOnce({ ...mockProject, name: 'Renamed', state: 'started' });
      const r = await commands.project(
        ['update', 'Content Quality & Enrichment'],
        {
          ci: true,
          name: 'Renamed',
          state: 'started',
          startDate: '2026-05-01',
          targetDate: '2026-06-30',
        },
      );
      expect(r.exitCode).toBe(0);
      expect(updateProjectMock).toHaveBeenCalledWith(mockProject.id, {
        name: 'Renamed',
        state: 'started',
        startDate: '2026-05-01',
        targetDate: '2026-06-30',
      });
    });

    it('content-file takes precedence over inline --content', async () => {
      const { writeFileSync, unlinkSync, mkdtempSync } = await import('fs');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const dir = mkdtempSync(join(tmpdir(), 'linear-test-'));
      const file = join(dir, 'content.md');
      writeFileSync(file, 'from file');

      getProjectMock.mockResolvedValueOnce(mockProject);
      updateProjectMock.mockResolvedValueOnce(mockProject);

      await commands.project(
        ['update', 'Content Quality & Enrichment'],
        { ci: true, content: 'inline', contentFile: file },
      );
      expect(updateProjectMock).toHaveBeenCalledWith(mockProject.id, {
        content: 'from file',
      });
      unlinkSync(file);
    });
  });

  describe('comment', () => {
    it('prints usage when no ref given', async () => {
      const r = await commands.project(['comment'], { ci: true });
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('Usage');
    });

    it('rejects empty body', async () => {
      getProjectMock.mockResolvedValueOnce(mockProject);
      const r = await commands.project(['comment', 'Content Quality & Enrichment'], { ci: true });
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('Empty body');
      expect(createProjectUpdateMock).not.toHaveBeenCalled();
    });

    it('posts an inline comment', async () => {
      getProjectMock.mockResolvedValueOnce(mockProject);
      createProjectUpdateMock.mockResolvedValueOnce(undefined);
      const r = await commands.project(
        ['comment', 'Content Quality & Enrichment', 'Shipped', 'phase', '5'],
        { ci: true },
      );
      expect(r.exitCode).toBe(0);
      expect(createProjectUpdateMock).toHaveBeenCalledWith(mockProject.id, 'Shipped phase 5');
    });

    it('rejects a whitespace-only --body-file body', async () => {
      const { writeFileSync, unlinkSync, mkdtempSync } = await import('fs');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const dir = mkdtempSync(join(tmpdir(), 'linear-test-'));
      const file = join(dir, 'blank.md');
      writeFileSync(file, '   \n\t\n  ');

      getProjectMock.mockResolvedValueOnce(mockProject);
      const r = await commands.project(
        ['comment', 'Content Quality & Enrichment'],
        { ci: true, bodyFile: file },
      );
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('Empty body');
      expect(createProjectUpdateMock).not.toHaveBeenCalled();
      unlinkSync(file);
    });

    it('reads comment body from --body-file', async () => {
      const { writeFileSync, unlinkSync, mkdtempSync } = await import('fs');
      const { tmpdir } = await import('os');
      const { join } = await import('path');
      const dir = mkdtempSync(join(tmpdir(), 'linear-test-'));
      const file = join(dir, 'body.md');
      writeFileSync(file, 'From file body');

      getProjectMock.mockResolvedValueOnce(mockProject);
      createProjectUpdateMock.mockResolvedValueOnce(undefined);
      const r = await commands.project(
        ['comment', 'Content Quality & Enrichment'],
        { ci: true, bodyFile: file },
      );
      expect(r.exitCode).toBe(0);
      expect(createProjectUpdateMock).toHaveBeenCalledWith(mockProject.id, 'From file body');
      unlinkSync(file);
    });
  });
});
