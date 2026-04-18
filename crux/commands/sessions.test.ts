/**
 * Tests for the `crux sys sessions list` command handler. The merge/format
 * logic is unit-tested separately in `crux/lib/session/sessions-list.test.ts`
 * and `crux/lib/session/claude-processes.test.ts`; this file covers the
 * command-layer glue: option validation, the server-unavailable degradation
 * path, scan-failure warnings, and JSON output shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock wiki-server deps up-front (vi.mock is hoisted above imports).
const { listAgentSessionsMock, isServerAvailableMock, findClaudeProcessesMock } = vi.hoisted(() => ({
  listAgentSessionsMock: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  isServerAvailableMock: vi.fn<() => Promise<boolean>>(async () => true),
  findClaudeProcessesMock: vi.fn<() => {
    processes: Array<{ pid: number; cwd: string; slot: number | null }>;
    scanError: string | null;
  }>(() => ({ processes: [], scanError: null })),
}));

vi.mock('../lib/wiki-server/agent-sessions.ts', () => ({
  listAgentSessions: listAgentSessionsMock,
}));
vi.mock('../lib/wiki-server/client.ts', () => ({
  isServerAvailable: isServerAvailableMock,
}));
vi.mock('../lib/session/claude-processes.ts', () => ({
  findClaudeProcesses: findClaudeProcessesMock,
}));

// Stub fs so the unrelated `write` command's module-level imports don't blow up.
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

// Stub the wiki-server sync import used by `write`, unrelated to `list`.
vi.mock('../wiki-server/sync-session.ts', () => ({
  syncSessionFile: vi.fn(async () => true),
}));

vi.mock('../lib/session/session-checklist.ts', () => ({
  currentBranch: vi.fn(() => 'main'),
}));

// Strip ANSI escapes so assertions don't have to encode color codes.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

import { commands } from './sessions.ts';

const list = commands.list;

beforeEach(() => {
  vi.clearAllMocks();
  isServerAvailableMock.mockResolvedValue(true);
  listAgentSessionsMock.mockResolvedValue({ ok: true, data: { sessions: [] } });
  findClaudeProcessesMock.mockReturnValue({ processes: [], scanError: null });
});

describe('list command — option validation', () => {
  it('rejects non-numeric --slot with exit code 2', async () => {
    const r = await list([], { slot: 'abc' });
    expect(r.exitCode).toBe(2);
    expect(stripAnsi(r.output)).toContain('--slot must be a non-negative integer');
  });

  it('rejects negative --slot with exit code 2', async () => {
    const r = await list([], { slot: '-1' });
    expect(r.exitCode).toBe(2);
  });

  it('accepts numeric --slot', async () => {
    const r = await list([], { slot: '9' });
    expect(r.exitCode).toBe(0);
  });
});

describe('list command — server unavailable degradation', () => {
  it('does not hard-fail when DB returns unavailable; shows warning + scan-only results', async () => {
    listAgentSessionsMock.mockResolvedValue({
      ok: false,
      error: 'unavailable',
      message: 'connection refused',
    });
    findClaudeProcessesMock.mockReturnValue({
      processes: [{ pid: 42, cwd: '/lw/a9', slot: 9 }],
      scanError: null,
    });
    const r = await list([], {});
    expect(r.exitCode).toBe(0);
    const out = stripAnsi(r.output);
    expect(out).toContain('wiki-server unreachable');
    expect(out).toContain('a9');
  });

  it('reports non-unavailable DB errors with the error kind', async () => {
    listAgentSessionsMock.mockResolvedValue({
      ok: false,
      error: 'server_error',
      message: '500 Internal Server Error',
    });
    const r = await list([], {});
    expect(r.exitCode).toBe(0);
    expect(stripAnsi(r.output)).toContain('DB fetch failed (server_error)');
  });
});

describe('list command — scan failure warning', () => {
  it('emits a warning banner when the process scan fails', async () => {
    findClaudeProcessesMock.mockReturnValue({
      processes: [],
      scanError: 'lsof failed: permission denied',
    });
    const r = await list([], {});
    expect(r.exitCode).toBe(0);
    const out = stripAnsi(r.output);
    expect(out).toContain('process scan failed');
    expect(out).toContain('permission denied');
    expect(out).toContain('Ghost detection disabled');
  });
});

describe('list command — JSON output', () => {
  it('always wraps output in {warnings, sessions} — consistent shape', async () => {
    const r = await list([], { json: true });
    const parsed = JSON.parse(r.output);
    expect(parsed).toHaveProperty('warnings');
    expect(parsed).toHaveProperty('sessions');
    expect(Array.isArray(parsed.warnings)).toBe(true);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.warnings).toEqual([]); // empty when no issues
  });

  it('populates warnings when scan or DB fails', async () => {
    findClaudeProcessesMock.mockReturnValue({
      processes: [],
      scanError: 'x',
    });
    const r = await list([], { json: true });
    const parsed = JSON.parse(r.output);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});

describe('list command — limit validation', () => {
  it('clamps --limit to 500 max', async () => {
    await list([], { limit: '1000' });
    expect(listAgentSessionsMock).toHaveBeenCalledWith(500);
  });

  it('rejects non-integer --limit with exit 2 (matches --slot behavior)', async () => {
    const r = await list([], { limit: 'abc' });
    expect(r.exitCode).toBe(2);
    expect(stripAnsi(r.output)).toContain('--limit must be a non-negative integer');
  });

  it('rejects negative --limit with exit 2', async () => {
    const r = await list([], { limit: '-5' });
    expect(r.exitCode).toBe(2);
  });
});
