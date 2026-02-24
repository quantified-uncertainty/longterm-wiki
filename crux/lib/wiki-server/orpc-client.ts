/**
 * oRPC Client — Type-safe facts API client
 *
 * Uses oRPC's typed client to call the facts RPC endpoints.
 * Provides the same API surface as the existing REST client in facts.ts
 * but with end-to-end type safety derived from the server router.
 *
 * Usage:
 *   import { createFactsClient, orpcCall } from './orpc-client.ts';
 *   const client = createFactsClient();
 *   const result = await orpcCall(() => client!.stats({}));
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { FactsRouter } from "../../../apps/wiki-server/src/orpc/facts-router.ts";
import { getServerUrl, getApiKey } from "./client.ts";
import type { ApiResult } from "./client.ts";

// ---------------------------------------------------------------------------
// Type exports — inferred from the router, not hand-written
// ---------------------------------------------------------------------------

/** Fully typed oRPC client for the facts module. */
export type FactsClient = RouterClient<FactsRouter>;

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a typed oRPC client for the facts module.
 * Returns null if the server URL is not configured.
 */
export function createFactsClient(): FactsClient | null {
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;

  const link = new RPCLink({
    url: `${serverUrl}/rpc/facts`,
    headers: () => {
      const apiKey = getApiKey("content");
      return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    },
  });

  return createORPCClient(link) as FactsClient;
}

// ---------------------------------------------------------------------------
// Convenience wrapper with ApiResult-compatible error handling
// ---------------------------------------------------------------------------

/**
 * Wrap an oRPC call in the ApiResult pattern used by the rest of the client.
 * This allows gradual migration — callers can use the same error handling.
 */
export async function orpcCall<T>(
  fn: () => Promise<T>
): Promise<ApiResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
      return { ok: false, error: "unavailable", message };
    }
    if (message.includes("timeout") || message.includes("AbortError")) {
      return { ok: false, error: "timeout", message };
    }
    return { ok: false, error: "server_error", message };
  }
}
