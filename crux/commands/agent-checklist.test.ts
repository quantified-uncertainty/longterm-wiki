/**
 * Tests for crux/commands/agent-checklist.ts
 *
 * Focus areas:
 * - init: generates checklist for each type, handles --issue, validates args
 * - status: parses checklist file, handles missing file
 * - complete: validates all items checked, returns correct exit codes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

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

// Mock child_process for currentBranch
vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'claude/test-branch-ABC'),
}));

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { commands } from './agent-checklist.ts';
import * as githubLib from '../lib/github.ts';
import { buildChecklist, type ChecklistMetadata } from '../lib/session-checklist.ts';

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

  it('returns usage error when no task description and no --issue', async () => {
    const result = await commands.init([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
  });

  it('creates checklist with --type=infrastructure', async () => {
    const result = await commands.init(['Build new feature'], { type: 'infrastructure' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('checklist created');
    expect(result.output).toContain('infrastructure');
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    // Verify written markdown contains correct type
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **infrastructure**');
    expect(writtenContent).toContain('Build new feature');
  });

  it('creates checklist with --type=bugfix', async () => {
    const result = await commands.init(['Fix scoring bug'], { type: 'bugfix' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **bugfix**');
    expect(writtenContent).toContain('Root cause identified');
    expect(writtenContent).toContain('Regression test');
  });

  it('creates checklist with --type=content', async () => {
    const result = await commands.init(['Write AI safety page'], { type: 'content' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **content**');
    expect(writtenContent).toContain('EntityLinks resolve');
    expect(writtenContent).toContain('Content accuracy');
  });

  it('creates checklist with --type=commands', async () => {
    const result = await commands.init(['Add session CLI'], { type: 'commands' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **commands**');
    expect(writtenContent).toContain('Command registered');
  });

  it('creates checklist with --type=refactor', async () => {
    const result = await commands.init(['Refactor validation'], { type: 'refactor' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **refactor**');
    expect(writtenContent).toContain('Behavior unchanged');
  });

  it.each(['infrastructure', 'commands', 'refactor', 'bugfix'] as const)(
    'includes paranoid-review for %s type',
    async (type) => {
      const result = await commands.init([`Test ${type}`], { type });
      expect(result.exitCode).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenContent).toContain('paranoid-review');
    }
  );

  it('excludes paranoid-review for content type', async () => {
    const result = await commands.init(['Write wiki page'], { type: 'content' });
    expect(result.exitCode).toBe(0);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).not.toContain('paranoid-review');
  });

  it('rejects invalid --type', async () => {
    const result = await commands.init(['Task'], { type: 'invalid' });
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

    const result = await commands.init([], { issue: '42' });
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

    const result = await commands.init([], { issue: '42', type: 'infrastructure' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Type: **infrastructure**');
  });

  it('rejects invalid issue number', async () => {
    const result = await commands.init([], { issue: 'abc' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid issue number');
  });

  it('handles GitHub API failure gracefully', async () => {
    mockGithubApi.mockRejectedValueOnce(new Error('Not found'));
    const result = await commands.init([], { issue: '999' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Failed to fetch');
  });

  it('uses issue title as task when no task arg provided', async () => {
    mockGithubApi.mockResolvedValueOnce({
      number: 10,
      title: 'Add dark mode',
      labels: [{ name: 'enhancement' }],
      html_url: 'https://github.com/test/repo/issues/10',
    });

    const result = await commands.init([], { issue: '10' });
    expect(result.exitCode).toBe(0);

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Add dark mode');
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
    expect(result.output).toContain('Session Checklist Progress');
    expect(result.output).toContain('0%');
  });

  it('shows progress for a partially completed checklist', async () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Done.
- [x] **Explore relevant code**: Done.
- [ ] **Plan approach**: Not yet.

## Phase 2: Implement

- [ ] **Tests written**: Not yet.
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.status([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('2/4');
    expect(result.output).toContain('50%');
  });

  it('returns JSON when --ci flag set', async () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Done.
- [ ] **Explore relevant code**: Not yet.
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

  it('returns error when no checklist file exists', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('No checklist found');
  });

  it('exits 1 when unchecked items remain', async () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Done.
- [ ] **Explore relevant code**: Not yet.
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('1 unchecked item');
    expect(result.output).toContain('Explore relevant code');
  });

  it('exits 0 when all items checked', async () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Done.
- [x] **Explore relevant code**: Done.

## Phase 4: Ship

- [x] **Gate passes**: Done.
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('All 3 checklist items complete');
  });

  it('treats N/A items as passing', async () => {
    const md = `## Phase 3: Review

- [x] **Correctness verified**: Done.
- [~] **No shell injection**: N/A.
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('All 2 checklist items complete');
  });

  it('shows key decisions in completion output', async () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Done.

## Key Decisions

- **Used TypeScript**: Better type safety.
- **Chose catalog pattern**: More testable.
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Key Decisions (2)');
    expect(result.output).toContain('Used TypeScript');
    expect(result.output).toContain('Chose catalog pattern');
  });

  it('lists all unchecked items with their phases', async () => {
    const md = `## Phase 2: Implement

- [ ] **Tests written**: Not yet.
- [x] **No hardcoded constants**: Done.

## Phase 3: Review

- [ ] **Correctness verified**: Not yet.
`;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(md);

    const result = await commands.complete([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('2 unchecked items');
    expect(result.output).toContain('Tests written');
    expect(result.output).toContain('Correctness verified');
    expect(result.output).toContain('implement');
    expect(result.output).toContain('review');
  });
});
