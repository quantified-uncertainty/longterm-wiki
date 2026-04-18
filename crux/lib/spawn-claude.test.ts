import { describe, it, expect, afterEach } from 'vitest';
import { buildClaudeChildEnv, spawnClaudeSync } from './spawn-claude.ts';

describe('buildClaudeChildEnv', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('strips ANTHROPIC_API_KEY from process.env by default', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const env = buildClaudeChildEnv(undefined, undefined, undefined);
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('strips ANTHROPIC_API_KEY from caller-supplied base env', () => {
    const env = buildClaudeChildEnv(
      { ANTHROPIC_API_KEY: 'leaked', OTHER: 'keep' },
      undefined,
      undefined,
    );
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.OTHER).toBe('keep');
  });

  it('strips ANTHROPIC_API_KEY even when set via extraEnv', () => {
    const env = buildClaudeChildEnv(
      { OTHER: 'keep' },
      { ANTHROPIC_API_KEY: 'also-leaked' },
      undefined,
    );
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.OTHER).toBe('keep');
  });

  it('preserves non-key env vars', () => {
    const env = buildClaudeChildEnv(
      { CLAUDECODE: '1', PATH: '/usr/bin' },
      undefined,
      undefined,
    );
    expect(env.CLAUDECODE).toBe('1');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('extraEnv overrides base env entries', () => {
    const env = buildClaudeChildEnv(
      { CLAUDECODE: '1' },
      { CLAUDECODE: '0' },
      undefined,
    );
    expect(env.CLAUDECODE).toBe('0');
  });

  it('keepApiKey retains ANTHROPIC_API_KEY from base env', () => {
    const env = buildClaudeChildEnv(
      { ANTHROPIC_API_KEY: 'sk-retain' },
      undefined,
      { reason: 'prod service account' },
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-retain');
  });

  it('keepApiKey retains ANTHROPIC_API_KEY from extraEnv', () => {
    const env = buildClaudeChildEnv(
      {},
      { ANTHROPIC_API_KEY: 'sk-retain' },
      { reason: 'test' },
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-retain');
  });
});

describe('spawnClaudeSync (integration)', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('returns a SpawnSyncReturns shape without throwing when claude is absent', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    // Override PATH so `claude` is definitively not found — isolates the test
    // from whether the CLI happens to be installed on the runner.
    const result = spawnClaudeSync(['--version'], {
      env: { PATH: '/nonexistent' },
      timeout: 2000,
    });
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('error');
    expect((result.error as NodeJS.ErrnoException)?.code).toBe('ENOENT');
  });
});
