/**
 * Agent slot dispatch — headless `claude -p` worker spawning (QUA-554).
 *
 * Dispatches a one-shot Claude Code worker into an agent slot via
 * `claude -p --output-format stream-json`. The worker runs detached so the
 * dispatcher returns immediately; per-run JSONL + meta live under
 * `lw/aN/.dispatch/runs/<runId>/`.
 *
 * Design notes:
 * - Pre-generate session_id (UUID) and pass via --session-id so the caller
 *   knows it before the child writes anything. Enables `claude -c <id>`
 *   manual resume if the worker crashes.
 * - Slot-busy detection is a `.dispatch/current.json` pointer + PID liveness
 *   check. --force bypasses.
 * - Real side-effects (fs, spawn, pid-alive) go through DispatchEnv so tests
 *   can substitute in-memory implementations.
 */

import { randomUUID } from 'crypto';
import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  renameSync as fsRenameSync,
  mkdirSync as fsMkdirSync,
  openSync as fsOpenSync,
  closeSync as fsCloseSync,
  unlinkSync as fsUnlinkSync,
} from 'fs';
import { spawn as cpSpawn, type ChildProcess, type SpawnOptions } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Claude CLI permission modes accepted by `--permission-mode`.
 * Keep in sync with `claude --help` for the installed version.
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Worker-appropriate tool allowlist. Exported so operators can reference it. */
export const DEFAULT_ALLOWED_TOOLS = 'Bash,Edit,Read,Write,Grep,Glob';

/** Cost cap (USD) applied to every dispatch unless overridden. */
export const DEFAULT_MAX_BUDGET_USD = 5;

/** Cost-conscious default model. Caller can override with --model. */
export const DEFAULT_MODEL = 'sonnet';

/** Headless workers cannot answer prompts, so default to bypass. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions';

export interface DispatchOptions {
  /** Slot number (positive integer). */
  slot: number;
  /** Working directory for the spawned `claude` process (typically `lw/aN`). */
  cwd: string;
  /** The user prompt to send. */
  prompt: string;
  /** Model alias, e.g. "sonnet" | "opus" | "haiku". Default: sonnet. */
  model?: string;
  /** Max API spend (USD) for the dispatched run. Default: 5. */
  maxBudgetUsd?: number;
  /** Comma-separated allowed tools. Default: sensible worker set. */
  allowedTools?: string;
  /** Extra text appended to the default system prompt. Optional. */
  appendSystemPrompt?: string;
  /** Permission mode passed to `claude --permission-mode`. Default: bypassPermissions. */
  permissionMode?: PermissionMode;
  /** When true, ignore an existing live dispatch in the target slot. */
  force?: boolean;
}

/** True if `s` is a valid claude CLI permission mode. */
export function isPermissionMode(s: unknown): s is PermissionMode {
  return typeof s === 'string' && (PERMISSION_MODES as readonly string[]).includes(s);
}

export interface DispatchHandle {
  runId: string;
  sessionId: string;
  pid: number;
  runDir: string;
  eventsFile: string;
  metaFile: string;
  stderrFile: string;
  startedAt: string;
  cmd: string[];
}

/** On-disk record of a single dispatch run. */
export interface RunMeta {
  runId: string;
  sessionId: string;
  pid: number;
  slot: number;
  cwd: string;
  prompt: string;
  model: string;
  maxBudgetUsd: number;
  allowedTools: string;
  permissionMode: PermissionMode;
  startedAt: string;
  /** ISO timestamp when the run was detected complete (result event arrived). */
  completedAt?: string;
  /** ISO timestamp when a stop was requested. */
  stoppedAt?: string;
  /** Set when a `result` event is parsed out of the event stream. */
  terminalReason?: string;
  exitCode?: number;
  totalCostUsd?: number;
  numTurns?: number;
  durationMs?: number;
  cmd: string[];
}

/** Pointer to the active run for a slot. Absent when idle. */
export interface CurrentPointer {
  runId: string;
  sessionId: string;
  pid: number;
  startedAt: string;
}

