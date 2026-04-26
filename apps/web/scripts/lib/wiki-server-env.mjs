/**
 * wiki-server-env.mjs — env-prefix resolution for wiki-server URL/API key.
 *
 * Mirrors the logic in `crux/lib/wiki-server/client.ts::getEnvPrefix()`
 * (QUA-616). Plain ESM so it can be imported by `node`-run scripts that
 * cannot use tsx (e.g. assign-ids.mjs, build-data.mjs).
 *
 * Resolution order:
 *   1. `WIKI_SERVER_ENV=prod`/`production`  → `PROD_` prefix
 *   2. `WIKI_SERVER_ENV=local`/`dev`        → no prefix (force local)
 *   3. CWD inside an `a<N>` slot directory  → `PROD_` prefix
 *      (slot agents have no local wiki-server)
 *   4. Otherwise                            → no prefix (default local)
 *
 * If you change this, update `crux/lib/wiki-server/client.ts` too.
 */

import { basename, dirname } from 'path';

/**
 * Walk up from `cwd` looking for a directory named `a<N>` (the agent-slot
 * root). Returns the slot number when found, or null. Mirror of
 * `crux/lib/session/session-context.ts::findSlotFromAncestors`.
 */
export function findSlotFromAncestors(cwd) {
  let current = cwd;
  for (let i = 0; i < 10; i++) {
    const match = basename(current).match(/^a(\d+)$/);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isSafeInteger(n)) return n;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function getEnvPrefix() {
  const env = process.env.WIKI_SERVER_ENV;
  if (env === 'prod' || env === 'production') return 'PROD_';
  if (env === 'local' || env === 'dev') return '';
  if (env === undefined && findSlotFromAncestors(process.cwd()) !== null) {
    return 'PROD_';
  }
  return '';
}

/**
 * Read a `LONGTERMWIKI_*` env var, honoring the active prefix.
 * Returns '' if unset.
 */
export function getEnv(name) {
  const prefix = getEnvPrefix();
  return process.env[`${prefix}${name}`] || '';
}

export function getServerUrl() {
  return getEnv('LONGTERMWIKI_SERVER_URL');
}

export function getApiKey() {
  return getEnv('LONGTERMWIKI_SERVER_API_KEY');
}
