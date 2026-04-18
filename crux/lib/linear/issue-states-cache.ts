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

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { linearGraphQL } from './client.ts';

/**
 * Linear issue identifiers follow the `TEAM-NNN` shape (uppercase team key,
 * hyphen, digits). We interpolate the ID directly into the batched GraphQL
 * query string (there's no variable form for aliased fields), so validate
 * the shape before trusting it. Belt-and-braces: parseLinearId already
 * constrains the shape, but a broken caller shouldn't be able to inject.
 */
const LINEAR_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export const CACHE_DIR = join(homedir(), '.cache', 'crux-linear');
export const CACHE_FILE = join(CACHE_DIR, 'issue-states.json');
export const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  state: string | null;
  fetchedAt: number;
}

type CacheShape = Record<string, CacheEntry>;

function readCache(now: number = Date.now()): CacheShape {
  let parsed: CacheShape;
  try {
    parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as CacheShape;
  } catch {
    return {};
  }
  const fresh: CacheShape = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (
      v &&
      typeof v === 'object' &&
      typeof v.fetchedAt === 'number' &&
      (typeof v.state === 'string' || v.state === null) &&
      now - v.fetchedAt < CACHE_TTL_MS
    ) {
      fresh[k] = v;
    }
  }
  return fresh;
}

function writeCache(cache: CacheShape): void {
  // Write-then-rename: on POSIX, rename is atomic, so a concurrent reader
  // never sees a half-written file and concurrent writers don't corrupt
  // each other. Two `crux sys agents status` processes racing is common.
  const tmp = `${CACHE_FILE}.${process.pid}.${Date.now()}`;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
    renameSync(tmp, CACHE_FILE);
  } catch {
    try { unlinkSync(tmp); } catch { /* no temp file to clean up */ }
  }
}

interface BatchIssueResult {
  identifier: string;
  state: { name: string } | null;
}

/**
 * Fetch workflow states for many Linear issues in a single round-trip.
 *
 * Each issue gets a positional alias (`i0`, `i1`, ...) that depends only on
 * the caller-provided order, so two distinct identifiers can never collide
 * onto the same alias. Results are mapped back by the `identifier` field
 * Linear returns in each response row, not by the alias, so the mapping
 * remains correct even if Linear reorders the response. Exported for unit
 * tests; most callers should use `getIssueStates` which adds disk caching.
 */
export async function fetchIssueStatesBatch(
  identifiers: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (identifiers.length === 0) return result;

  for (const id of identifiers) {
    if (!LINEAR_ID_RE.test(id)) {
      throw new Error(`Refusing to fetch malformed Linear ID: ${JSON.stringify(id)}`);
    }
  }

  const parts = identifiers.map(
    (id, idx) => `i${idx}: issue(id: "${id}") { identifier state { name } }`,
  );
  const query = `query BatchIssueStates { ${parts.join(' ')} }`;

  const data = await linearGraphQL<Record<string, BatchIssueResult | null>>(query);
  // Seed every requested identifier with `null` so callers can distinguish
  // "Linear didn't return this" from "we never asked"; then overwrite with
  // actual state names from whichever rows Linear did return.
  for (const id of identifiers) result.set(id, null);
  for (const row of Object.values(data)) {
    if (row?.identifier && result.has(row.identifier)) {
      result.set(row.identifier, row.state?.name ?? null);
    }
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

  // Skip the network call when there's no API key — linearGraphQL would
  // throw, but we'd still pay for a wasted fetch setup + 15s timeout.
  if (!process.env.LINEAR_API_KEY) return result;

  try {
    const fetched = await fetchIssueStatesBatch(toFetch);
    for (const [id, state] of fetched) {
      result.set(id, state);
      cache[id] = { state, fetchedAt: now };
    }
    writeCache(cache);
  } catch (e) {
    // Fail open — callers render `—` for identifiers we couldn't fetch.
    // Log at debug level so `LINEAR_DEBUG=1` or equivalent surfaces the
    // reason (unreachable API, bad key, edge-cache HTML) without flooding
    // normal status output.
    if (process.env.LINEAR_DEBUG) {
      // eslint-disable-next-line no-console
      console.warn(`[linear] issue-states fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