/** One parsed event line, summarised for human display. */
export interface EventSummary {
  kind: 'init' | 'text' | 'tool_use' | 'tool_result' | 'result' | 'error' | 'rate_limit' | 'other';
  /** Concise one-line human description, clamped to ~160 chars. */
  summary: string;
  /** Raw event object (for --json consumers). */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Environment abstraction
// ---------------------------------------------------------------------------

export interface DispatchEnv {
  now(): Date;
  existsSync(path: string): boolean;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  mkdirp(path: string): void;
  openWriteFd(path: string): number;
  closeFd(fd: number): void;
  unlink(path: string): void;
  /** kill(pid, 0) — returns true if the pid is alive. */
  pidAlive(pid: number): boolean;
  /** SIGTERM / SIGKILL. Returns true on success, false if pid already gone. */
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean;
  /**
   * Spawn `claude` detached with stdout/stderr wired to the provided fds.
   * Returns the child pid. Does not wait.
   */
  spawnDetached(cmd: string, args: string[], opts: { cwd: string; stdoutFd: number; stderrFd: number }): number;
  /** Generate a UUID v4 (pre-assigned session id). */
  uuid(): string;
}

export function realDispatchEnv(): DispatchEnv {
  return {
    now: () => new Date(),
    existsSync: (p) => fsExistsSync(p),
    readFile: (p) => {
      try {
        return fsReadFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
    writeFile: (p, c) => {
      // Atomic: write to <p>.tmp then rename.
      const tmp = `${p}.tmp`;
      fsWriteFileSync(tmp, c);
      fsRenameSync(tmp, p);
    },
    mkdirp: (p) => fsMkdirSync(p, { recursive: true }),
    openWriteFd: (p) => fsOpenSync(p, 'w'),
    closeFd: (fd) => fsCloseSync(fd),
    unlink: (p) => {
      try {
        fsUnlinkSync(p);
      } catch (e) {
        // ENOENT is fine (file already gone). Other errors (permission, busy)
        // indicate real problems and should surface.
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
      }
    },
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    signal: (pid, sig) => {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    },
    spawnDetached: (cmd, args, { cwd, stdoutFd, stderrFd }) => {
      const spawnOpts: SpawnOptions = {
        cwd,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      };
      const child: ChildProcess = cpSpawn(cmd, args, spawnOpts);
      if (typeof child.pid !== 'number') {
        throw new Error(`spawn('${cmd}') returned no pid`);
      }
      child.unref();
      return child.pid;
    },
    uuid: () => randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export interface DispatchPaths {
  slotDir: string;
  dispatchDir: string;
  currentFile: string;
  runsDir: string;
}

export function dispatchPaths(slotDir: string): DispatchPaths {
  return {
    slotDir,
    dispatchDir: `${slotDir}/.dispatch`,
    currentFile: `${slotDir}/.dispatch/current.json`,
    runsDir: `${slotDir}/.dispatch/runs`,
  };
}

export interface RunPaths {
  runDir: string;
  metaFile: string;
  eventsFile: string;
  stderrFile: string;
}

export function runPaths(dispatchPathsValue: DispatchPaths, runId: string): RunPaths {
  const runDir = `${dispatchPathsValue.runsDir}/${runId}`;
  return {
    runDir,
    metaFile: `${runDir}/meta.json`,
    eventsFile: `${runDir}/events.jsonl`,
    stderrFile: `${runDir}/stderr.log`,
  };
}

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

/**
 * Generate a human-sortable run id: `YYYYMMDDTHHMMSSZ-<6 hex>`.
 * E.g. `20260416T143022Z-ab12cd`.
 */
export function generateRunId(now: Date, randomHex6: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `${stamp}-${randomHex6}`;
}

/**
 * Derive 6 hex chars from a full UUID so run IDs are deterministic-per-session.
 * We take the last 6 of the UUID's final segment.
 */
export function shortHexFromUuid(uuid: string): string {
  const last = uuid.split('-').pop() ?? uuid;
  return last.slice(-6).toLowerCase();
}

// ---------------------------------------------------------------------------
// Argv builder
// ---------------------------------------------------------------------------

export interface BuildArgvInput {
  sessionId: string;
  prompt: string;
  model: string;
  maxBudgetUsd: number;
  allowedTools: string;
  permissionMode: PermissionMode;
  appendSystemPrompt?: string;
}

export function buildClaudeArgv(input: BuildArgvInput): string[] {
  const argv: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    input.sessionId,
    '--model',
    input.model,
    '--max-budget-usd',
    String(input.maxBudgetUsd),
    '--allowedTools',
    input.allowedTools,
    '--permission-mode',
    input.permissionMode,
    '--disable-slash-commands',
  ];
  if (input.appendSystemPrompt) {
    argv.push('--append-system-prompt', input.appendSystemPrompt);
  }
  // `--` ends option parsing so a prompt starting with "--" is treated as the
  // positional [prompt] arg rather than an unknown flag.
  argv.push('--', input.prompt);
  return argv;
}

// ---------------------------------------------------------------------------
// State read/write
// ---------------------------------------------------------------------------

export function readCurrent(env: DispatchEnv, paths: DispatchPaths): CurrentPointer | null {
  const raw = env.readFile(paths.currentFile);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CurrentPointer;
  } catch {
    return null;
  }
}

export function writeCurrent(env: DispatchEnv, paths: DispatchPaths, current: CurrentPointer): void {
  env.mkdirp(paths.dispatchDir);
  env.writeFile(paths.currentFile, JSON.stringify(current, null, 2));
}

export function clearCurrent(env: DispatchEnv, paths: DispatchPaths): void {
  env.unlink(paths.currentFile);
}

export function readMeta(env: DispatchEnv, rp: RunPaths): RunMeta | null {
  const raw = env.readFile(rp.metaFile);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunMeta;
  } catch {
    return null;
  }
}

export function writeMeta(env: DispatchEnv, rp: RunPaths, meta: RunMeta): void {
  env.mkdirp(rp.runDir);
  env.writeFile(rp.metaFile, JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

function clip(s: string, n = 160): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

/** Parse a single stream-json line into a summary, or `null` if unparseable. */
export function parseEventLine(line: string): EventSummary | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return { kind: 'other', summary: clip(trimmed) };
  }
  const type = typeof evt.type === 'string' ? evt.type : '';
  const subtype = typeof evt.subtype === 'string' ? evt.subtype : '';

  if (type === 'system' && subtype === 'init') {
    const model = typeof evt.model === 'string' ? evt.model : 'unknown';
    const cwd = typeof evt.cwd === 'string' ? evt.cwd : '';
    const session = typeof evt.session_id === 'string' ? evt.session_id.slice(0, 8) : '';
    return {
      kind: 'init',
      summary: clip(`init model=${model} cwd=${cwd} session=${session}`),
      raw: evt,
    };
  }
  if (type === 'rate_limit_event') {
    const info = (evt.rate_limit_info ?? {}) as Record<string, unknown>;
    return {
      kind: 'rate_limit',
      summary: clip(`rate_limit ${JSON.stringify(info)}`),
      raw: evt,
    };
  }
  if (type === 'assistant') {
    const msg = (evt.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
    for (const part of content) {
      const partType = typeof part.type === 'string' ? part.type : '';
      if (partType === 'text' && typeof part.text === 'string') {
        return { kind: 'text', summary: clip(part.text), raw: evt };
      }
      if (partType === 'thinking' && typeof part.thinking === 'string') {
        return { kind: 'text', summary: clip(`[thinking] ${part.thinking}`), raw: evt };
      }
      if (partType === 'tool_use') {
        const name = typeof part.name === 'string' ? part.name : '?';
        const input = part.input;
        let inputPreview = '';
        if (input && typeof input === 'object') {
          const io = input as Record<string, unknown>;
          if (typeof io.command === 'string') inputPreview = io.command;
          else if (typeof io.file_path === 'string') inputPreview = io.file_path;
          else if (typeof io.pattern === 'string') inputPreview = io.pattern;
          else if (typeof io.path === 'string') inputPreview = io.path;
          else if (typeof io.url === 'string') inputPreview = io.url;
          else inputPreview = JSON.stringify(input);
        }
        return { kind: 'tool_use', summary: clip(`[tool] ${name}: ${inputPreview}`), raw: evt };
      }
    }
    return { kind: 'other', summary: 'assistant (no text/tool_use)', raw: evt };
  }
  if (type === 'user') {
    const msg = (evt.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
    for (const part of content) {
      if (typeof part.type === 'string' && part.type === 'tool_result') {
        const isError = part.is_error === true;
        let preview = '';
        if (typeof part.content === 'string') preview = part.content;
        else if (Array.isArray(part.content)) {
          const first = (part.content as Array<Record<string, unknown>>)[0];
          if (first && typeof first.text === 'string') preview = first.text;
        }
        return {
          kind: 'tool_result',
          summary: clip(`[tool_result${isError ? ' ERROR' : ''}] ${preview}`),
          raw: evt,
        };
      }
    }
    return { kind: 'other', summary: 'user', raw: evt };
  }
  if (type === 'result') {
    const isError = evt.is_error === true;
    const stop = typeof evt.stop_reason === 'string' ? evt.stop_reason : '';
    const durMs = typeof evt.duration_ms === 'number' ? evt.duration_ms : 0;
    const costUsd = typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : 0;
    const turns = typeof evt.num_turns === 'number' ? evt.num_turns : 0;
    return {
      kind: isError ? 'error' : 'result',
      summary: clip(
        `result ${isError ? 'ERROR ' : ''}stop=${stop} turns=${turns} duration=${(durMs / 1000).toFixed(1)}s cost=$${costUsd.toFixed(4)}`,
      ),
      raw: evt,
    };
  }
  return { kind: 'other', summary: clip(`${type}${subtype ? '/' + subtype : ''}`), raw: evt };
}

/** Read the events file and parse every line (order-preserving). Returns [] if file missing. */
export function parseEventsFile(env: DispatchEnv, eventsFile: string): EventSummary[] {
  const raw = env.readFile(eventsFile);
  if (!raw) return [];
  const out: EventSummary[] = [];
  for (const line of raw.split('\n')) {
    const parsed = parseEventLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Find the final `result` event if present. Used to finalize meta.json. */
export function findResultEvent(events: EventSummary[]): EventSummary | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'result' || e.kind === 'error') return e;
  }
  return null;
}

/**
 * Read only the final event line from the events file. Used by
 * `finalizeIfComplete` to avoid O(N) re-parsing the whole stream on every
 * dispatch-status call. The `result` event is always the *last* JSON line, so
 * reading only the tail is sufficient for finalization.
 *
 * Falls back to parsing the full file if the tail doesn't contain a valid JSON
 * line (e.g. the whole file is smaller than the tail window, or the last line
 * is partially written).
 */
export function readFinalResultEvent(env: DispatchEnv, eventsFile: string): EventSummary | null {
  const raw = env.readFile(eventsFile);
  if (!raw) return null;
  const trimmed = raw.trimEnd();
  if (!trimmed) return null;
  const lastNewline = trimmed.lastIndexOf('\n');
  const lastLine = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1);
  const parsed = parseEventLine(lastLine);
  if (parsed && (parsed.kind === 'result' || parsed.kind === 'error')) return parsed;
  return null;
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface SpawnResult {
  handle: DispatchHandle;
  meta: RunMeta;
}

/**
 * Spawn a detached `claude -p` worker. Caller is responsible for having
 * already verified slot-busy / created directories if needed.
 */
export function spawnDispatch(env: DispatchEnv, paths: DispatchPaths, opts: DispatchOptions): SpawnResult {
  const sessionId = env.uuid();
  const runId = generateRunId(env.now(), shortHexFromUuid(sessionId));
  const rp = runPaths(paths, runId);

  env.mkdirp(rp.runDir);

  const model = opts.model ?? DEFAULT_MODEL;
  const maxBudgetUsd = opts.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const argv = buildClaudeArgv({
    sessionId,
    prompt: opts.prompt,
    model,
    maxBudgetUsd,
    allowedTools,
    permissionMode,
    appendSystemPrompt: opts.appendSystemPrompt,
  });

  const stdoutFd = env.openWriteFd(rp.eventsFile);
  let stderrFd: number;
  try {
    stderrFd = env.openWriteFd(rp.stderrFile);
  } catch (e) {
    // If opening stderr fails, we must still release stdout or it leaks.
    env.closeFd(stdoutFd);
    throw e;
  }

  let pid: number;
  try {
    pid = env.spawnDetached('claude', argv, {
      cwd: opts.cwd,
      stdoutFd,
      stderrFd,
    });
  } finally {
    // Parent closes its handles; child inherited duplicates.
    env.closeFd(stdoutFd);
    env.closeFd(stderrFd);
  }

  const startedAt = env.now().toISOString();
  const cmd = ['claude', ...argv];
  const meta: RunMeta = {
    runId,
    sessionId,
    pid,
    slot: opts.slot,
    cwd: opts.cwd,
    prompt: opts.prompt,
    model,
    maxBudgetUsd,
    allowedTools,
    permissionMode,
    startedAt,
    cmd,
  };
  writeMeta(env, rp, meta);
  writeCurrent(env, paths, { runId, sessionId, pid, startedAt });

  return {
    handle: {
      runId,
      sessionId,
      pid,
      runDir: rp.runDir,
      eventsFile: rp.eventsFile,
      metaFile: rp.metaFile,
      stderrFile: rp.stderrFile,
      startedAt,
      cmd,
    },
    meta,
  };
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export interface Conflict {
  runId: string;
  sessionId: string;
  pid: number;
  pidAlive: boolean;
  startedAt: string;
}

/** Return an active-dispatch conflict if one exists in the slot, else null. */
export function detectConflict(env: DispatchEnv, paths: DispatchPaths): Conflict | null {
  const current = readCurrent(env, paths);
  if (!current) return null;
  const alive = env.pidAlive(current.pid);
  if (!alive) {
    // Stale pointer — no real conflict. Caller may choose to clear it.
    return null;
  }
  return {
    runId: current.runId,
    sessionId: current.sessionId,
    pid: current.pid,
    pidAlive: alive,
    startedAt: current.startedAt,
  };
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

/**
 * Inspect the event stream; if a `result` event is present, update meta
 * and clear the slot's current pointer. Idempotent.
 * Returns the updated meta (or the original if no finalization happened).
 */
export function finalizeIfComplete(
  env: DispatchEnv,
  paths: DispatchPaths,
  rp: RunPaths,
  meta: RunMeta,
): RunMeta {
  if (meta.completedAt) return meta;
  // Only the last line can be a terminal `result`/`error` event. Read just the
  // tail to avoid O(N) re-parsing a large events.jsonl on every status call.
  const result = readFinalResultEvent(env, rp.eventsFile);
  if (!result || !result.raw) {
    // No result yet — but if the pid is dead we should at least record that.
    if (!env.pidAlive(meta.pid)) {
      const next: RunMeta = {
        ...meta,
        completedAt: env.now().toISOString(),
        terminalReason: 'dead_without_result',
      };
      writeMeta(env, rp, next);
      clearCurrent(env, paths);
      return next;
    }
    return meta;
  }
  const raw = result.raw as Record<string, unknown>;
  const isError = raw.is_error === true;
  // Prefer the claude-emitted `terminal_reason` (observed: "completed") when
  // present; fall back to `stop_reason` (observed: "end_turn", "max_tokens")
  // for compatibility, then to a generic label.
  const reasonFromStream =
    typeof raw.terminal_reason === 'string'
      ? (raw.terminal_reason as string)
      : typeof raw.stop_reason === 'string'
        ? (raw.stop_reason as string)
        : null;
  const next: RunMeta = {
    ...meta,
    completedAt: env.now().toISOString(),
    terminalReason: reasonFromStream ?? (isError ? 'error' : 'completed'),
    exitCode: isError ? 1 : 0,
    totalCostUsd: typeof raw.total_cost_usd === 'number' ? (raw.total_cost_usd as number) : undefined,
    numTurns: typeof raw.num_turns === 'number' ? (raw.num_turns as number) : undefined,
    durationMs: typeof raw.duration_ms === 'number' ? (raw.duration_ms as number) : undefined,
  };
  writeMeta(env, rp, next);
  clearCurrent(env, paths);
  return next;
}
