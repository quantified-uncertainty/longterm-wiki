/**
 * Linear issue state cache — QUA-580
 *
 * Bulk-fetches the workflow state of N Linear issues in a single GraphQL
 * query (via aliased fields) and caches results to disk with a 60s TTL so
 * repeated `crux sys agents status` invocations don't hit Linear every time.
 *
 * Failure modes are all fail-open: missing LINEAR_API_KEY, network error,
 * corrupt cache file — we return whatever states we have and let callers
 * render `—` for the rest. The status command is cosmetic; it should never
 * fail because Linear is unreachable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { linearGraphQL } from './client.ts';

export const CACHE_DIR = join(homedir(), '.cache', 'crux-linear');
export const CACHE_FILE = join(CACHE_DIR, 'issue-states.json');
export const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  state: string | null;
  fetchedAt: number;
}

type CacheShape = Record<string, CacheEntry>;

function readCache(now: number = Date.now()): CacheShape {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as CacheShape;
    // Drop obviously-stale entries on read to keep the file small.
    const fresh: CacheShape = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (
        v &&
        typeof v === 'object' &&
        typeof v.fetchedAt === 'number' &&
        now - v.fetchedAt < CACHE_TTL_MS * 10
      ) {
        fresh[k] = v;
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

function writeCache(cache: CacheShape): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // Best-effort: cache write failures shouldn't break the caller.
  }
}

function aliasFor(identifier: string): string {
  // GraphQL aliases must match /[_A-Za-z][_0-9A-Za-z]*/.
  return 'i_' + identifier.replace(/[^A-Za-z0-9]/g, '_');
}

interface BatchIssueResult {
  identifier: string;
  state: { name: string } | null;
}

/**
 * Fetch workflow states for many Linear issues in a single round-trip using
 * GraphQL aliases. Exported for unit tests; most callers should use
 * `getIssueStates` which adds disk caching.
 */
export async function fetchIssueStatesBatch(
  identifiers: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (identifiers.length === 0) return result;

  const parts = identifiers.map(
    (id) =>
      `${aliasFor(id)}: issue(id: "${id}") { identifier state { name } }`,
  );
  const query = `query BatchIssueStates { ${parts.join(' ')} }`;

  const data = await linearGraphQL<Record<string, BatchIssueResult | null>>(query);
  for (const id of identifiers) {
    const row = data[aliasFor(id)];
    result.set(id, row?.state?.name ?? null);
  }
  return result;
}

/**
 * Return a Map of identifier → state name for the given Linear IDs.
 *
 * Uses a 60s disk cache keyed per identifier. Missing entries (or entries
 * older than 60s) are fetched in one batched GraphQL query. Identifiers
 * with no state in Linear map to `null`.
 *
 * On any failure (no API key, network error, malformed response) the
 * returned map simply omits the affected IDs — callers should render `—`
 * when a key is missing.
 */
export async function getIssueStates(
  identifiers: string[],
  now: number = Date.now(),
): Promise<Map<string, string | null>> {
  const unique = Array.from(new Set(identifiers.filter(Boolean)));
  const result = new Map<string, string | null>();
  if (unique.length === 0) return result;

  const cache = readCache(now);
  const toFetch: string[] = [];
  for (const id of unique) {
    const entry = cache[id];
    if (entry && now - entry.fetchedAt < CACHE_TTL_MS) {
      result.set(id, entry.state);
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length === 0) return result;

  try {
    const fetched = await fetchIssueStatesBatch(toFetch);
    for (const [id, state] of fetched) {
      result.set(id, state);
      cache[id] = { state, fetchedAt: now };
    }
    writeCache(cache);
  } catch {
    // Fail open — return whatever we got from cache. Callers render `—`
    // for the identifiers we couldn't fetch.
  }

  return result;
}
