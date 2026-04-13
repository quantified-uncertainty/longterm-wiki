/**
 * Doctor check framework — types shared by slots-doctor and releases-doctor.
 *
 * Each check is a pure function over a DoctorEnv. The runner executes them,
 * collects results, and renders pretty or JSON output. Tests inject a fake
 * DoctorEnv to exercise checks without hitting the real filesystem, network,
 * or shell.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info' | 'skipped';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  /** One-line summary printed inline next to the status icon. */
  summary: string;
  /** Optional multi-line context shown only when status is non-ok. */
  detail?: string;
  /** Suggested remediation, shown in the "What to do" footer block. */
  action?: string;
  /** Time the check spent running, in milliseconds (set by runner). */
  durationMs?: number;
}

export interface DoctorCheck {
  id: string;
  label: string;
  run(env: DoctorEnv): Promise<Omit<CheckResult, 'id' | 'label' | 'durationMs'>>;
}

// ---------------------------------------------------------------------------
// DoctorEnv — the entire surface a check is allowed to touch.
// ---------------------------------------------------------------------------

export interface ExecOpts {
  cwd?: string;
  /** Hard timeout in ms. Default 5000. */
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True if the binary was not found on PATH. */
  notFound?: boolean;
  /** True if execution was cut off by the timeout. */
  timedOut?: boolean;
}

export interface FileStat {
  isFile: boolean;
  isDir: boolean;
  isSymlink: boolean;
  /** Mtime in unix-epoch seconds. */
  mtime: number;
  size: number;
}

export interface FetchOpts {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
  /** True if the request failed before any HTTP response was received. */
  networkError?: boolean;
  /** True if cut off by timeout. */
  timedOut?: boolean;
}

/**
 * The DoctorEnv abstracts every external dependency a check can use.
 *
 * Implementations:
 *   - `realDoctorEnv()` — backed by node:fs, node:child_process, undici/fetch
 *   - test fakes — pure in-memory maps + scripted exec replies
 */
export interface DoctorEnv {
  /** Workspace root, e.g. `/Users/ozzie/.../lw`. */
  lwDir: string;
  now(): Date;
  env: NodeJS.ProcessEnv;

  // ---- filesystem ----
  exists(path: string): boolean;
  stat(path: string): FileStat | null;
  /** Reads target of symlink, or null if not a symlink. */
  readlink(path: string): string | null;
  readFile(path: string): string | null;
  /** Returns immediate children (filenames, not full paths), or [] if not a directory. */
  listDir(path: string): string[];

  // ---- shell ----
  exec(cmd: string, args: string[], opts?: ExecOpts): ExecResult;

  // ---- network ----
  fetch(url: string, opts?: FetchOpts): Promise<FetchResult>;

  // ---- meta ----
  /** Returns a path resolved against lwDir. */
  resolve(...parts: string[]): string;
}
