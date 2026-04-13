/**
 * Production DoctorEnv — backed by node:fs, node:child_process, and global fetch.
 *
 * Tests should NOT import this; they construct their own in-memory envs that
 * implement the same interface from `./types.ts`.
 */

import { existsSync, readFileSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DoctorEnv, ExecOpts, ExecResult, FetchOpts, FetchResult, FileStat } from './types.ts';

export function realDoctorEnv(lwDir: string): DoctorEnv {
  return {
    lwDir,
    now: () => new Date(),
    env: process.env,

    exists(p: string) {
      try { return existsSync(p); } catch { return false; }
    },

    stat(p: string): FileStat | null {
      try {
        const s = lstatSync(p);
        return {
          isFile: s.isFile(),
          isDir: s.isDirectory(),
          isSymlink: s.isSymbolicLink(),
          mtime: Math.floor(s.mtimeMs / 1000),
          size: s.size,
        };
      } catch {
        return null;
      }
    },

    readlink(p: string) {
      try {
        const s = lstatSync(p);
        if (!s.isSymbolicLink()) return null;
        return readlinkSync(p);
      } catch {
        return null;
      }
    },

    readFile(p: string) {
      try { return readFileSync(p, 'utf-8'); } catch { return null; }
    },

    listDir(p: string) {
      try { return readdirSync(p); } catch { return []; }
    },

    exec(cmd: string, args: string[], opts: ExecOpts = {}): ExecResult {
      try {
        const r = spawnSync(cmd, args, {
          cwd: opts.cwd,
          timeout: opts.timeoutMs ?? 5000,
          encoding: 'utf-8',
          maxBuffer: 4 * 1024 * 1024,
        });
        if (r.error) {
          const err = r.error as NodeJS.ErrnoException;
          return {
            stdout: r.stdout ?? '',
            stderr: r.stderr ?? err.message,
            code: typeof r.status === 'number' ? r.status : 1,
            notFound: err.code === 'ENOENT',
            timedOut: r.signal === 'SIGTERM',
          };
        }
        return {
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
          code: r.status ?? 0,
          timedOut: r.signal === 'SIGTERM',
        };
      } catch (e) {
        return { stdout: '', stderr: e instanceof Error ? e.message : String(e), code: 1 };
      }
    },

    async fetch(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
      try {
        const r = await fetch(url, { headers: opts.headers, signal: controller.signal });
        const body = await r.text();
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => { headers[k] = v; });
        return { ok: r.ok, status: r.status, body, headers };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          ok: false,
          status: 0,
          body: '',
          headers: {},
          networkError: !aborted,
          timedOut: aborted,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    resolve(...parts: string[]) {
      return pathResolve(lwDir, ...parts);
    },
  };
}
