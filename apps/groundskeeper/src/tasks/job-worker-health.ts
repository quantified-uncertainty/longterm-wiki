import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ task: "job-worker-health" });

/** Heartbeat age thresholds. */
const HEARTBEAT_WARN_MS = 5 * 60 * 1000;
const HEARTBEAT_CRITICAL_MS = 15 * 60 * 1000;

/** Maximum pending jobs per type before warning. */
const BACKLOG_THRESHOLD = 20;

/** Failure rate above which a warning is emitted. */
const FAILURE_RATE_THRESHOLD = 0.3;

/** Minimum completed+failed jobs to compute a meaningful failure rate. */
const FAILURE_RATE_MIN_SAMPLE = 10;

/** Fetch timeout for wiki-server API calls. */
const FETCH_TIMEOUT_MS = 10_000;

interface ActiveAgent {
  sessionId: string;
  status: string;
  heartbeatAt: string | null;
}

interface ActiveAgentsResponse {
  agents: ActiveAgent[];
}

interface JobStatsResponse {
  totalJobs: number;
  byType: Record<
    string,
    {
      byStatus: Record<string, number>;
      avgDurationMs?: number;
      failureRate?: number;
    }
  >;
}

/**
 * Build request headers for wiki-server API calls.
 * Respects WIKI_SERVER_ENV=prod for env var prefix switching.
 */
function buildHeaders(): Record<string, string> {
  const prefix = process.env["WIKI_SERVER_ENV"] === "prod" ? "PROD_" : "";
  const apiKey = process.env[`${prefix}LONGTERMWIKI_SERVER_API_KEY`];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Monitor the K8s job worker's health by checking:
 * 1. Worker heartbeat staleness
 * 2. Job backlog size
 * 3. Per-type failure rate
 */
export async function jobWorkerHealth(
  config: Config
): Promise<{ success: boolean; summary?: string }> {
  const baseUrl = config.wikiServerUrl.replace(/\/$/, "");
  const headers = buildHeaders();
  const warnings: string[] = [];

  // 1. Check worker heartbeat via /api/active-agents
  try {
    const res = await fetch(`${baseUrl}/api/active-agents`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as ActiveAgentsResponse;
      const workerAgents = (data.agents ?? []).filter(
        (a) => a.sessionId?.startsWith("worker-") && a.status === "active"
      );

      if (workerAgents.length === 0) {
        warnings.push("No active job worker found in active-agents");
      } else {
        for (const agent of workerAgents) {
          if (agent.heartbeatAt) {
            const ageMs =
              Date.now() - new Date(agent.heartbeatAt).getTime();
            if (ageMs > HEARTBEAT_CRITICAL_MS) {
              warnings.push(
                `Worker ${agent.sessionId} heartbeat ${Math.round(ageMs / 60000)}min stale (CRITICAL)`
              );
            } else if (ageMs > HEARTBEAT_WARN_MS) {
              warnings.push(
                `Worker ${agent.sessionId} heartbeat ${Math.round(ageMs / 60000)}min stale`
              );
            }
          }
        }
      }
    } else {
      logger.warn(
        { status: res.status },
        "active-agents endpoint returned non-OK status"
      );
    }
  } catch (e) {
    // Wiki-server unreachable — the health-check task handles server-level alerting.
    logger.debug(
      { err: e instanceof Error ? e.message : String(e) },
      "Could not check worker heartbeat"
    );
  }

  // 2. Check job backlog and failure rate via /api/jobs/stats
  try {
    const res = await fetch(`${baseUrl}/api/jobs/stats`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const stats = (await res.json()) as JobStatsResponse;

      for (const [type, info] of Object.entries(stats.byType)) {
        const pendingCount = info.byStatus["pending"] ?? 0;

        // 2a. Backlog size warning
        if (pendingCount > BACKLOG_THRESHOLD) {
          warnings.push(
            `${type}: ${pendingCount} pending jobs (>${BACKLOG_THRESHOLD})`
          );
        }

        // 3. Failure rate warning
        const completedCount = info.byStatus["completed"] ?? 0;
        const failedCount = info.byStatus["failed"] ?? 0;
        const totalFinished = completedCount + failedCount;

        if (totalFinished >= FAILURE_RATE_MIN_SAMPLE) {
          const rate = failedCount / totalFinished;
          if (rate > FAILURE_RATE_THRESHOLD) {
            warnings.push(
              `${type}: ${Math.round(rate * 100)}% failure rate (${failedCount}/${totalFinished})`
            );
          }
        }
      }
    } else {
      logger.warn(
        { status: res.status },
        "jobs/stats endpoint returned non-OK status"
      );
    }
  } catch (e) {
    logger.debug(
      { err: e instanceof Error ? e.message : String(e) },
      "Could not check job stats"
    );
  }

  if (warnings.length > 0) {
    const summary = `Job worker issues: ${warnings.join("; ")}`;
    logger.warn({ warnings }, summary);
    return { success: false, summary };
  }

  return { success: true, summary: "Job worker healthy" };
}
