/**
 * Per-slot tsx cache isolation.
 *
 * Every `pnpm crux ...` invocation runs through `node --import tsx/esm` which
 * compiles TypeScript modules on demand using a worker thread. The compiled
 * output is cached in `$TMPDIR/tsx-<uid>/`. When 20+ agent slots share that
 * cache, macOS filesystem locking degrades catastrophically — the main thread
 * blocks in `Atomics.wait()` waiting for the worker to finish compiling and
 * writing cache files. We have observed crux commands hung 25+ minutes under
 * heavy concurrent load while a direct `curl` to the same backend completed
 * in under a second.
 *
 * Setting a slot-specific TMPDIR before launching `claude` (interactive or
 * dispatched) gives each slot its own tsx cache. Each slot pays a one-time
 * compile cost (~1-2s) on first invocation, but cross-slot contention
 * disappears entirely. A/B test: shared cache hung 7+ min, isolated TMPDIR
 * completed in 2.25s under the same concurrent load.
 *
 * The directory is rooted at `os.tmpdir()` which on macOS is already per-user
 * (`/private/var/folders/<hash>/T/`), so no uid suffix is needed.
 */

import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Path to the per-slot TMPDIR. Each slot's tsx cache lives at
 * `<this>/tsx-<uid>/`, written by tsx itself.
 */
export function getSlotTmpDir(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1) {
    throw new Error(`getSlotTmpDir: slot must be a positive integer, got ${slot}`);
  }
  return join(tmpdir(), `tsx-slot-a${slot}`);
}

/** Idempotently create the slot's TMPDIR if missing. Returns the path. */
export function ensureSlotTmpDir(slot: number): string {
  const dir = getSlotTmpDir(slot);
  mkdirSync(dir, { recursive: true });
  return dir;
}
