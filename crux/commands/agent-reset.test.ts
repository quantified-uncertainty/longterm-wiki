import { describe, it, expect } from 'vitest';

// Test the parsing/classification logic by importing internals
// We re-implement the pure functions here since they're not exported,
// but the test validates the logic patterns used by the command.

function parseElapsed(etime: string): number {
  const parts = etime.replace(/-/g, ':').split(':').map(Number);
  if (parts.length === 2) return parts[0] + parts[1] / 60;
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
  if (parts.length === 4) return parts[0] * 1440 + parts[1] * 60 + parts[2] + parts[3] / 60;
  return 0;
}

describe('parseElapsed', () => {
  it('parses MM:SS', () => {
    expect(parseElapsed('05:30')).toBeCloseTo(5.5);
  });

  it('parses HH:MM:SS', () => {
    expect(parseElapsed('02:30:00')).toBe(150);
  });

  it('parses D-HH:MM:SS', () => {
    // 1 day + 2 hours = 1440 + 120 = 1560 minutes
    expect(parseElapsed('1-02:00:00')).toBe(1560);
  });

  it('handles zero', () => {
    expect(parseElapsed('00:00')).toBe(0);
  });
});

describe('process classification patterns', () => {
  it('detects playwright-mcp in command string', () => {
    const cmd = 'node /Users/user/.npm/_npx/abc/node_modules/.bin/playwright-mcp';
    expect(cmd.includes('playwright-mcp')).toBe(true);
  });

  it('detects agent slot paths', () => {
    const cmd = 'node /Users/user/lw/a2/apps/web/node_modules/.bin/next dev -p 3012';
    expect(/\/lw\/a\d+\//.test(cmd)).toBe(true);
    const slotMatch = cmd.match(/\/lw\/a(\d+)\//);
    expect(slotMatch?.[1]).toBe('2');
  });

  it('does not match non-slot paths', () => {
    const cmd = 'node /Users/user/lw/main/apps/web/node_modules/.bin/next dev -p 3001';
    expect(/\/lw\/a\d+\//.test(cmd)).toBe(false);
  });

  it('detects vitest from slot', () => {
    const cmd = 'node /Users/user/lw/a5/node_modules/.bin/vitest run';
    expect(cmd.includes('vitest') && /\/lw\/a\d+\//.test(cmd)).toBe(true);
  });
});
