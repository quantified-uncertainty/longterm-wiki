import { describe, it, expect, beforeEach } from 'vitest';
import {
  dispatchPaths,
  runPaths,
  generateRunId,
  shortHexFromUuid,
  buildClaudeArgv,
  readCurrent,
  writeCurrent,
  clearCurrent,
  readMeta,
  writeMeta,
  parseEventLine,
  parseEventsFile,
  findResultEvent,
  readFinalResultEvent,
  spawnDispatch,
  detectConflict,
  finalizeIfComplete,
  isPermissionMode,
  PERMISSION_MODES,
  type DispatchEnv,
  type RunMeta,
} from '../dispatch.ts';

// ---------------------------------------------------------------------------
// Fake env
// ---------------------------------------------------------------------------

interface SpawnCall {
  cmd: string;
  args: string[];
  cwd: string;
  stdoutFd: number;
  stderrFd: number;
  assignedPid: number;
}

class FakeEnv implements DispatchEnv {
  files: Map<string, string> = new Map();
  dirs: Set<string> = new Set();
  openFds: Set<number> = new Set();
  private nextFd = 100;
  alivePids: Set<number> = new Set();
  signaled: Array<{ pid: number; sig: string }> = [];
  spawnCalls: SpawnCall[] = [];
  nextPid = 50000;
  nextUuid = '11111111-2222-3333-4444-555555555555';
  private clock: Date = new Date('2026-04-16T15:00:00Z');

  setNow(iso: string) { this.clock = new Date(iso); }
  advance(ms: number) { this.clock = new Date(this.clock.getTime() + ms); }

  now() { return this.clock; }
  existsSync(p: string) { return this.files.has(p) || this.dirs.has(p); }
  readFile(p: string) { return this.files.has(p) ? this.files.get(p) ?? null : null; }
  writeFile(p: string, c: string) { this.files.set(p, c); }
  mkdirp(p: string) {
    const parts = p.split('/').filter(Boolean);
    let cur = p.startsWith('/') ? '' : '.';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : `/${part}`;
      this.dirs.add(cur);
    }
    this.dirs.add(p);
  }
  openWriteFd(p: string) {
    const fd = this.nextFd++;
    this.openFds.add(fd);
    // Simulate file creation (truncate if exists)
    this.files.set(p, '');
    return fd;
  }
  closeFd(fd: number) { this.openFds.delete(fd); }
  unlink(p: string) { this.files.delete(p); }
  pidAlive(pid: number) { return this.alivePids.has(pid); }
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL') {
    this.signaled.push({ pid, sig });
    if (this.alivePids.has(pid)) {
      // For SIGKILL, always removes alive. For SIGTERM we simulate "didn't die" unless test marks it.
      if (sig === 'SIGKILL') this.alivePids.delete(pid);
      return true;
    }
    return false;
  }
  spawnDetached(cmd: string, args: string[], opts: { cwd: string; stdoutFd: number; stderrFd: number }) {
    const assignedPid = this.nextPid++;
    this.spawnCalls.push({ cmd, args, cwd: opts.cwd, stdoutFd: opts.stdoutFd, stderrFd: opts.stderrFd, assignedPid });
    this.alivePids.add(assignedPid);
    return assignedPid;
  }
  uuid() { return this.nextUuid; }
}

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

describe('dispatchPaths / runPaths', () => {
  it('derives canonical paths from slot dir', () => {
    const p = dispatchPaths('/lw/a7');
    expect(p.dispatchDir).toBe('/lw/a7/.dispatch');
    expect(p.currentFile).toBe('/lw/a7/.dispatch/current.json');
    expect(p.runsDir).toBe('/lw/a7/.dispatch/runs');
  });
  it('derives run paths under a runId', () => {
    const p = dispatchPaths('/lw/a7');
    const rp = runPaths(p, '20260416T150000Z-abc123');
    expect(rp.runDir).toBe('/lw/a7/.dispatch/runs/20260416T150000Z-abc123');
    expect(rp.metaFile).toBe('/lw/a7/.dispatch/runs/20260416T150000Z-abc123/meta.json');
    expect(rp.eventsFile).toBe('/lw/a7/.dispatch/runs/20260416T150000Z-abc123/events.jsonl');
    expect(rp.stderrFile).toBe('/lw/a7/.dispatch/runs/20260416T150000Z-abc123/stderr.log');
  });
});

