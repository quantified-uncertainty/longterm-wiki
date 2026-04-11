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

  it('computes cost from usage data', () => {
    const filePath = writeTmpFile(makeJsonl([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'done' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
        },
        timestamp: '2026-04-11T10:00:00Z',
      },
    ]));
    const result = parseTranscript(filePath);
    // 1M input * $3/M + 100K output * $15/M = $4.50
    expect(result.cost.totalCostUsd).toBeCloseTo(4.50, 2);
    expect(result.cost.costString).toBe('$4.50');
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
    expect(result.cost.totalCostUsd).toBe(0);
    expect(result.durationMinutes).toBeNull();
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
  it('returns null for non-existent project dir', () => {
    const result = findLatestTranscript('/nonexistent/path/that/does/not/exist');
    expect(result).toBeNull();
  });
});
