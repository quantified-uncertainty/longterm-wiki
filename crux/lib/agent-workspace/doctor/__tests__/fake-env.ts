/**
 * Reusable in-memory DoctorEnv for tests.
 *
 * Files: { path → { content, mtime, isSymlink, symlinkTarget } }
 * Dirs:  { path → string[] of immediate children }
 * Exec:  { "<cmd> <args>" → ExecResult } (matched by exact joined args)
 * Fetch: { url → FetchResult }
 *
 * Anything not registered returns a sensible default (file missing, dir
 * empty, exec exit 0 with empty stdout, fetch network error). Tests should
 * register only the entries that matter for each scenario.
 */

import type { DoctorEnv, ExecResult, FetchResult, FileStat } from '../types.ts';

export interface FakeFile {
  content?: string;
  mtime?: number;
  isSymlink?: boolean;
  symlinkTarget?: string;
  isDir?: boolean;
  size?: number;
}

export class FakeDoctorEnv implements DoctorEnv {
  lwDir = '/lw';
  env: NodeJS.ProcessEnv = {};
  files = new Map<string, FakeFile>();
  /** Map of dir path → list of immediate child names. */
  dirs = new Map<string, string[]>();
  /** Map of `cmd argA argB` → reply factory. */
  execs = new Map<string, (cmd: string, args: string[]) => ExecResult>();
  fetches = new Map<string, FetchResult>();
  private current: Date;

  constructor(opts: { now?: Date | number; lwDir?: string; env?: NodeJS.ProcessEnv } = {}) {
    if (opts.lwDir) this.lwDir = opts.lwDir;
    if (opts.env) this.env = opts.env;
    if (opts.now instanceof Date) this.current = opts.now;
    else if (typeof opts.now === 'number') this.current = new Date(opts.now * 1000);
    else this.current = new Date('2026-04-12T14:32:08Z');
  }

  // ---- mutation helpers used by tests ----
  setFile(path: string, file: FakeFile) {
    this.files.set(path, { mtime: Math.floor(this.current.getTime() / 1000), size: 0, ...file });
    return this;
  }
  setDir(path: string, children: string[]) {
    this.files.set(path, { isDir: true, mtime: Math.floor(this.current.getTime() / 1000), size: 0 });
    this.dirs.set(path, children);
    return this;
  }
  setExec(key: string, reply: ExecResult | ((cmd: string, args: string[]) => ExecResult)) {
    this.execs.set(key, typeof reply === 'function' ? reply : () => reply);
    return this;
  }
  setFetch(url: string, reply: FetchResult) {
    this.fetches.set(url, reply);
    return this;
  }
  setNow(d: Date) { this.current = d; return this; }

  // ---- DoctorEnv impl ----
  now() { return this.current; }
  exists(p: string) { return this.files.has(p); }
  stat(p: string): FileStat | null {
    const f = this.files.get(p);
    if (!f) return null;
    return {
      isFile: !f.isDir && !f.isSymlink,
      isDir: !!f.isDir,
      isSymlink: !!f.isSymlink,
      mtime: f.mtime ?? 0,
      size: f.size ?? 0,
    };
  }
  readlink(p: string) {
    const f = this.files.get(p);
    if (!f || !f.isSymlink) return null;
    return f.symlinkTarget ?? '';
  }
  readFile(p: string) { return this.files.get(p)?.content ?? null; }
  listDir(p: string) { return this.dirs.get(p) ?? []; }
  exec(cmd: string, args: string[]): ExecResult {
    const key = [cmd, ...args].join(' ');
    const handler = this.execs.get(key);
    if (handler) return handler(cmd, args);
    // Try a prefix match (helpful when args list is long)
    for (const [k, h] of this.execs.entries()) {
      if (key === k) return h(cmd, args);
    }
    return { stdout: '', stderr: '', code: 0 };
  }
  async fetch(url: string): Promise<FetchResult> {
    return this.fetches.get(url) ?? { ok: false, status: 0, body: '', headers: {}, networkError: true };
  }
  resolve(...parts: string[]) {
    return [this.lwDir, ...parts].join('/');
  }
}

export const ok = (stdout = '', stderr = ''): ExecResult => ({ stdout, stderr, code: 0 });
export const fail = (stderr = '', code = 1): ExecResult => ({ stdout: '', stderr, code });
export const notFound = (): ExecResult => ({ stdout: '', stderr: '', code: 1, notFound: true });
