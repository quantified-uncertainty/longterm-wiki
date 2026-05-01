/**
 * Shared file walker for line-oriented validators.
 *
 * Used by:
 * - validate-dangerous-patterns.ts
 * - validate-typed-client.ts (QUA-770)
 *
 * Both validators were independently walking the filesystem with near-
 * identical logic (recurse, skip `__tests__`/`node_modules`/`dist`, accept
 * `.ts` files). This module consolidates that pattern.
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/** Directories to always skip during recursion. */
const ALWAYS_SKIP_DIRS = new Set(['__tests__', 'node_modules', 'dist']);

/** Test-file suffixes to always skip. */
const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];

/**
 * Recursively collect TypeScript source files under `dir`.
 *
 * - Skips `__tests__/`, `node_modules/`, `dist/` directories
 * - Skips `*.test.ts` and `*.test.tsx` files
 * - Always includes `.ts` files
 * - Includes `.tsx` files when `includeTsx` is true
 * - Includes `.mjs` and `.js` files when `includeMjs` is true (excludes `.test.mjs`)
 */
export function collectTsFiles(
  dir: string,
  options?: { includeTsx?: boolean; includeMjs?: boolean },
): string[] {
  const includeTsx = options?.includeTsx ?? false;
  const includeMjs = options?.includeMjs ?? false;
  const results: string[] = [];

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry)) continue;
        walk(fullPath);
        continue;
      }

      if (TEST_SUFFIXES.some((s) => entry.endsWith(s))) continue;
      if (includeMjs && (entry.endsWith('.test.mjs') || entry.endsWith('.test.js'))) continue;

      if (entry.endsWith('.ts')) {
        results.push(fullPath);
      } else if (includeTsx && entry.endsWith('.tsx')) {
        results.push(fullPath);
      } else if (includeMjs && (entry.endsWith('.mjs') || entry.endsWith('.js'))) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}
