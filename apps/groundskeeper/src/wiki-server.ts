/**
 * Lightweight wiki-server API client for the groundskeeper.
 *
 * Posts run records and agent registration to the wiki-server.
 * All calls are best-effort — failures are logged but never block task execution.
 */

import type { Config } from "./config.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ module: "wiki-server" });

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
 * Record a task run to the wiki-server. Best-effort — logs warning on failure.
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
    logger.warn(
      {
        event: "wiki_server_sync_failed",
        endpoint: "/api/groundskeeper-runs",
        error: result.error,
      },
      "Failed to record run to wiki-server",
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

/** Maximum number of retries for agent registration. */
const REGISTER_MAX_RETRIES = 5;

/** Base delay in ms for exponential backoff (doubles each retry: 2s, 4s, 8s, 16s, 32s). */
const REGISTER_BASE_DELAY_MS = 2_000;

/**
 * Register the groundskeeper as an active agent with retry.
 *
 * Uses exponential backoff so that if wiki-server is down at groundskeeper
 * startup, registration is retried rather than silently failing. Without
 * retry, the groundskeeper would remain invisible for its entire lifecycle.
 *
 * Returns the agent ID if successful, null if all retries are exhausted.
 */
export async function registerAsActiveAgent(
  config: Config,
): Promise<number | null> {
  for (let attempt = 0; attempt <= REGISTER_MAX_RETRIES; attempt++) {
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

    logger.warn(
      {
        event: "active_agent_registration_failed",
        attempt: attempt + 1,
        maxRetries: REGISTER_MAX_RETRIES,
        error: result.error,
      },
      `Registration attempt ${attempt + 1}/${REGISTER_MAX_RETRIES + 1} failed`,
    );

    // Don't delay after the last attempt
    if (attempt < REGISTER_MAX_RETRIES) {
      const delay = REGISTER_BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  logger.warn(
    {
      event: "active_agent_registration_exhausted",
      maxRetries: REGISTER_MAX_RETRIES + 1,
    },
    `Failed to register after ${REGISTER_MAX_RETRIES + 1} attempts. Groundskeeper will run without active-agent tracking.`,
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
    logger.warn(
      {
        event: "active_agent_update_failed",
        agentId,
        error: result.error,
      },
      "Failed to update active agent status",
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
 *
 * Returns true if the incident was recorded successfully, false otherwise.
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
): Promise<boolean> {
  const result = await apiRequest(
    config,
    "POST",
    "/api/monitoring/incidents",
    payload,
  );
  if (!result.ok) {
    logger.warn(
      {
        event: "incident_recording_failed",
        endpoint: "/api/monitoring/incidents",
        error: result.error,
      },
      "Failed to record incident to wiki-server",
    );
    return false;
  }
  return true;
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
    // Heartbeat failures are intentionally quiet — they're high-frequency
    // and connectivity issues are tracked at a higher level by the
    // wiki-server failure counter in scheduler.ts.
  }
}
