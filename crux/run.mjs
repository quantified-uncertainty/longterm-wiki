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

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = join(HERE, 'dist', 'crux.js');
const SOURCE_ENTRY = join(HERE, 'crux.mjs');

const args = process.argv.slice(2);
let nodeArgs;

if (existsSync(DIST_ENTRY)) {
  nodeArgs = [DIST_ENTRY, ...args];
} else {
  // Make the slow path visible — if a coordinator is hitting it on every
  // invocation, the fix is to run `pnpm crux:build`.
  process.stderr.write(
    '[crux] dist/ missing — falling back to tsx (slow). Run `pnpm crux:build` to fix.\n',
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
