import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";
import { apiRequest } from "../wiki-server.js";

const logger = rootLogger.child({ task: "job-worker-health" });

/** Heartbeat age thresholds. */
const HEARTBEAT_WARN_MS = 5 * 60 * 1000;
const HEARTBEAT_CRITICAL_MS = 15 * 60 * 1000;

/** Maximum pending jobs per type before warning. */
const BACKLOG_THRESHOLD = 50;

/** Failure rate above which a warning is emitted. */
const FAILURE_RATE_THRESHOLD = 0.3;

/** Minimum completed+failed jobs to compute a meaningful failure rate. */
const FAILURE_RATE_MIN_SAMPLE = 10;

/** Time window for failure rate and backlog checks (24 hours). */
const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

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
 * Monitor the K8s job worker's health by checking:
 * 1. Worker heartbeat staleness
 * 2. Job backlog size
 * 3. Per-type failure rate
 */
export async function jobWorkerHealth(
  config: Config
): Promise<{ success: boolean; summary?: string }> {
  const warnings: string[] = [];
  let checksPerformed = 0;

  // 1. Check worker heartbeat via /api/active-agents
  const agentsResult = await apiRequest<ActiveAgentsResponse>(
    config,
    "GET",
    "/api/active-agents",
  );
  if (agentsResult.ok && agentsResult.data) {
    checksPerformed++;
    const workerAgents = (agentsResult.data.agents ?? []).filter(
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
      { error: agentsResult.error },
      "Could not check worker heartbeat"
    );
  }

  // 2. Check job backlog and failure rate via /api/jobs/stats (time-windowed)
  // Use a 24h window so historical failures don't permanently poison the check.
  const since = new Date(Date.now() - STATS_WINDOW_MS).toISOString();
  const statsResult = await apiRequest<JobStatsResponse>(
    config,
    "GET",
    `/api/jobs/stats?since=${encodeURIComponent(since)}`,
  );
  if (statsResult.ok && statsResult.data) {
    checksPerformed++;

    for (const [type, info] of Object.entries(statsResult.data.byType)) {
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
      { error: statsResult.error },
      "Could not check job stats"
    );
  }

  // If neither check succeeded, report honestly instead of claiming healthy
  if (checksPerformed === 0) {
    return { success: true, summary: "Could not reach wiki-server — skipped worker health check" };
  }

  if (warnings.length > 0) {
    const summary = `Job worker issues: ${warnings.join("; ")}`;
    logger.warn({ warnings }, summary);
    return { success: false, summary };
  }

  return { success: true, summary: "Job worker healthy" };
}
