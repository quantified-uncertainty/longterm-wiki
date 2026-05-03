/**
 * Integration tests for `spawnClaude` covering the QUA-1078 stream-json + 50k
 * input-token cap migration.
 *
 * Strategy: mock `child_process.spawn` to return a fake child process whose
 * stdout/stderr we drive manually. Tests assert on the final result shape, on
 * whether `child.kill('SIGTERM')` was invoked when the budget was exceeded,
 * and on the `cycle_budget_exceeded` event being appended to runs.jsonl.
 *
 * The real concern of the migration — backward-compat output reconstruction
 * and stream-json parsing — is covered exhaustively by stream-json.test.ts.
 * This file focuses on the spawn lifecycle: child events, timer interactions,
 * kill signalling, JSONL emission.
 */

import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable, Writable } from 'stream';
import { spawn as nodeSpawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Override JSONL_FILE via vi.mock so writes land in a per-test temp dir.
// Plain `process.env.HOME = ...` at the top of the file is **not** sufficient
// because ESM imports are statically hoisted: by the time the assignment
// runs, `state.ts` has already evaluated `JSONL_FILE = join(HOME, ...)` using
// the real HOME. Without this mock the integration tests truncate the
// operator's actual ~/.cache/pr-patrol/runs.jsonl.
const { TEST_JSONL_FILE } = vi.hoisted(() => {
  // CJS APIs only — vi.hoisted runs before any ESM imports resolve.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-claude-test-'));
  const cacheDir = path.join(tmpHome, '.cache', 'pr-patrol');
  fs.mkdirSync(cacheDir, { recursive: true });
  return { TEST_JSONL_FILE: path.join(cacheDir, 'runs.jsonl') };
});

vi.mock('./state.ts', async () => {
  const actual = await vi.importActual<typeof import('./state.ts')>('./state.ts');
  return { ...actual, JSONL_FILE: TEST_JSONL_FILE };
});

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

let lastChild: FakeChild;

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    // Track the signal so the test can assert SIGTERM was sent. Don't
    // auto-exit the child — tests script the close event explicitly.
    if (signal === 'SIGTERM' || signal === undefined) child.signalCode = 'SIGTERM';
    if (signal === 'SIGKILL') child.signalCode = 'SIGKILL';
    return true;
  });
  return child;
}

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => {
      lastChild = makeFakeChild();
      return lastChild;
    }),
  };
});

import type { PatrolConfig } from './types.ts';
import { spawnClaude } from './execution.ts';
import { JSONL_FILE } from './state.ts';

const baseConfig: PatrolConfig = {
  repo: 'q/r',
  intervalSeconds: 60,
  maxTurns: 5,
  cooldownSeconds: 0,
  staleHours: 48,
  model: 'sonnet',
  skipPerms: true,
  once: true,
  dryRun: false,
  verbose: false,
  reflectionInterval: 10,
  timeoutMinutes: 60,
  inputTokenCap: 50_000,
};

const ASSISTANT = (text: string, inputTokens: number) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      usage: { input_tokens: inputTokens, output_tokens: 10 },
      content: [{ type: 'text', text }],
    },
  }) + '\n';

const RESULT_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  stop_reason: 'end_turn',
  result: 'all done',
}) + '\n';

