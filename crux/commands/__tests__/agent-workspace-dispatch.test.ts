import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSlot, resolvePrompt, parseMaxBudget } from '../agent-workspace.ts';

/**
 * Handler-level unit tests for `./ws dispatch` arg-parsing. These are the
 * invariants the hostile PR review flagged: --permission-mode must validate,
 * prompts containing `--` must not silently vanish, --max-budget must reject
 * garbage, etc. Pure functions only — no fs/spawn side effects.
 */

describe('parseSlot', () => {
  it('accepts positive integers', () => {
    expect(parseSlot('1')).toBe(1);
    expect(parseSlot('20')).toBe(20);
  });
  it('rejects missing / non-numeric', () => {
    expect(parseSlot(undefined)).toEqual({ error: expect.stringContaining('positive integer') });
    expect(parseSlot('')).toEqual({ error: expect.stringContaining('positive integer') });
    expect(parseSlot('abc')).toEqual({ error: expect.stringContaining('positive integer') });
    expect(parseSlot('1.5')).toEqual({ error: expect.stringContaining('positive integer') });
  });
  it('rejects zero and negatives', () => {
    expect(parseSlot('0')).toEqual({ error: expect.stringContaining('positive integer') });
    // "-1" fails the regex test so the error fires at the first check.
    expect(parseSlot('-1')).toEqual({ error: expect.stringContaining('positive integer') });
  });
});

describe('parseMaxBudget', () => {
  it('passes through undefined', () => {
    expect(parseMaxBudget(undefined)).toEqual({ value: undefined });
  });
  it('accepts positive numbers', () => {
    expect(parseMaxBudget('5')).toEqual({ value: 5 });
    expect(parseMaxBudget('0.5')).toEqual({ value: 0.5 });
    expect(parseMaxBudget('100')).toEqual({ value: 100 });
  });
  it('rejects non-numeric', () => {
    expect(parseMaxBudget('abc')).toEqual({ error: expect.stringContaining('positive number') });
    expect(parseMaxBudget('')).toEqual({ error: expect.stringContaining('positive number') });
  });
  it('rejects zero and negatives', () => {
    expect(parseMaxBudget('0')).toEqual({ error: expect.stringContaining('positive number') });
    expect(parseMaxBudget('-1')).toEqual({ error: expect.stringContaining('positive number') });
  });
});

describe('resolvePrompt', () => {
  it('uses --prompt-file when provided, trimming trailing whitespace', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dispatch-prompt-'));
    const file = join(tmp, 'p.txt');
    writeFileSync(file, 'Write a haiku about state machines.\n\n');
    expect(resolvePrompt([], { promptFile: file })).toEqual({
      prompt: 'Write a haiku about state machines.',
    });
  });

  it('--prompt-file takes priority over --prompt and positional args', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dispatch-prompt-'));
    const file = join(tmp, 'p.txt');
    writeFileSync(file, 'from file');
    expect(
      resolvePrompt(['positional', 'prompt'], { promptFile: file, prompt: 'inline' }),
    ).toEqual({ prompt: 'from file' });
  });

  it('errors clearly on missing --prompt-file', () => {
    const result = resolvePrompt([], { promptFile: '/does/not/exist/at/all.txt' });
    expect(result).toEqual({ error: expect.stringContaining('--prompt-file') });
  });

  it('errors clearly on empty --prompt-file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dispatch-prompt-'));
    const file = join(tmp, 'empty.txt');
    writeFileSync(file, '   \n\t\n');
    expect(resolvePrompt([], { promptFile: file })).toEqual({
      error: expect.stringContaining('empty'),
    });
  });

  it('uses --prompt when no --prompt-file is given', () => {
    expect(resolvePrompt([], { prompt: 'from flag' })).toEqual({ prompt: 'from flag' });
  });

  it('--prompt takes priority over positional args', () => {
    expect(resolvePrompt(['ignored', 'args'], { prompt: 'from flag' })).toEqual({
      prompt: 'from flag',
    });
  });

  it('--prompt= supports a prompt that starts with two dashes (the hostile-review edge case)', () => {
    // This is the specific hazard the review flagged: positional filter drops --foo tokens.
    // Using --prompt= bypasses the filter cleanly.
    expect(resolvePrompt([], { prompt: '--force the compiler to crash and summarize' })).toEqual({
      prompt: '--force the compiler to crash and summarize',
    });
  });

  it('falls back to positional args joined by single spaces', () => {
    expect(resolvePrompt(['write', 'a', 'haiku'], {})).toEqual({ prompt: 'write a haiku' });
  });

  it('returns a helpful error when no prompt source is present', () => {
    const r = resolvePrompt([], {});
    expect(r).toEqual({ error: expect.stringContaining('--prompt-file') });
  });

  it('ignores blank --prompt, falling through to positional', () => {
    expect(resolvePrompt(['fallback'], { prompt: '   ' })).toEqual({ prompt: 'fallback' });
  });
});
