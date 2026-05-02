import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldUseApiDirect, isClaudeCliAvailable, isInsideClaudeCodeSession, resetCliDetectionCache, prepareClaudeSpawnEnv } from './claude-cli.ts';

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

  describe('prepareClaudeSpawnEnv', () => {
    const originalClaudeCode = process.env.CLAUDECODE;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalBillingKey = process.env.ANTHROPIC_BILLING_KEY;

    afterEach(() => {
      if (originalClaudeCode !== undefined) process.env.CLAUDECODE = originalClaudeCode;
      else delete process.env.CLAUDECODE;
      if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
      else delete process.env.ANTHROPIC_API_KEY;
      if (originalBillingKey !== undefined) process.env.ANTHROPIC_BILLING_KEY = originalBillingKey;
      else delete process.env.ANTHROPIC_BILLING_KEY;
    });

    it('strips CLAUDECODE from the returned env', () => {
      process.env.CLAUDECODE = '1';
      const env = prepareClaudeSpawnEnv();
      expect(env.CLAUDECODE).toBeUndefined();
    });

    it('strips ANTHROPIC_API_KEY from the returned env', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test';
      const env = prepareClaudeSpawnEnv();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('does not mutate process.env', () => {
      process.env.CLAUDECODE = '1';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test';
      prepareClaudeSpawnEnv();
      expect(process.env.CLAUDECODE).toBe('1');
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-test');
    });

    it('preserves ANTHROPIC_BILLING_KEY (the legitimate SDK key the CLI ignores)', () => {
      // Set explicitly so the test passes/fails the same way regardless of whether
      // the surrounding env had BILLING_KEY set — the previous version silently
      // skipped this assertion in environments without it.
      process.env.ANTHROPIC_BILLING_KEY = 'sk-ant-billing-test';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test';
      const env = prepareClaudeSpawnEnv();
      expect(env.ANTHROPIC_BILLING_KEY).toBe('sk-ant-billing-test');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('preserves PATH and HOME', () => {
      const env = prepareClaudeSpawnEnv();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
    });

    it('handles env where neither CLAUDECODE nor ANTHROPIC_API_KEY is set', () => {
      delete process.env.CLAUDECODE;
      delete process.env.ANTHROPIC_API_KEY;
      const env = prepareClaudeSpawnEnv();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('accepts a custom base env and strips from it (e.g. env with TMPDIR override)', () => {
      const base: NodeJS.ProcessEnv = {
        ...process.env,
        TMPDIR: '/tmp/tsx-slot-a3',
        ANTHROPIC_API_KEY: 'sk-ant-api03-test',
        CLAUDECODE: '1',
      };
      const env = prepareClaudeSpawnEnv(base);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.TMPDIR).toBe('/tmp/tsx-slot-a3');
      // Does not mutate the passed-in base
      expect(base.ANTHROPIC_API_KEY).toBe('sk-ant-api03-test');
      expect(base.CLAUDECODE).toBe('1');
    });
  });
});
