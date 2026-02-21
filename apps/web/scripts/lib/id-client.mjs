/**
 * id-client.mjs — HTTP client for the wiki server (ID allocation)
 *
 * Used by assign-ids.mjs to allocate numeric IDs atomically when the
 * server is available. Falls back gracefully (returns null) on any failure.
 *
 * NOTE: This file runs under plain `node` (no tsx), so it cannot import
 * from .ts files. The helpers below mirror crux/lib/wiki-server-client.ts.
 * If you change the shared client, update these too.
 */

const TIMEOUT_MS = 5000;
const BATCH_TIMEOUT_MS = 30000;

function getServerUrl() {
  return process.env.LONGTERMWIKI_SERVER_URL || "";
}

function getApiKey() {
  return process.env.LONGTERMWIKI_SERVER_API_KEY || "";
}

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  const apiKey = getApiKey();
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Check if the ID server is reachable and healthy.
 * @returns {Promise<boolean>}
 */
export async function isServerAvailable() {
  const serverUrl = getServerUrl();
  if (!serverUrl) return false;

  try {
    const res = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return false;

    const body = await res.json();
    return body.status === "healthy";
  } catch {
    return false;
  }
}

/**
 * Allocate a single numeric ID for a slug.
 *
 * @param {string} slug — Entity or page slug
 * @param {string} [description] — Optional description
 * @returns {Promise<{ numericId: string, created: boolean } | null>}
 *   Returns null on any failure (network, timeout, non-2xx).
 */
export async function allocateId(slug, description) {
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;

  try {
    const body = { slug };
    if (description) body.description = description;

    const res = await fetch(`${serverUrl}/api/ids/allocate`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const data = await res.json();
    return {
      numericId: data.numericId,
      created: data.created,
    };
  } catch {
    return null;
  }
}

/**
 * Allocate numeric IDs for multiple slugs in a single request.
 *
 * @param {Array<{ slug: string, description?: string }>} items
 * @returns {Promise<Array<{ numericId: string, slug: string, created: boolean }> | null>}
 *   Returns null on any failure.
 */
export async function allocateBatch(items) {
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;

  try {
    const res = await fetch(`${serverUrl}/api/ids/allocate-batch`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const data = await res.json();
    return data.results;
  } catch {
    return null;
  }
}

// Max items per batch request (must match server-side limit in
// apps/wiki-server/src/routes/ids.ts AllocateBatchSchema .max(50))
const BATCH_CHUNK_SIZE = 50;

/**
 * Allocate IDs for a list of slugs, automatically chunking into
 * BATCH_CHUNK_SIZE groups to respect server limits.
 *
 * @param {string[]} slugs — Slugs to allocate IDs for
 * @returns {Promise<Map<string, string>>} Map of slug → numericId
 * @throws {Error} If any batch request fails
 */
export async function allocateIds(slugs) {
  const resultMap = new Map();

  for (let i = 0; i < slugs.length; i += BATCH_CHUNK_SIZE) {
    const batch = slugs.slice(i, i + BATCH_CHUNK_SIZE);
    const items = batch.map(slug => ({ slug }));
    const results = await allocateBatch(items);
    if (!results) {
      throw new Error(`Batch allocation failed for slugs: ${batch.join(', ')}`);
    }
    for (const r of results) {
      resultMap.set(r.slug, r.numericId);
    }
  }

  // Post-condition: every requested slug must have a result
  const missing = slugs.filter(s => !resultMap.has(s));
  if (missing.length > 0) {
    throw new Error(`Batch allocation missing results for slugs: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (and ${missing.length - 5} more)` : ''}`);
  }

  return resultMap;
}
