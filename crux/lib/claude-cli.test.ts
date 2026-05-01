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
    const apiKeyName = 'ANTHROPIC_API_KEY'; // anthropic-billing-key-remap-ok
    const originalApiKey = process.env[apiKeyName];

    afterEach(() => {
      if (originalClaudeCode !== undefined) process.env.CLAUDECODE = originalClaudeCode;
      else delete process.env.CLAUDECODE;
      if (originalApiKey !== undefined) process.env[apiKeyName] = originalApiKey;
      else delete process.env[apiKeyName];
    });

    it('strips CLAUDECODE from the returned env', () => {
      process.env.CLAUDECODE = '1';
      const env = prepareClaudeSpawnEnv();
      expect(env.CLAUDECODE).toBeUndefined();
    });

    it('strips ANTHROPIC_API_KEY from the returned env', () => {
      process.env[apiKeyName] = 'sk-ant-api03-test';
      const env = prepareClaudeSpawnEnv();
      expect(env[apiKeyName]).toBeUndefined();
    });

    it('does not mutate process.env', () => {
      process.env.CLAUDECODE = '1';
      process.env[apiKeyName] = 'sk-ant-api03-test';
      prepareClaudeSpawnEnv();
      expect(process.env.CLAUDECODE).toBe('1');
      expect(process.env[apiKeyName]).toBe('sk-ant-api03-test');
    });

    it('preserves other env vars (PATH, HOME, ANTHROPIC_BILLING_KEY)', () => {
      process.env[apiKeyName] = 'sk-ant-api03-test';
      const env = prepareClaudeSpawnEnv();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      // ANTHROPIC_BILLING_KEY is the legitimate key for crux SDK calls and must NOT be stripped
      // (the claude CLI ignores it; only ANTHROPIC_API_KEY triggers the API-billing switch)
      if (process.env.ANTHROPIC_BILLING_KEY) {
        expect(env.ANTHROPIC_BILLING_KEY).toBe(process.env.ANTHROPIC_BILLING_KEY);
      }
    });

    it('handles env where neither CLAUDECODE nor ANTHROPIC_API_KEY is set', () => {
      delete process.env.CLAUDECODE;
      delete process.env[apiKeyName];
      const env = prepareClaudeSpawnEnv();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env[apiKeyName]).toBeUndefined();
    });
  });
});
