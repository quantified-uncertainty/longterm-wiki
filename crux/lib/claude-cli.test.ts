import { describe, it, expect, beforeEach } from 'vitest';
import { shouldUseApiDirect, isClaudeCliAvailable, resetCliDetectionCache } from './claude-cli.ts';

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
});
