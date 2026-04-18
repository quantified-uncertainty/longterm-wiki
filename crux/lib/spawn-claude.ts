/**
 * Canonical `claude` CLI spawn wrapper — QUA-599.
 *
 * Every `spawn('claude', ...)` call in this codebase must go through this
 * wrapper. The gate validator `validate-no-raw-claude-spawn.ts` enforces it.
 *
 * Why this exists:
 *   Claude CLI prefers ANTHROPIC_API_KEY over the OAuth session (Claude
 *   Max/Pro subscription) when the env var is set. Agent slot `.env` files
 *   ship stale API keys — the coordinator's subscription is the billing
 *   identity we actually want. Without stripping the key, subprocesses fail
 *   silently with 401s or "Credit balance is too low".
 *
 *   This bug was rediscovered at least three times in separate files
 *   (page-improver, pr-patrol, dispatch) before this wrapper landed.
 *
 * Default behavior: delete ANTHROPIC_API_KEY from the child env so the CLI
 * uses OAuth. Use `keepApiKey: { reason }` only when the caller needs to
 * run under an API-key billing identity (e.g., a prod service account with
 * no OAuth session available).
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
  type SpawnOptionsWithStdioTuple,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
  type StdioPipe,
} from 'child_process';
import type { Readable, Writable } from 'stream';

export interface SpawnClaudeCommonOptions {
  /** Extra env vars merged on top of the base env (overriding). */
  extraEnv?: NodeJS.ProcessEnv;
  /**
   * Escape hatch: keep ANTHROPIC_API_KEY in the subprocess env. Requires
   * a reason string so every use is grep-able and auditable.
   */
  keepApiKey?: { reason: string };
}

export type SpawnClaudeOptions = SpawnOptions & SpawnClaudeCommonOptions;
export type SpawnClaudeSyncOptions = SpawnSyncOptions & SpawnClaudeCommonOptions;

type PipeTupleOptions = SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe> &
  SpawnClaudeCommonOptions;

/**
 * Build the child env, stripping ANTHROPIC_API_KEY unless keepApiKey is set.
 * Exported for unit testing — production callers should use spawnClaude().
 */
export function buildClaudeChildEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  extraEnv: NodeJS.ProcessEnv | undefined,
  keepApiKey: { reason: string } | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(baseEnv ?? process.env),
    ...(extraEnv ?? {}),
  };
  if (!keepApiKey) {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

/** Spawn `claude` with OAuth forced on by default. */
export function spawnClaude(
  args: string[],
  opts: PipeTupleOptions,
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnClaude(args: string[], opts?: SpawnClaudeOptions): ChildProcess;
export function spawnClaude(
  args: string[],
  opts: SpawnClaudeOptions = {},
): ChildProcess {
  const { extraEnv, keepApiKey, env, ...rest } = opts;
  const childEnv = buildClaudeChildEnv(env, extraEnv, keepApiKey);
  return spawn('claude', args, { ...rest, env: childEnv });
}

/** Synchronous variant for short checks like `claude --version`. */
export function spawnClaudeSync(
  args: string[],
  opts: SpawnClaudeSyncOptions = {},
): SpawnSyncReturns<Buffer | string> {
  const { extraEnv, keepApiKey, env, ...rest } = opts;
  const childEnv = buildClaudeChildEnv(env, extraEnv, keepApiKey);
  return spawnSync('claude', args, { ...rest, env: childEnv });
}
