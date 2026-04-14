import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseTranscript, findLatestTranscript } from '../transcript-parser.ts';

// Suppress pricing warnings for unknown models
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makeJsonl(entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

function writeTmpFile(content: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
  const filePath = path.join(tmpDir, 'test-session-id.jsonl');
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('parseTranscript', () => {
  it('extracts session ID from filename', () => {
    const filePath = writeTmpFile(makeJsonl([
      { type: 'user', message: { content: 'Hello world test message' }, timestamp: '2026-04-11T10:00:00Z' },
    ]));
    const result = parseTranscript(filePath);
    expect(result.sessionId).toBe('test-session-id');
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('extracts first real user message as title', () => {
    const filePath = writeTmpFile(makeJsonl([
      { type: 'user', message: { content: '<local-command-caveat>ignore</local-command-caveat>' }, timestamp: '2026-04-11T10:00:00Z' },
      { type: 'user', message: { content: 'Fix the broken validation gate' }, timestamp: '2026-04-11T10:00:01Z' },
    ]));
    const result = parseTranscript(filePath);
    expect(result.title).toBe('Fix the broken validation gate');
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('skips command-message and slash-command messages for title', () => {
    const filePath = writeTmpFile(makeJsonl([
      { type: 'user', message: { content: '<command-message>maintain-pr-patrol</command-message>' }, timestamp: '2026-04-11T10:00:00Z' },
      { type: 'user', message: { content: '/maintain-pr-patrol' }, timestamp: '2026-04-11T10:00:01Z' },
      { type: 'user', message: { content: 'Fix the actual user task here' }, timestamp: '2026-04-11T10:00:02Z' },
    ]));
    const result = parseTranscript(filePath);
    expect(result.title).toBe('Fix the actual user task here');
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('handles content as array of blocks', () => {
    const filePath = writeTmpFile(makeJsonl([
      {
        type: 'user',
        message: { content: [{ type: 'text', text: 'Improve the page about anthropic' }] },
        timestamp: '2026-04-11T10:00:00Z',
      },
    ]));
    const result = parseTranscript(filePath);
    expect(result.title).toBe('Improve the page about anthropic');
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('extracts last assistant text as summary', () => {
    const filePath = writeTmpFile(makeJsonl([
      { type: 'user', message: { content: 'What is this?' }, timestamp: '2026-04-11T10:00:00Z' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'First assistant message' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        timestamp: '2026-04-11T10:00:01Z',
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Final summary of work done' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 200, output_tokens: 100 },
        },
        timestamp: '2026-04-11T10:01:00Z',
      },
    ]));
    const result = parseTranscript(filePath);
    expect(result.summary).toBe('Final summary of work done');
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('extracts primary model from assistant messages', () => {
    const filePath = writeTmpFile(makeJsonl([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'first' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        timestamp: '2026-04-11T10:00:00Z',
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'second' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        timestamp: '2026-04-11T10:00:01Z',
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'haiku' }],
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        timestamp: '2026-04-11T10:00:02Z',
      },
    ]));
    const result = parseTranscript(filePath);
    // Sonnet appears twice, haiku once -> primary model is sonnet
    expect(result.model).toBe('claude-sonnet-4-6');
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('ignores synthetic model for primary model extraction', () => {
    const filePath = writeTmpFile(makeJsonl([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'real' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        timestamp: '2026-04-11T10:00:00Z',
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'synthetic 1' }],
          model: '<synthetic>',
        },
        timestamp: '2026-04-11T10:00:01Z',
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'synthetic 2' }],
          model: '<synthetic>',
        },
        timestamp: '2026-04-11T10:00:02Z',
      },
    ]));
    const result = parseTranscript(filePath);
    expect(result.model).toBe('claude-sonnet-4-6');
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('computes duration from timestamps', () => {
    const filePath = writeTmpFile(makeJsonl([
      { type: 'user', message: { content: 'start the task' }, timestamp: '2026-04-11T10:00:00Z' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'done' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        timestamp: '2026-04-11T10:30:00Z',
      },
    ]));
    const result = parseTranscript(filePath);
    expect(result.durationMinutes).toBe(30);
    expect(result.startedAt).toBe('2026-04-11T10:00:00Z');
    expect(result.endedAt).toBe('2026-04-11T10:30:00Z');
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('extracts branch from system messages', () => {
    const filePath = writeTmpFile(makeJsonl([
      { type: 'system', subtype: 'local_command', gitBranch: 'claude/fix-42-broken-gate', timestamp: '2026-04-11T10:00:00Z' },
    ]));
    const result = parseTranscript(filePath);
    expect(result.branch).toBe('claude/fix-42-broken-gate');
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('scrubs secrets from title and summary', () => {
    // Construct secrets dynamically to avoid GitHub secret scanning
    const antKey = 'sk-ant-' + 'x'.repeat(20);
    const filePath = writeTmpFile(makeJsonl([
      { type: 'user', message: { content: 'Set API_KEY="my-super-secret-value-1234"' }, timestamp: '2026-04-11T10:00:00Z' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Found key ' + antKey + ' in config' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        timestamp: '2026-04-11T10:01:00Z',
      },
    ]));
    const result = parseTranscript(filePath);
    expect(result.title).toContain('[REDACTED:');
    expect(result.title).not.toContain('my-super-secret');
    expect(result.summary).toContain('[REDACTED:');
    expect(result.summary).not.toContain('sk-ant-');
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('handles empty transcript', () => {
    const filePath = writeTmpFile('');
    const result = parseTranscript(filePath);
    expect(result.title).toBeNull();
    expect(result.summary).toBeNull();
    expect(result.model).toBeNull();
    expect(result.durationMinutes).toBeNull();
    expect(result.lineCount).toBe(0);
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('handles transcript with only system messages', () => {
    const filePath = writeTmpFile(makeJsonl([
      { type: 'system', subtype: 'local_command', timestamp: '2026-04-11T10:00:00Z' },
      { type: 'progress', data: {}, timestamp: '2026-04-11T10:00:01Z' },
    ]));
    const result = parseTranscript(filePath);
    expect(result.title).toBeNull();
    expect(result.summary).toBeNull();
    expect(result.lineCount).toBe(2);
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('truncates long titles to 200 chars', () => {
    const longMessage = 'A'.repeat(500);
    const filePath = writeTmpFile(makeJsonl([
      { type: 'user', message: { content: longMessage }, timestamp: '2026-04-11T10:00:00Z' },
    ]));
    const result = parseTranscript(filePath);
    expect(result.title!.length).toBeLessThanOrEqual(200);
    fs.rmSync(path.dirname(filePath), { recursive: true });
  });
});

describe('findLatestTranscript', () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  // Writes a fake transcript where Claude Code would — the slug is how Claude
  // Code derives the project directory name, not how we want it to look.
  function seedTranscript(claudeSlug: string, fileName: string): string {
    const slugDir = path.join(fakeHome, '.claude', 'projects', claudeSlug);
    fs.mkdirSync(slugDir, { recursive: true });
    const filePath = path.join(slugDir, fileName);
    fs.writeFileSync(filePath, '{}\n');
    return filePath;
  }

  it('returns null for non-existent project dir', () => {
    const result = findLatestTranscript('/nonexistent/path/that/does/not/exist');
    expect(result).toBeNull();
  });

  // Regression: the old slug regex only replaced `/`, so workspaces under
  // `GitHub.nosync` (and any path with a dotted ancestor, including `.claude`)
  // silently bailed with "No JSONL transcript found", leaving the SessionEnd
  // hook a no-op. See QUA-471.
  it('finds transcript when project path contains dots (GitHub.nosync case)', () => {
    const projectDir = '/tmp/Documents/GitHub.nosync/lw/a10';
    const expected = seedTranscript(
      '-tmp-Documents-GitHub-nosync-lw-a10',
      'abc-123.jsonl',
    );
    expect(findLatestTranscript(projectDir)).toBe(expected);
  });

  it('finds transcript for the .claude worktree path shape', () => {
    const projectDir = '/tmp/lw/main/.claude/worktrees/admiring-bohr';
    const expected = seedTranscript(
      '-tmp-lw-main--claude-worktrees-admiring-bohr',
      'xyz.jsonl',
    );
    expect(findLatestTranscript(projectDir)).toBe(expected);
  });

  it('finds transcript for a plain / path (no regression)', () => {
    const projectDir = '/tmp/plain/project/root';
    const expected = seedTranscript(
      '-tmp-plain-project-root',
      'session.jsonl',
    );
    expect(findLatestTranscript(projectDir)).toBe(expected);
  });

  it('returns the newest transcript when multiple exist', () => {
    const projectDir = '/tmp/GitHub.nosync/project';
    const older = seedTranscript('-tmp-GitHub-nosync-project', 'old.jsonl');
    // Ensure mtime difference even on fast filesystems
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(older, oldTime, oldTime);
    const newer = seedTranscript('-tmp-GitHub-nosync-project', 'new.jsonl');
    expect(findLatestTranscript(projectDir)).toBe(newer);
  });
});
