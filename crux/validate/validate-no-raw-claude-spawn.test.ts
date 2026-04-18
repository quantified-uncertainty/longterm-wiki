import { describe, it, expect } from 'vitest';
import { runCheck, checkFileContent } from './validate-no-raw-claude-spawn.ts';

describe('validate-no-raw-claude-spawn pattern detection', () => {
  it('flags raw spawn("claude", ...)', () => {
    const v = checkFileContent(
      `const child = spawn('claude', args, { env });`,
      'crux/example.ts',
    );
    expect(v.length).toBe(1);
    expect(v[0].kind).toBe('spawn');
  });

  it('flags spawnSync("claude", ...)', () => {
    const v = checkFileContent(
      `const r = spawnSync('claude', ['--version']);`,
      'crux/example.ts',
    );
    expect(v.length).toBe(1);
    expect(v[0].kind).toBe('spawnSync');
  });

  it('flags execSync("claude --version", ...)', () => {
    const v = checkFileContent(
      `execSync('claude --version', { stdio: 'pipe' });`,
      'crux/example.ts',
    );
    expect(v.length).toBe(1);
    expect(v[0].kind).toBe('execSync');
  });

  it('flags execa("claude", ...)', () => {
    const v = checkFileContent(
      `await execa('claude', ['-p', prompt]);`,
      'crux/example.ts',
    );
    expect(v.length).toBe(1);
    expect(v[0].kind).toBe('execa');
  });

  it('flags double-quoted "claude"', () => {
    const v = checkFileContent(
      `spawn("claude", args, {});`,
      'crux/example.ts',
    );
    expect(v.length).toBe(1);
  });

  it('does not flag claude-foo or claudex', () => {
    const v = checkFileContent(
      `spawn('claude-foo', [])\nspawn('claudex', [])`,
      'crux/example.ts',
    );
    expect(v.length).toBe(0);
  });

  it('does not flag variable-named spawns', () => {
    const v = checkFileContent(
      `env.spawnDetached(cmd, args, opts);`,
      'crux/example.ts',
    );
    expect(v.length).toBe(0);
  });

  it('does not flag commented-out spawns', () => {
    const v = checkFileContent(
      `// spawn('claude', args)\n/* spawn('claude', []) */`,
      'crux/example.ts',
    );
    expect(v.length).toBe(0);
  });

  it('allows the wrapper file itself', () => {
    const v = checkFileContent(
      `return spawn('claude', args, { ...rest, env: childEnv });`,
      'crux/lib/spawn-claude.ts',
    );
    expect(v.length).toBe(0);
  });

  it('reports line numbers correctly', () => {
    const v = checkFileContent(
      `// header\n\nconst c = spawn('claude', []);`,
      'crux/example.ts',
    );
    expect(v.length).toBe(1);
    expect(v[0].line).toBe(3);
  });

  it('flags multi-line prettier-formatted spawn calls', () => {
    const v = checkFileContent(
      `const child = spawn(\n  'claude',\n  ['-p'],\n  { cwd },\n);`,
      'crux/example.ts',
    );
    expect(v.length).toBe(1);
    expect(v[0].kind).toBe('spawn');
    expect(v[0].line).toBe(1);
  });

  it('strips block comments before scanning', () => {
    const v = checkFileContent(
      `/* example: spawn('claude', []); */\n`,
      'crux/example.ts',
    );
    expect(v.length).toBe(0);
  });
});

describe('validate-no-raw-claude-spawn against current codebase', () => {
  it('passes (all migrations landed)', () => {
    const result = runCheck();
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });
});
