/**
 * Client for the wiki Postgres server API.
 *
 * Provides typed methods for ID allocation and edit-log writes.
 * All methods are async and fail gracefully — callers can fall back
 * to the local file-based approach when the server isn't running.
 *
 * Usage:
 *   import { wikiServer } from '../lib/wiki-server-client.ts';
 *
 *   // Allocate an ID (returns null if server unavailable)
 *   const result = await wikiServer.allocateId('new-entity', 'concept', 'New Entity');
 *   if (result) console.log(result.numericId); // "E709"
 *
 *   // Append an edit log (fire-and-forget, logs warning on failure)
 *   await wikiServer.appendEditLog('page-id', { tool: 'crux-improve', agency: 'ai-directed' });
 */

const WIKI_SERVER_URL =
  process.env.WIKI_SERVER_URL ?? "http://localhost:3002";

// ---------------------------------------------------------------------------
// Health check (cached for the process lifetime)
// ---------------------------------------------------------------------------

let _serverAvailable: boolean | null = null;

/**
 * Check whether the wiki server is reachable.
 * Result is cached for the lifetime of the process.
 * Set `WIKI_SERVER_URL=off` to unconditionally disable.
 */
export async function isServerAvailable(): Promise<boolean> {
  if (WIKI_SERVER_URL === "off") return false;
  if (_serverAvailable !== null) return _serverAvailable;

  try {
    const res = await fetch(`${WIKI_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    _serverAvailable = res.ok;
  } catch {
    _serverAvailable = false;
  }
  return _serverAvailable;
}

/** Reset the cached availability flag (useful for tests). */
export function resetServerCache(): void {
  _serverAvailable = null;
}

// ---------------------------------------------------------------------------
// ID allocation
// ---------------------------------------------------------------------------

export interface AllocateIdResult {
  numericId: string; // "E709"
  slug: string;
  alreadyExisted: boolean;
}

/**
 * Atomically allocate the next E ID for a slug via the server.
 * Returns `null` if the server is unavailable (caller should fall back).
 */
export async function allocateId(
  slug: string,
  entityType?: string,
  title?: string,
): Promise<AllocateIdResult | null> {
  if (!(await isServerAvailable())) return null;

  try {
    const res = await fetch(`${WIKI_SERVER_URL}/api/ids/next`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, entityType, title }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.warn(
        `  wiki-server: POST /api/ids/next returned ${res.status}`,
      );
      return null;
    }
    return (await res.json()) as AllocateIdResult;
  } catch (err) {
    console.warn(`  wiki-server: ID allocation failed:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Edit log
// ---------------------------------------------------------------------------

export interface EditLogPayload {
  pageId: string;
  date?: string;
  tool: string;
  agency: string;
  requestedBy?: string;
  note?: string;
}

/**
 * Append an edit-log entry to the Postgres server.
 * Fire-and-forget: logs a warning but never throws.
 */
export async function appendEditLogRemote(
  payload: EditLogPayload,
): Promise<boolean> {
  if (!(await isServerAvailable())) return false;

  try {
    const res = await fetch(`${WIKI_SERVER_URL}/api/edit-logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.warn(
        `  wiki-server: POST /api/edit-logs returned ${res.status}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`  wiki-server: edit-log write failed:`, err);
    return false;
  }
}

/**
 * Convenience namespace-style export for ergonomic imports.
 */
export const wikiServer = {
  isAvailable: isServerAvailable,
  resetCache: resetServerCache,
  allocateId,
  appendEditLog: appendEditLogRemote,
};
