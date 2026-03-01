import { fetchDetailed, fetchFromWikiServer, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { ActiveAgentsTable } from "./active-agents-table";
import type { ActiveAgentRow as CanonicalRow } from "@wiki-server/api-response-types";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ActiveAgentRow {
  id: number;
  sessionId: string;
  branch: string | null;
  task: string;
  status: string;
  currentStep: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  filesTouched: string[] | null;
  model: string | null;
  worktree: string | null;
  heartbeatAt: string;
  startedAt: string;
  completedAt: string | null;
}

export interface ActiveAgentConflict {
  issueNumber: number;
  sessionIds: string[];
}

// ── Data Loading ──────────────────────────────────────────────────────────

interface ApiResponse {
  agents: CanonicalRow[];
  conflicts: ActiveAgentConflict[];
}

interface PullsApiResponse {
  pulls: Array<{ number: number; branch: string }>;
}

async function loadFromApi(): Promise<FetchResult<{ agents: ActiveAgentRow[]; conflicts: ActiveAgentConflict[] }>> {
  // Fetch agents and open PRs in parallel
  const [result, pullsData] = await Promise.all([
    fetchDetailed<ApiResponse>(
      "/api/active-agents?limit=100",
      { revalidate: 15 } // refresh every 15s for live tracking
    ),
    fetchFromWikiServer<PullsApiResponse>(
      "/api/github/pulls",
      { revalidate: 30 }
    ),
  ]);
  if (!result.ok) return result;

  // Build branch → PR number map for enrichment
  const branchToPR = new Map<string, number>();
  if (pullsData?.pulls) {
    for (const pr of pullsData.pulls) {
      branchToPR.set(pr.branch, pr.number);
    }
  }

  const agents: ActiveAgentRow[] = result.data.agents.map((a): ActiveAgentRow => ({
    id: a.id,
    sessionId: a.sessionId,
    branch: a.branch,
    task: a.task,
    status: a.status,
    currentStep: a.currentStep,
    issueNumber: a.issueNumber,
    // Enrich: if prNumber isn't set but branch matches an open PR, use it
    prNumber: a.prNumber ?? (a.branch ? branchToPR.get(a.branch) ?? null : null),
    filesTouched: a.filesTouched,
    model: a.model,
    worktree: a.worktree,
    heartbeatAt: a.heartbeatAt,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
  }));

  return { ok: true, data: { agents, conflicts: result.data.conflicts } };
}

function noLocalFallback(): { agents: ActiveAgentRow[]; conflicts: ActiveAgentConflict[] } {
  return { agents: [], conflicts: [] };
}

// ── Content Component ────────────────────────────────────────────────────

export async function ActiveAgentsContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const { agents, conflicts } = data;
  const activeCount = agents.filter((a) => a.status === "active").length;
  const completedCount = agents.filter((a) => a.status === "completed").length;
  const staleCount = agents.filter((a) => a.status === "stale").length;

  return (
    <>
      <p className="text-muted-foreground">
        Live tracking of concurrent Claude Code agent sessions.{" "}
        {agents.length > 0 ? (
          <>
            <span className="font-medium text-foreground">{agents.length}</span> agents tracked:{" "}
            {activeCount > 0 && (
              <span className="text-green-600 font-medium">{activeCount} active</span>
            )}
            {activeCount > 0 && (completedCount > 0 || staleCount > 0) && ", "}
            {completedCount > 0 && (
              <span className="text-muted-foreground font-medium">{completedCount} completed</span>
            )}
            {completedCount > 0 && staleCount > 0 && ", "}
            {staleCount > 0 && (
              <span className="text-yellow-600 font-medium">{staleCount} stale</span>
            )}
            .
          </>
        ) : (
          <>No agents registered yet.</>
        )}
      </p>

      {conflicts.length > 0 && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 mb-4">
          <p className="text-sm font-semibold text-red-600 mb-2">
            Conflict Warning: Multiple agents on same issue
          </p>
          {conflicts.map((c) => (
            <p key={c.issueNumber} className="text-sm text-red-600/80">
              Issue #{c.issueNumber}: {c.sessionIds.length} agents ({c.sessionIds.join(", ")})
            </p>
          ))}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Agents register with{" "}
        <code className="text-xs">pnpm crux agents register</code>, send heartbeats
        during work, and are marked stale if silent for 30+ minutes. Use{" "}
        <code className="text-xs">pnpm crux agents status</code> to check from the CLI.
      </p>

      {agents.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No agents registered</p>
          <p className="text-sm">
            Agents register when they start a session via{" "}
            <code className="text-xs">pnpm crux agents register</code>.
          </p>
        </div>
      ) : (
        <ActiveAgentsTable data={agents} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
