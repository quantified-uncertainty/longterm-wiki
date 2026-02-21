/**
 * risk-client.mjs — HTTP client for the wiki server (hallucination risk snapshots)
 *
 * Used by build-data.mjs to record risk score snapshots after computing
 * hallucination risk. Gracefully skips if server is unavailable.
 *
 * Configuration via environment variables:
 *   LONGTERMWIKI_SERVER_URL     — Base URL (e.g. "https://wiki-server.k8s.quantifieduncertainty.org")
 *   LONGTERMWIKI_SERVER_API_KEY — Bearer token for authentication
 */

const TIMEOUT_MS = 30_000; // larger timeout for batch inserts
const BATCH_SIZE = 100; // split large batches to avoid overwhelming the server

function getServerUrl() {
  return process.env.LONGTERMWIKI_SERVER_URL || "";
}

function getApiKey() {
  return process.env.LONGTERMWIKI_SERVER_API_KEY || "";
}

function getHeaders() {
  const headers = { "Content-Type": "application/json" };
  const apiKey = getApiKey();
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Record hallucination risk snapshots for multiple pages.
 *
 * @param {Array<{ pageId: string, score: number, level: string, factors: string[], integrityIssues?: string[] }>} snapshots
 * @returns {Promise<{ inserted: number } | null>} — null on failure
 */
export async function recordRiskSnapshots(snapshots) {
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;

  let totalInserted = 0;

  // Split into batches
  for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
    const batch = snapshots.slice(i, i + BATCH_SIZE);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(`${serverUrl}/api/hallucination-risk/batch`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ snapshots: batch }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(
          `  WARNING: Risk snapshot batch failed (${res.status}): ${text.slice(0, 200)}`
        );
        return null;
      }

      const data = await res.json();
      totalInserted += data.inserted;
    } catch (err) {
      console.warn(
        `  WARNING: Risk snapshot batch failed: ${err.message || err}`
      );
      return null;
    }
  }

  return { inserted: totalInserted };
}
