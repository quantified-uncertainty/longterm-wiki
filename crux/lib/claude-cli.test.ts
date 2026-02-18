import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldUseApiDirect, isClaudeCliAvailable, isInsideClaudeCodeSession, resetCliDetectionCache } from './claude-cli.ts';

describe('Claude CLI Detection', () => {
  beforeEach(() => {
    resetCliDetectionCache();
  });

  it('shouldUseApiDirect: explicit true overrides detection', () => {
    expect(shouldUseApiDirect(true)).toBe(true);
  });

  it('shouldUseApiDirect: explicit false overrides detection', () => {
    expect(shouldUseApiDirect(false)).toBe(false);
  });

  it('shouldUseApiDirect: undefined triggers auto-detection', () => {
    const result = shouldUseApiDirect(undefined);
    // Result depends on whether claude CLI is installed in test env
    expect(typeof result).toBe('boolean');
  });

  it('isClaudeCliAvailable: returns a boolean', () => {
    const result = isClaudeCliAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('isClaudeCliAvailable: result is cached', () => {
    const first = isClaudeCliAvailable();
    const second = isClaudeCliAvailable();
    expect(first).toBe(second);
  });

  it('resetCliDetectionCache: clears cached result', () => {
    isClaudeCliAvailable(); // populates cache
    resetCliDetectionCache(); // clears it
    // After reset, should re-detect (still same result, but cache was cleared)
    const result = isClaudeCliAvailable();
    expect(typeof result).toBe('boolean');
  });

  describe('CLAUDECODE env var detection', () => {
    const originalClaudeCode = process.env.CLAUDECODE;

    afterEach(() => {
      if (originalClaudeCode !== undefined) {
        process.env.CLAUDECODE = originalClaudeCode;
      } else {
        delete process.env.CLAUDECODE;
      }
    });

    it('isInsideClaudeCodeSession: returns true when CLAUDECODE=1', () => {
      process.env.CLAUDECODE = '1';
      expect(isInsideClaudeCodeSession()).toBe(true);
    });

    it('isInsideClaudeCodeSession: returns false when CLAUDECODE unset', () => {
      delete process.env.CLAUDECODE;
      expect(isInsideClaudeCodeSession()).toBe(false);
    });

    it('shouldUseApiDirect: returns true inside Claude Code session', () => {
      process.env.CLAUDECODE = '1';
      expect(shouldUseApiDirect(undefined)).toBe(true);
    });

    it('shouldUseApiDirect: explicit false still overrides CLAUDECODE', () => {
      process.env.CLAUDECODE = '1';
      expect(shouldUseApiDirect(false)).toBe(false);
    });
  });
});
