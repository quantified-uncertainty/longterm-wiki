#!/usr/bin/env node
/**
 * Crux entry shim (QUA-1053).
 *
 * Resolves the right way to run crux at invocation time:
 *
 *   1. If `crux/dist/crux.js` exists, exec it directly with plain node.
 *      This is the fast path — no tsx, no compile cost, no shared cache
 *      contention.
 *
 *   2. If `dist/` is missing or stale (the user ran `pnpm crux ...`
 *      before postinstall finished, or the build failed silently), fall
 *      back to the tsx path so the command still works. We print a
 *      one-line warning so the user knows they're paying the slow-path
 *      cost.
 *
 * The shim itself is plain `.mjs`, no transitive deps, ~50ms cold start.
 *
 * Spawning `node` again (vs requiring the bundle inline) keeps process
 * exit semantics identical to the previous direct invocation: the
 * child's exit code is what `pnpm crux` returns.
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = join(HERE, 'dist', 'crux.js');
const DIST_DIR = join(HERE, 'dist');
const SOURCE_ENTRY = join(HERE, 'crux.mjs');

const args = process.argv.slice(2);

/**
 * Walk crux/ and return the newest mtime (ms) across all .ts source files,
 * skipping dist/, node_modules/, __tests__/, and test/type declaration files.
 * Returns 0 on any I/O error so callers fail-open.
 */
function newestSourceMtimeMs(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === DIST_DIR) continue;
      newest = Math.max(newest, newestSourceMtimeMs(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test-d.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // ignore unreadable files
      }
    }
  }
  return newest;
}

const distExists = existsSync(DIST_ENTRY);
let distIsStale = false;
if (distExists) {
  try {
    const distMtime = statSync(DIST_ENTRY).mtimeMs;
    const srcMtime = newestSourceMtimeMs(HERE);
    distIsStale = srcMtime > 0 && srcMtime > distMtime;
  } catch {
    // fail-open: assume fresh if we can't stat
  }
}

let nodeArgs;

if (distExists && !distIsStale) {
  nodeArgs = [DIST_ENTRY, ...args];
} else {
  // Make the slow path visible — if a coordinator is hitting it on every
  // invocation, the fix is to run `pnpm crux:build`.
  const reason = distIsStale
    ? 'dist/ is stale (source files are newer)'
    : 'dist/ missing';
  process.stderr.write(
    `[crux] ${reason} — falling back to tsx (slow). Run \`pnpm crux:build\` to fix.\n`,
  );
  nodeArgs = ['--import', 'tsx/esm', '--no-warnings', SOURCE_ENTRY, ...args];
}

const child = spawn(process.execPath, nodeArgs, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on('error', (err) => {
  process.stderr.write(`[crux] failed to spawn: ${err.message}\n`);
  process.exit(1);
});
