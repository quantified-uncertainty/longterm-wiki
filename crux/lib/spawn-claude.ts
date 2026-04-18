/**
 * Canonical `claude` CLI spawn wrapper.
 *
 * Claude CLI prefers ANTHROPIC_API_KEY over the OAuth session (Claude
 * Max/Pro subscription) when the env var is set. Agent slot `.env` files
 * ship stale API keys, so without stripping the key, subprocesses fail
 * silently with 401s or "Credit balance is too low".
 *
 * Default: delete ANTHROPIC_API_KEY so the CLI uses OAuth. Use
 * `keepApiKey: { reason }` when the caller needs to run under an API-key
 * billing identity (e.g., a prod service account with no OAuth session).
 *
 * Enforced by `validate-no-raw-claude-spawn.ts` (gate, blocking).
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
