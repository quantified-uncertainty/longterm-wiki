/**
 * Wiki Server Client — backward-compatibility shim
 *
 * This file re-exports everything from the new modular `wiki-server/` directory.
 * Existing imports like `from './wiki-server-client.ts'` continue to work unchanged.
 *
 * For new code, import from the specific sub-module instead:
 *   import { appendEditLogToServer, type ApiResult } from './wiki-server/edit-logs.ts';
 *
 * @see ./wiki-server/client.ts   — Core fetch, ApiResult type, config
 * @see ./wiki-server/index.ts    — Barrel with backward-compatible (T | null) wrappers
 */

export * from './wiki-server/index.ts';
