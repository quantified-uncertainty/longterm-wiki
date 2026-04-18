import type { Config } from "../config.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ task: "active-agents-sweep" });

/**
 * Minutes since last heartbeat after which an active agent is marked stale.
 * 60 min is conservative: the heartbeat hook fires every 10 min while a session
 * is alive, so a 60-min gap reliably means the session has ended (PR shipped,
 * /clear'd, crashed, etc).
 */
const STALE_TIMEOUT_MINUTES = 60;

interface SweptAgent {
  id: number;
  sessionId: string;
}

interface SweepResponse {
  swept: number;
  agents: SweptAgent[];
}

/**
 * Call the wiki-server active-agents sweep endpoint to mark stale active agents.
 * Returns the list of swept agents, or null on failure.
 */
async function callSweepEndpoint(
  config: Config,
  timeoutMinutes: number,
): Promise<SweepResponse | null> {
  const url = `${config.wikiServerUrl}/api/active-agents/sweep`;
  const apiKey = process.env["LONGTERMWIKI_SERVER_API_KEY"];

  if (!apiKey) {
    logger.warn(
      "LONGTERMWIKI_SERVER_API_KEY is not set — skipping sweep",
    );
    return null;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ timeoutMinutes }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error({ status: res.status, body: text.slice(0, 200) }, "Sweep endpoint failed");
      return null;
    }

    return (await res.json()) as SweepResponse;
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Sweep request failed",
    );
    return null;
  }
}

/**
 * Active-agents sweep task (QUA-584):
 * Marks active_agents rows stale after STALE_TIMEOUT_MINUTES of no heartbeat.
 * The endpoint also sets completed_at = heartbeat_at so dashboards can compute
 * accurate session durations for abandoned sessions.
 *
 * Companion to session-sweep (which handles the agent_sessions log table).
 * Both must run because /agent-ship closes agent_sessions but historically
 * left active_agents rows as phantom "active" forever.
 *
 * Idempotent — safe to run on any schedule.
 */
export async function activeAgentsSweep(
  config: Config,
): Promise<{ success: boolean; summary?: string }> {
  const result = await callSweepEndpoint(config, STALE_TIMEOUT_MINUTES);

  if (!result) {
    return { success: false, summary: "Active-agents sweep endpoint call failed" };
  }

  logger.info({ swept: result.swept }, "Swept stale active agents");

  if (result.swept === 0) {
    return { success: true, summary: "No stale active agents to sweep" };
  }

  return {
    success: true,
    summary: `Swept ${result.swept} stale active agent(s)`,
  };
}
