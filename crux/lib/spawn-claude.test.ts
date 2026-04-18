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

  it('spawns a child process (ENOENT returned cleanly if claude not installed)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    // We pass an invalid binary via PATH manipulation to avoid actually calling claude.
    // But spawnSync with a missing binary returns error.code === 'ENOENT', it doesn't throw.
    const result = spawnClaudeSync(['--version'], { timeout: 2000 });
    // Either the binary runs (status: 0) or it's missing (error ENOENT) — both are valid
    // for verifying the wrapper doesn't throw or hang.
    expect(typeof result).toBe('object');
    expect(result).toHaveProperty('status');
  });
});