function readJsonlEntries(): Array<Record<string, unknown>> {
  if (!existsSync(JSONL_FILE)) return [];
  return readFileSync(JSONL_FILE, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  // Truncate the JSONL between tests so assertions are scoped per-test.
  // JSONL_FILE here is the mocked path (TEST_JSONL_FILE), guaranteed by the
  // vi.mock above to point inside our temp dir.
  if (existsSync(JSONL_FILE)) writeFileSync(JSONL_FILE, '');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('spawnClaude (stream-json + token cap)', () => {
  it('returns normally and reconstructs output for under-cap runs', async () => {
    const promise = spawnClaude('test prompt', baseConfig, { context: { prNumber: 99 } });

    // Drive the fake child: emit a few assistant events under the cap, then a clean result.
    queueMicrotask(() => {
      lastChild.stdout.push(ASSISTANT('looking at failing test', 5_000));
      lastChild.stdout.push(ASSISTANT('found root cause; pushing fix', 5_000));
      lastChild.stdout.push(RESULT_OK);
      // Defer close so the Readable's internal 'data' emissions drain into
      // our parser before we tell spawnClaude the process exited.
      setImmediate(() => {
        lastChild.exitCode = 0;
        lastChild.emit('close', 0);
      });
    });

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.budgetExceeded).toBe(false);
    expect(result.hitMaxTurns).toBe(false);
    expect(result.inputTokens).toBe(10_000);
    expect(result.output).toContain('looking at failing test');
    expect(result.output).toContain('found root cause');
    expect(result.output).toContain('all done');
  });

  it('SIGTERMs the child and emits cycle_budget_exceeded when input_tokens crosses the cap', async () => {
    const promise = spawnClaude('test prompt', baseConfig, {
      context: { prNumber: 4242, label: 'unit-test' },
    });

    queueMicrotask(() => {
      lastChild.stdout.push(ASSISTANT('thinking...', 25_000));
      lastChild.stdout.push(ASSISTANT('still thinking — really deep tree', 30_000));
      // Caller (spawnClaude) should call kill() right here. We script close
      // shortly after to emulate the child responding to SIGTERM.
      setImmediate(() => {
        lastChild.exitCode = null;
        lastChild.signalCode = 'SIGTERM';
        lastChild.emit('close', null);
      });
    });

    const result = await promise;
    expect(lastChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.budgetExceeded).toBe(true);
    expect(result.inputTokens).toBe(55_000);

    const entries = readJsonlEntries();
    const budgetEntry = entries.find((e) => e.type === 'cycle_budget_exceeded');
    expect(budgetEntry).toBeDefined();
    expect(budgetEntry?.pr_num).toBe(4242);
    expect(budgetEntry?.label).toBe('unit-test');
    expect(budgetEntry?.threshold).toBe(50_000);
    expect(budgetEntry?.observed_input_tokens).toBe(55_000);
    expect(budgetEntry?.kill_succeeded).toBe(true);
  });

  it('does NOT fire the budget kill when cap is 0 (disabled)', async () => {
    const promise = spawnClaude('test', { ...baseConfig, inputTokenCap: 0 }, undefined);

    queueMicrotask(() => {
      lastChild.stdout.push(ASSISTANT('huge', 100_000));
      lastChild.stdout.push(RESULT_OK);
      setImmediate(() => {
        lastChild.exitCode = 0;
        lastChild.emit('close', 0);
      });
    });

    const result = await promise;
    expect(lastChild.kill).not.toHaveBeenCalled();
    expect(result.budgetExceeded).toBe(false);
    expect(result.inputTokens).toBe(100_000);

    const entries = readJsonlEntries();
    expect(entries.find((e) => e.type === 'cycle_budget_exceeded')).toBeUndefined();
  });

  it('detects hitMaxTurns from a max-turns result event', async () => {
    const promise = spawnClaude('test', baseConfig, undefined);

    queueMicrotask(() => {
      lastChild.stdout.push(ASSISTANT('working', 1_000));
      lastChild.stdout.push(JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        stop_reason: 'max_turns',
        result: 'Reached max turns. Stopping.',
      }) + '\n');
      setImmediate(() => {
        lastChild.exitCode = 0;
        lastChild.emit('close', 0);
      });
    });

    const result = await promise;
    expect(result.hitMaxTurns).toBe(true);
    expect(result.budgetExceeded).toBe(false);
  });

  it('passes --output-format stream-json --verbose to claude (regression guard for arg ordering)', async () => {
    const promise = spawnClaude('test', baseConfig, undefined);
    queueMicrotask(() => {
      lastChild.stdout.push(RESULT_OK);
      setImmediate(() => {
        lastChild.exitCode = 0;
        lastChild.emit('close', 0);
      });
    });
    await promise;
    const spawnMock = vi.mocked(nodeSpawn);
    const args = spawnMock.mock.calls.at(-1)![1] as string[];
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--print');
  });

  it('does NOT leak the SIGKILL fallback timer when budget cross fires from the close-handler drain', async () => {
    // The close handler drains a partial line; if that drain crosses the cap,
    // triggerKill is called *after* the child has already exited. The
    // SIGKILL fallback timer would otherwise leak for 10s and delay shutdown.
    const promise = spawnClaude('test', baseConfig, { context: { prNumber: 1 } });
    queueMicrotask(() => {
      // Push a complete event under cap, then a partial line that crosses
      // the cap with NO trailing newline (drained at close).
      lastChild.stdout.push(ASSISTANT('part1', 30_000));
      const partial = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: { input_tokens: 25_000, output_tokens: 1 },
          content: [{ type: 'text', text: 'crossing now' }],
        },
      });
      lastChild.stdout.push(partial);
      setImmediate(() => {
        // Child has already exited cleanly (close fires here). triggerKill
        // should detect this and NOT schedule the SIGKILL timer.
        lastChild.exitCode = 0;
        lastChild.signalCode = null;
        lastChild.emit('close', 0);
      });
    });
    const result = await promise;
    expect(result.budgetExceeded).toBe(true);
    // kill was NOT invoked — child had exited before triggerKill ran, so the
    // early-return guard fires and avoids the leaked SIGKILL timer.
    expect(lastChild.kill).not.toHaveBeenCalled();
  });

  it('does NOT bleed claude stderr into result.output (avoids credential-leak in PR comments)', async () => {
    const promise = spawnClaude('test', baseConfig, undefined);
    queueMicrotask(() => {
      // Simulate claude writing a partial credential string to stderr (auth
      // failure echoes the bad token). This must NOT show up in `output`,
      // since callers post `output.slice(-500)` as a public PR comment.
      lastChild.stderr.push('Bad token: sk-ant-api03-LEAK-DO-NOT-PUBLISH\n');
      lastChild.stdout.push(ASSISTANT('I will look at this', 100));
      lastChild.stdout.push(RESULT_OK);
      setImmediate(() => {
        lastChild.exitCode = 0;
        lastChild.emit('close', 0);
      });
    });
    const result = await promise;
    expect(result.output).not.toContain('sk-ant-api03');
    expect(result.output).not.toContain('Bad token');
    expect(result.output).toContain('I will look at this');
  });

  it('emits the budget event even if a partial final line lacks a trailing newline', async () => {
    const promise = spawnClaude('test', baseConfig, { context: { prNumber: 7 } });

    queueMicrotask(() => {
      // Push without trailing newline — close should drain the buffer.
      lastChild.stdout.push(ASSISTANT('part1', 30_000).trimEnd());  // valid line
      lastChild.stdout.push('\n');
      // Now a partial line that crosses the cap, never terminated:
      const partial = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: { input_tokens: 25_000, output_tokens: 1 },
          content: [{ type: 'text', text: 'crossing now' }],
        },
      });
      lastChild.stdout.push(partial);
      // Don't push '\n' — verify the close handler drains the partial.
      setImmediate(() => {
        lastChild.exitCode = null;
        lastChild.signalCode = 'SIGTERM';
        lastChild.emit('close', null);
      });
    });

    const result = await promise;
    expect(result.budgetExceeded).toBe(true);
    expect(result.inputTokens).toBe(55_000);
  });
});
