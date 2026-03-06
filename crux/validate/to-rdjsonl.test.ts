import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(import.meta.dirname, 'to-rdjsonl.ts');

function runConverter(input: string): string {
  return execSync(`echo '${input.replace(/'/g, "'\\''")}' | npx tsx "${SCRIPT}"`, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 30000,
  }).trim();
}

describe('to-rdjsonl', () => {
  it('converts crux issues to rdjsonl format', () => {
    const input = JSON.stringify({
      issues: [
        {
          rule: 'dollar-signs',
          file: join(PROJECT_ROOT, 'content/docs/test-page.mdx'),
          line: 42,
          message: 'Unescaped $ character',
          severity: 'error',
        },
      ],
      summary: { total: 1, byRule: { 'dollar-signs': 1 }, bySeverity: { error: 1, warning: 0, info: 0 }, hasErrors: true },
    });

    const output = runConverter(input);
    const parsed = JSON.parse(output);

    expect(parsed.message).toBe('Unescaped $ character');
    expect(parsed.location.path).toBe('content/docs/test-page.mdx');
    expect(parsed.location.range.start.line).toBe(42);
    expect(parsed.severity).toBe('ERROR');
    expect(parsed.code.value).toBe('dollar-signs');
    expect(parsed.source.name).toBe('crux-validate');
  });

  it('maps severity levels correctly', () => {
    const input = JSON.stringify({
      issues: [
        { rule: 'r1', file: '/tmp/a.mdx', line: 1, message: 'err', severity: 'error' },
        { rule: 'r2', file: '/tmp/b.mdx', line: 2, message: 'warn', severity: 'warning' },
        { rule: 'r3', file: '/tmp/c.mdx', line: 3, message: 'inf', severity: 'info' },
      ],
      summary: { total: 3, byRule: {}, bySeverity: { error: 1, warning: 1, info: 1 }, hasErrors: true },
    });

    const output = runConverter(input);
    const lines = output.split('\n').map((l: string) => JSON.parse(l));

    expect(lines[0].severity).toBe('ERROR');
    expect(lines[1].severity).toBe('WARNING');
    expect(lines[2].severity).toBe('INFO');
  });

  it('handles issues without line numbers', () => {
    const input = JSON.stringify({
      issues: [
        { rule: 'schema', file: '/tmp/test.yaml', message: 'Invalid schema', severity: 'error' },
      ],
      summary: { total: 1, byRule: {}, bySeverity: { error: 1, warning: 0, info: 0 }, hasErrors: true },
    });

    const output = runConverter(input);
    const parsed = JSON.parse(output);

    expect(parsed.location.range).toBeUndefined();
    expect(parsed.message).toBe('Invalid schema');
  });

  it('produces one JSON object per line (rdjsonl)', () => {
    const input = JSON.stringify({
      issues: [
        { rule: 'r1', file: '/tmp/a.mdx', line: 1, message: 'first', severity: 'error' },
        { rule: 'r2', file: '/tmp/b.mdx', line: 2, message: 'second', severity: 'warning' },
      ],
      summary: { total: 2, byRule: {}, bySeverity: { error: 1, warning: 1, info: 0 }, hasErrors: true },
    });

    const output = runConverter(input);
    const lines = output.split('\n');

    expect(lines).toHaveLength(2);
    // Each line must be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('produces no output for empty issues array', () => {
    const input = JSON.stringify({
      issues: [],
      summary: { total: 0, byRule: {}, bySeverity: { error: 0, warning: 0, info: 0 }, hasErrors: false },
    });

    const output = runConverter(input);
    expect(output).toBe('');
  });
});