// ---------------------------------------------------------------------------
// generateRunId + shortHexFromUuid
// ---------------------------------------------------------------------------

describe('generateRunId', () => {
  it('produces a human-sortable ISO timestamp + hex suffix', () => {
    const runId = generateRunId(new Date('2026-04-16T14:30:22Z'), 'ab12cd');
    expect(runId).toBe('20260416T143022Z-ab12cd');
  });
  it('pads single-digit components', () => {
    const runId = generateRunId(new Date('2026-01-02T03:04:05Z'), '000000');
    expect(runId).toBe('20260102T030405Z-000000');
  });
});

describe('shortHexFromUuid', () => {
  it('takes the last 6 chars of the trailing segment', () => {
    expect(shortHexFromUuid('11111111-2222-3333-4444-555555555555')).toBe('555555');
  });
  it('handles uppercase by lowercasing', () => {
    expect(shortHexFromUuid('11111111-2222-3333-4444-ABCDEFabcdef')).toBe('abcdef');
  });
});

// ---------------------------------------------------------------------------
// buildClaudeArgv
// ---------------------------------------------------------------------------

describe('isPermissionMode / PERMISSION_MODES', () => {
  it('accepts every mode documented by claude --help 2.1.x', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk']) {
      expect(isPermissionMode(mode)).toBe(true);
    }
  });
  it('rejects unknown modes', () => {
    expect(isPermissionMode('bogus')).toBe(false);
    expect(isPermissionMode('')).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
    expect(isPermissionMode(42)).toBe(false);
  });
  it('PERMISSION_MODES tuple matches the documented claude 2.1.x modes', () => {
    expect([...PERMISSION_MODES].sort()).toEqual(
      ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
    );
  });
});

describe('buildClaudeArgv', () => {
  it('builds a full argv with all required flags and terminates options with -- before the prompt', () => {
    const argv = buildClaudeArgv({
      sessionId: 'abc-123',
      prompt: 'hi',
      model: 'sonnet',
      maxBudgetUsd: 5,
      allowedTools: 'Bash,Read',
      permissionMode: 'bypassPermissions',
    });
    expect(argv).toEqual([
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--session-id', 'abc-123',
      '--model', 'sonnet',
      '--max-budget-usd', '5',
      '--allowedTools', 'Bash,Read',
      '--permission-mode', 'bypassPermissions',
      '--disable-slash-commands',
      '--', 'hi',
    ]);
  });
  it('inserts --append-system-prompt before the -- separator', () => {
    const argv = buildClaudeArgv({
      sessionId: 'abc-123',
      prompt: 'hi',
      model: 'sonnet',
      maxBudgetUsd: 5,
      allowedTools: 'Bash',
      permissionMode: 'bypassPermissions',
      appendSystemPrompt: 'You are a worker.',
    });
    const sepIdx = argv.indexOf('--');
    const appendIdx = argv.indexOf('--append-system-prompt');
    expect(appendIdx).toBeGreaterThan(-1);
    expect(sepIdx).toBeGreaterThan(-1);
    expect(appendIdx).toBeLessThan(sepIdx);
    expect(argv[appendIdx + 1]).toBe('You are a worker.');
    expect(argv[sepIdx + 1]).toBe('hi');
  });
  it('preserves a prompt that starts with two dashes as a positional', () => {
    const argv = buildClaudeArgv({
      sessionId: 'abc-123',
      prompt: '--force the parser to crash and summarize',
      model: 'sonnet',
      maxBudgetUsd: 5,
      allowedTools: 'Bash',
      permissionMode: 'bypassPermissions',
    });
    // Prompt must live AFTER the -- separator so claude treats it as the
    // positional prompt arg, not a flag.
    const sepIdx = argv.indexOf('--');
    expect(sepIdx).toBeGreaterThan(-1);
    expect(argv[sepIdx + 1]).toBe('--force the parser to crash and summarize');
  });
});

// ---------------------------------------------------------------------------
// current / meta read/write
// ---------------------------------------------------------------------------

