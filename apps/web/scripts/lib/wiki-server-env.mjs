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

/**
 * Should this build-data run WRITE its derived data (risk snapshots, link
 * graph, build metrics, policy stakeholders) to the wiki-server?
 *
 * Reads are unaffected — only unmerged code must not write, because the
 * wiki-server is shared production state and the last writer wins: a PR's
 * build would otherwise overwrite prod rows with that PR's view of the data.
 *
 *   BUILD_DATA_SERVER_WRITES=1|0   explicit override, always wins
 *   Vercel (VERCEL=1)              production deployments only (VERCEL_ENV=production,
 *                                  or a build of the main/production branch)
 *   GitHub Actions                 not on pull_request* / merge_group events; only
 *                                  refs/heads/main or refs/heads/production
 *                                  (push, schedule and workflow_dispatch on those
 *                                  branches keep writing exactly as before)
 *   anywhere else (dev box, slot)  only to a loopback server (a local wiki-server);
 *                                  a remote server needs BUILD_DATA_SERVER_WRITES=1
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [serverUrl] - the resolved server URL (default: getServerUrl())
 * @returns {{ write: boolean, reason: string }}
 */
export function shouldWriteToServer(env = process.env, serverUrl = getServerUrl()) {
  const override = env.BUILD_DATA_SERVER_WRITES;
  if (override === '1' || override === 'true') return { write: true, reason: 'BUILD_DATA_SERVER_WRITES=1' };
  if (override === '0' || override === 'false') return { write: false, reason: 'BUILD_DATA_SERVER_WRITES=0' };

  if (env.VERCEL === '1') {
    const ref = env.VERCEL_GIT_COMMIT_REF || '';
    if (env.VERCEL_ENV === 'production' || ref === 'main' || ref === 'production') {
      return { write: true, reason: `Vercel ${env.VERCEL_ENV || 'unknown'} build of ${ref || 'unknown ref'}` };
    }
    return { write: false, reason: `Vercel ${env.VERCEL_ENV || 'unknown'} build of ${ref || 'unknown ref'}` };
  }

  if (env.GITHUB_ACTIONS === 'true') {
    const event = env.GITHUB_EVENT_NAME || '';
    const ref = env.GITHUB_REF || '';
    if (event.startsWith('pull_request') || event === 'merge_group') {
      return { write: false, reason: `GitHub Actions ${event} event` };
    }
    if (ref === 'refs/heads/main' || ref === 'refs/heads/production') {
      return { write: true, reason: `GitHub Actions ${event} on ${ref}` };
    }
    return { write: false, reason: `GitHub Actions ${event} on ${ref || 'unknown ref'}` };
  }

  if (isLoopbackUrl(serverUrl)) {
    return { write: true, reason: 'local wiki-server' };
  }
  return {
    write: false,
    reason: 'remote wiki-server from a dev machine (set BUILD_DATA_SERVER_WRITES=1 to write)',
  };
}

function isLoopbackUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}
