/**
 * id-client.mjs — HTTP client for the wiki server (ID allocation)
 *
 * Used by assign-ids.mjs to allocate numeric IDs atomically when the
 * server is available. Falls back gracefully (returns null) on any failure.
 *
 * Configuration via environment variables:
 *   WIKI_SERVER_URL     — Base URL (e.g. "https://wiki-server.k8s.quantifieduncertainty.org")
 *   WIKI_SERVER_API_KEY — Bearer token for authentication
 */

const TIMEOUT_MS = 5000;

function getServerUrl() {
  return process.env.WIKI_SERVER_URL || "";
}

function getApiKey() {
  return process.env.WIKI_SERVER_API_KEY || "";
}

/**
 * Check if the ID server is reachable and healthy.
 * @returns {Promise<boolean>}
 */
export async function isServerAvailable() {
  const serverUrl = getServerUrl();
  if (!serverUrl) return false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${serverUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const headers = { "Content-Type": "application/json" };
    const apiKey = getApiKey();
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const body = { slug };
    if (description) body.description = description;

    const res = await fetch(`${serverUrl}/api/ids/allocate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const headers = { "Content-Type": "application/json" };
    const apiKey = getApiKey();
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${serverUrl}/api/ids/allocate-batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ items }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json();
    return data.results;
  } catch {
    return null;
  }
}
