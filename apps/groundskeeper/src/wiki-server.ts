/**
 * Lightweight wiki-server API client for the groundskeeper.
 *
 * Posts run records and agent registration to the wiki-server.
 * All calls are best-effort — failures are logged but never block task execution.
 */

import type { Config } from "./config.js";

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function apiRequest<T>(
  config: Config,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const url = `${config.wikiServerUrl}${path}`;
  const apiKey = process.env["WIKI_SERVER_API_KEY"];

  if (!apiKey) {
    return { ok: false, error: "WIKI_SERVER_API_KEY not set" };
  }

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
    }

    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Groundskeeper Run Recording
// ---------------------------------------------------------------------------

export interface RecordRunPayload {
  taskName: string;
  event: string;
  success: boolean;
  durationMs?: number;
  summary?: string;
  errorMessage?: string;
  consecutiveFailures?: number;
  circuitBreakerActive?: boolean;
  timestamp?: string;
}

/**
 * Record a task run to the wiki-server. Best-effort — logs error on failure.
 */
export async function recordRunToServer(
  config: Config,
  payload: RecordRunPayload,
): Promise<void> {
  const result = await apiRequest(
    config,
    "POST",
    "/api/groundskeeper-runs",
    payload,
  );
  if (!result.ok) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "wiki_server_sync_failed",
        endpoint: "/api/groundskeeper-runs",
        error: result.error,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Active Agent Registration
// ---------------------------------------------------------------------------

interface ActiveAgentResponse {
  id: number;
  sessionId: string;
}

/**
 * Register the groundskeeper as an active agent. Best-effort.
 * Returns the agent ID if successful, null otherwise.
 */
export async function registerAsActiveAgent(
  config: Config,
): Promise<number | null> {
  const result = await apiRequest<ActiveAgentResponse>(
    config,
    "POST",
    "/api/active-agents",
    {
      sessionId: "groundskeeper",
      task: "Scheduled maintenance daemon (health checks, conflict resolution, code review)",
      model: "groundskeeper-daemon",
    },
  );

  if (result.ok && result.data) {
    return result.data.id;
  }

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "active_agent_registration_failed",
      error: result.error,
    }),
  );
  return null;
}

/**
 * Update the groundskeeper's active agent status. Best-effort.
 */
export async function updateActiveAgent(
  config: Config,
  agentId: number,
  updates: { currentStep?: string; status?: string },
): Promise<void> {
  const result = await apiRequest(
    config,
    "PATCH",
    `/api/active-agents/${agentId}`,
    updates,
  );
  if (!result.ok) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "active_agent_update_failed",
        error: result.error,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Incident Recording
// ---------------------------------------------------------------------------

/**
 * Record an incident to the wiki-server monitoring system. Best-effort.
 * If wiki-server is the thing that's down, this call will also fail — that's
 * expected. The groundskeeper health-check task also creates GitHub issues
 * as a fallback notification channel.
 */
export async function recordIncident(
  config: Config,
  payload: {
    service: string;
    severity: string;
    title: string;
    detail?: string;
    checkSource?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const result = await apiRequest(
    config,
    "POST",
    "/api/monitoring/incidents",
    payload,
  );
  if (!result.ok) {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "incident_recording_failed",
        endpoint: "/api/monitoring/incidents",
        error: result.error,
      }),
    );
  }
}

/**
 * Send a heartbeat for the groundskeeper. Best-effort.
 */
export async function sendHeartbeat(
  config: Config,
  agentId: number,
): Promise<void> {
  const result = await apiRequest(
    config,
    "POST",
    `/api/active-agents/${agentId}/heartbeat`,
    {},
  );
  if (!result.ok) {
    // Don't log every heartbeat failure — too noisy
  }
}