describe('writeCurrent / readCurrent / clearCurrent', () => {
  let env: FakeEnv;
  beforeEach(() => { env = new FakeEnv(); });

  it('round-trips a current pointer', () => {
    const paths = dispatchPaths('/lw/a1');
    writeCurrent(env, paths, {
      runId: 'r1', sessionId: 's1', pid: 12345, startedAt: '2026-04-16T15:00:00Z',
    });
    const got = readCurrent(env, paths);
    expect(got).toEqual({ runId: 'r1', sessionId: 's1', pid: 12345, startedAt: '2026-04-16T15:00:00Z' });
  });

  it('readCurrent returns null when absent', () => {
    const paths = dispatchPaths('/lw/a1');
    expect(readCurrent(env, paths)).toBeNull();
  });

  it('readCurrent returns null on malformed JSON', () => {
    const paths = dispatchPaths('/lw/a1');
    env.files.set(paths.currentFile, 'not json');
    expect(readCurrent(env, paths)).toBeNull();
  });

  it('clearCurrent removes the pointer', () => {
    const paths = dispatchPaths('/lw/a1');
    writeCurrent(env, paths, { runId: 'r', sessionId: 's', pid: 1, startedAt: 'now' });
    clearCurrent(env, paths);
    expect(readCurrent(env, paths)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseEventLine
// ---------------------------------------------------------------------------

describe('parseEventLine', () => {
  it('returns null on empty input', () => {
    expect(parseEventLine('')).toBeNull();
    expect(parseEventLine('   \n')).toBeNull();
  });

  it('tags non-JSON lines as "other" with clipped summary', () => {
    const r = parseEventLine('not json');
    expect(r?.kind).toBe('other');
    expect(r?.summary).toBe('not json');
  });

  it('parses system/init', () => {
    const line = JSON.stringify({
      type: 'system', subtype: 'init',
      cwd: '/tmp/x', session_id: 'abcdef12-34-56', model: 'claude-opus-4-7',
    });
    const r = parseEventLine(line);
    expect(r?.kind).toBe('init');
    expect(r?.summary).toContain('init model=claude-opus-4-7');
    expect(r?.summary).toContain('cwd=/tmp/x');
    expect(r?.summary).toContain('session=abcdef12');
  });

  it('parses assistant text content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello there' }] },
    });
    const r = parseEventLine(line);
    expect(r?.kind).toBe('text');
    expect(r?.summary).toBe('hello there');
  });

  it('parses assistant tool_use with command input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }] },
    });
    const r = parseEventLine(line);
    expect(r?.kind).toBe('tool_use');
    expect(r?.summary).toBe('[tool] Bash: git status');
  });

  it('parses assistant tool_use with file_path input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.txt' } }] },
    });
    expect(parseEventLine(line)?.summary).toBe('[tool] Read: /a/b.txt');
  });

  it('parses user tool_result with string content', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'output line' }] },
    });
    const r = parseEventLine(line);
    expect(r?.kind).toBe('tool_result');
    expect(r?.summary).toContain('output line');
  });

  it('parses user tool_result with is_error', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', is_error: true, content: 'oops' }] },
    });
    const r = parseEventLine(line);
    expect(r?.kind).toBe('tool_result');
    expect(r?.summary).toContain('ERROR');
  });

  it('parses successful result event', () => {
    const line = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      stop_reason: 'end_turn', num_turns: 3, duration_ms: 4200, total_cost_usd: 0.0425,
    });
    const r = parseEventLine(line);
    expect(r?.kind).toBe('result');
    expect(r?.summary).toContain('stop=end_turn');
    expect(r?.summary).toContain('turns=3');
    expect(r?.summary).toContain('duration=4.2s');
    expect(r?.summary).toContain('cost=$0.0425');
  });

  it('tags errored result as "error"', () => {
    const line = JSON.stringify({
      type: 'result', is_error: true, stop_reason: 'api_error',
      num_turns: 1, duration_ms: 100, total_cost_usd: 0.01,
    });
    const r = parseEventLine(line);
    expect(r?.kind).toBe('error');
    expect(r?.summary).toContain('ERROR');
  });

  it('parses assistant thinking content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'user wants pong' }] },
    });
    const r = parseEventLine(line);
    expect(r?.kind).toBe('text');
    expect(r?.summary).toBe('[thinking] user wants pong');
  });

  it('clips very long text to ~160 chars', () => {
    const long = 'x'.repeat(500);
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: long }] } });
    const r = parseEventLine(line);
    expect(r?.summary.length).toBeLessThanOrEqual(160);
    expect(r?.summary.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseEventsFile + findResultEvent
// ---------------------------------------------------------------------------

describe('parseEventsFile', () => {
  it('returns [] for missing file', () => {
    const env = new FakeEnv();
    expect(parseEventsFile(env, '/nope/nope.jsonl')).toEqual([]);
  });

  it('parses every non-empty line', () => {
    const env = new FakeEnv();
    env.files.set('/a/events.jsonl',
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/x', session_id: 's', model: 'm' }) + '\n' +
      '\n' +  // blank line — should be skipped
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n' +
      JSON.stringify({ type: 'result', is_error: false, stop_reason: 'end_turn', num_turns: 1, duration_ms: 1, total_cost_usd: 0 }) + '\n',
    );
    const events = parseEventsFile(env, '/a/events.jsonl');
    expect(events.map((e) => e.kind)).toEqual(['init', 'text', 'result']);
  });
});

describe('readFinalResultEvent', () => {
  it('returns null when file is missing or empty', () => {
    const env = new FakeEnv();
    expect(readFinalResultEvent(env, '/nope.jsonl')).toBeNull();
    env.files.set('/empty.jsonl', '');
    expect(readFinalResultEvent(env, '/empty.jsonl')).toBeNull();
    env.files.set('/whitespace.jsonl', '   \n\n');
    expect(readFinalResultEvent(env, '/whitespace.jsonl')).toBeNull();
  });

  it('returns null when the last line is not a result event', () => {
    const env = new FakeEnv();
    env.files.set('/a.jsonl',
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/x', session_id: 's', model: 'm' }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }) + '\n',
    );
    expect(readFinalResultEvent(env, '/a.jsonl')).toBeNull();
  });

  it('returns the final result event without parsing prior lines', () => {
    const env = new FakeEnv();
    env.files.set('/a.jsonl',
      'not-json-garbage\n' + // would cause findResultEvent to tag as other
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n' +
      JSON.stringify({ type: 'result', is_error: false, stop_reason: 'end_turn', num_turns: 1, duration_ms: 1, total_cost_usd: 0 }) + '\n',
    );
    const r = readFinalResultEvent(env, '/a.jsonl');
    expect(r?.kind).toBe('result');
  });

  it('handles a result line with no trailing newline', () => {
    const env = new FakeEnv();
    env.files.set('/a.jsonl',
      JSON.stringify({ type: 'result', is_error: true, stop_reason: 'max_tokens', num_turns: 1, duration_ms: 1, total_cost_usd: 0 }),
    );
    const r = readFinalResultEvent(env, '/a.jsonl');
    expect(r?.kind).toBe('error');
  });
});

describe('findResultEvent', () => {
  it('returns the final result', () => {
    const env = new FakeEnv();
    env.files.set('/a/events.jsonl',
      JSON.stringify({ type: 'result', is_error: false, stop_reason: 'end_turn', num_turns: 1, duration_ms: 1, total_cost_usd: 0 }) + '\n',
    );
    const events = parseEventsFile(env, '/a/events.jsonl');
    expect(findResultEvent(events)?.kind).toBe('result');
  });
  it('returns the error result when is_error=true', () => {
    const env = new FakeEnv();
    env.files.set('/a/events.jsonl',
      JSON.stringify({ type: 'result', is_error: true, stop_reason: 'error', num_turns: 0, duration_ms: 0, total_cost_usd: 0 }) + '\n',
    );
    const events = parseEventsFile(env, '/a/events.jsonl');
    expect(findResultEvent(events)?.kind).toBe('error');
  });
  it('returns null when no result event', () => {
    const env = new FakeEnv();
    env.files.set('/a/events.jsonl',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n',
    );
    const events = parseEventsFile(env, '/a/events.jsonl');
    expect(findResultEvent(events)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// spawnDispatch + detectConflict
// ---------------------------------------------------------------------------

describe('spawnDispatch', () => {
  it('spawns claude, writes meta + current, returns handle', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a3');
    const r = spawnDispatch(env, paths, {
      slot: 3, cwd: '/lw/a3', prompt: 'echo hi',
    });

    expect(env.spawnCalls.length).toBe(1);
    const [call] = env.spawnCalls;
    expect(call.cmd).toBe('claude');
    expect(call.args).toContain('--session-id');
    expect(call.args).toContain('--print');
    expect(call.args).toContain('echo hi');
    // Prompt must come after the -- separator so claude treats it as positional.
    const sepIdx = call.args.indexOf('--');
    expect(sepIdx).toBeGreaterThan(-1);
    expect(call.args[sepIdx + 1]).toBe('echo hi');
    expect(call.cwd).toBe('/lw/a3');
    // file descriptors were given to child and then closed by parent
    expect(env.openFds.size).toBe(0);

    // handle returned
    expect(r.handle.pid).toBe(call.assignedPid);
    expect(r.handle.sessionId).toBe(env.nextUuid);
    expect(r.handle.runId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/);

    // state persisted
    const current = readCurrent(env, paths);
    expect(current?.pid).toBe(call.assignedPid);
    expect(current?.sessionId).toBe(env.nextUuid);
    const rp = runPaths(paths, r.handle.runId);
    const meta = readMeta(env, rp);
    expect(meta?.pid).toBe(call.assignedPid);
    expect(meta?.slot).toBe(3);
    expect(meta?.cwd).toBe('/lw/a3');
    expect(meta?.prompt).toBe('echo hi');
    expect(meta?.model).toBe('sonnet'); // default
    expect(meta?.maxBudgetUsd).toBe(5); // default
  });

  it('honors model / budget / allowedTools overrides', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a3');
    spawnDispatch(env, paths, {
      slot: 3, cwd: '/lw/a3', prompt: 'x',
      model: 'opus', maxBudgetUsd: 12, allowedTools: 'Read',
      permissionMode: 'acceptEdits',
    });
    const call = env.spawnCalls[0];
    const i = (flag: string) => call.args.indexOf(flag);
    expect(call.args[i('--model') + 1]).toBe('opus');
    expect(call.args[i('--max-budget-usd') + 1]).toBe('12');
    expect(call.args[i('--allowedTools') + 1]).toBe('Read');
    expect(call.args[i('--permission-mode') + 1]).toBe('acceptEdits');
  });
});

describe('detectConflict', () => {
  it('returns null when no current pointer', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a3');
    expect(detectConflict(env, paths)).toBeNull();
  });

  it('returns the conflict when pid is alive', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a3');
    writeCurrent(env, paths, { runId: 'r', sessionId: 's', pid: 42, startedAt: 'now' });
    env.alivePids.add(42);
    const c = detectConflict(env, paths);
    expect(c).not.toBeNull();
    expect(c?.pid).toBe(42);
    expect(c?.pidAlive).toBe(true);
  });

  it('returns null when pid is dead (stale pointer)', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a3');
    writeCurrent(env, paths, { runId: 'r', sessionId: 's', pid: 42, startedAt: 'now' });
    // pid NOT in alivePids
    expect(detectConflict(env, paths)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// finalizeIfComplete
// ---------------------------------------------------------------------------

describe('finalizeIfComplete', () => {
  const BASE_META: RunMeta = {
    runId: 'r1', sessionId: 's1', pid: 99, slot: 1, cwd: '/lw/a1',
    prompt: 'x', model: 'sonnet', maxBudgetUsd: 5,
    allowedTools: 'Bash', permissionMode: 'bypassPermissions',
    startedAt: '2026-04-16T15:00:00Z', cmd: ['claude'],
  };

  it('is a no-op when meta is already completed', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a1');
    const rp = runPaths(paths, 'r1');
    const already = { ...BASE_META, completedAt: '2026-04-16T15:10:00Z', terminalReason: 'completed' };
    const out = finalizeIfComplete(env, paths, rp, already);
    expect(out).toBe(already);
  });

  it('finalizes on a successful result event', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a1');
    const rp = runPaths(paths, 'r1');
    writeCurrent(env, paths, { runId: 'r1', sessionId: 's1', pid: 99, startedAt: '2026-04-16T15:00:00Z' });
    env.alivePids.add(99);
    env.files.set(rp.eventsFile,
      JSON.stringify({ type: 'result', is_error: false, stop_reason: 'end_turn', num_turns: 2, duration_ms: 3000, total_cost_usd: 0.02, terminal_reason: 'completed' }) + '\n',
    );
    const out = finalizeIfComplete(env, paths, rp, BASE_META);
    expect(out.completedAt).toBeTruthy();
    expect(out.exitCode).toBe(0);
    expect(out.terminalReason).toBe('completed');
    expect(out.totalCostUsd).toBe(0.02);
    expect(out.numTurns).toBe(2);
    expect(out.durationMs).toBe(3000);
    // current pointer cleared
    expect(readCurrent(env, paths)).toBeNull();
  });

  it('finalizes on an errored result event, preserving stop_reason as the terminalReason', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a1');
    const rp = runPaths(paths, 'r1');
    writeCurrent(env, paths, { runId: 'r1', sessionId: 's1', pid: 99, startedAt: 'x' });
    env.files.set(rp.eventsFile,
      JSON.stringify({ type: 'result', is_error: true, stop_reason: 'api_error', num_turns: 0, duration_ms: 100, total_cost_usd: 0 }) + '\n',
    );
    const out = finalizeIfComplete(env, paths, rp, BASE_META);
    expect(out.exitCode).toBe(1);
    // Prefer the actual stop_reason when present; only fall back to generic 'error' when neither terminal_reason nor stop_reason is emitted.
    expect(out.terminalReason).toBe('api_error');
  });

  it('falls back to generic "error" when neither terminal_reason nor stop_reason is present', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a1');
    const rp = runPaths(paths, 'r1');
    writeCurrent(env, paths, { runId: 'r1', sessionId: 's1', pid: 99, startedAt: 'x' });
    env.files.set(rp.eventsFile,
      JSON.stringify({ type: 'result', is_error: true, num_turns: 0, duration_ms: 100, total_cost_usd: 0 }) + '\n',
    );
    const out = finalizeIfComplete(env, paths, rp, BASE_META);
    expect(out.terminalReason).toBe('error');
  });

  it('prefers terminal_reason over stop_reason when both are present', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a1');
    const rp = runPaths(paths, 'r1');
    writeCurrent(env, paths, { runId: 'r1', sessionId: 's1', pid: 99, startedAt: 'x' });
    env.files.set(rp.eventsFile,
      JSON.stringify({ type: 'result', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed', num_turns: 1, duration_ms: 100, total_cost_usd: 0 }) + '\n',
    );
    const out = finalizeIfComplete(env, paths, rp, BASE_META);
    expect(out.terminalReason).toBe('completed');
  });

  it('marks dead_without_result when pid is dead and no result event', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a1');
    const rp = runPaths(paths, 'r1');
    writeCurrent(env, paths, { runId: 'r1', sessionId: 's1', pid: 99, startedAt: 'x' });
    // no events, pid not alive
    const out = finalizeIfComplete(env, paths, rp, BASE_META);
    expect(out.completedAt).toBeTruthy();
    expect(out.terminalReason).toBe('dead_without_result');
    expect(readCurrent(env, paths)).toBeNull();
  });

  it('finds the result even when a trailing non-result line follows it', () => {
    // Regression: earlier `readFinalResultEvent`-only implementation missed the
    // result when any content followed (rate_limit_event, partial flush, etc).
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a1');
    const rp = runPaths(paths, 'r1');
    writeCurrent(env, paths, { runId: 'r1', sessionId: 's1', pid: 99, startedAt: 'x' });
    env.files.set(rp.eventsFile,
      JSON.stringify({ type: 'result', is_error: false, stop_reason: 'end_turn', num_turns: 1, duration_ms: 100, total_cost_usd: 0.01, terminal_reason: 'completed' }) + '\n' +
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }) + '\n',
    );
    const out = finalizeIfComplete(env, paths, rp, BASE_META);
    expect(out.completedAt).toBeTruthy();
    expect(out.terminalReason).toBe('completed');
    expect(out.exitCode).toBe(0);
  });

  it('leaves meta unchanged while run is still live and no result yet', () => {
    const env = new FakeEnv();
    const paths = dispatchPaths('/lw/a1');
    const rp = runPaths(paths, 'r1');
    writeCurrent(env, paths, { runId: 'r1', sessionId: 's1', pid: 99, startedAt: 'x' });
    env.alivePids.add(99);
    env.files.set(rp.eventsFile,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }) + '\n',
    );
    const out = finalizeIfComplete(env, paths, rp, BASE_META);
    expect(out.completedAt).toBeUndefined();
    expect(readCurrent(env, paths)).not.toBeNull();
  });
});
