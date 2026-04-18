import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { AgentSessionsTable } from "./sessions-table";
import type { AgentSessionListRow } from "@wiki-server/api-response-types";

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<AgentSessionListRow[]>> {
  const result = await fetchDetailed<{ sessions: AgentSessionListRow[] }>(
    "/api/agent-sessions?limit=200",
    { revalidate: 30 }
  );
  if (!result.ok) return result;
  return { ok: true, data: result.data.sessions };
}

function noLocalFallback(): AgentSessionListRow[] {
  return [];
}

// ── Content Component ────────────────────────────────────────────────────

export async function AgentSessionsContent() {
  const { data: sessions, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const totalSessions = sessions.length;
  const activeSessions = sessions.filter((s) => s.status === "active").length;
  const completedSessions = sessions.filter((s) => s.status === "completed").length;
  const staleSessions = sessions.filter((s) => s.status === "stale").length;
  const withPr = sessions.filter((s) => s.prUrl).length;
  const fixSessions = sessions.filter((s) => s.fixesPrUrl).length;
  // Denominator includes stale rows: fix rate = (fixes / finished sessions),
  // where "finished" = completed OR stale. Stale rows are still finished in
  // the sense that they're no longer accepting work.
  const finishedSessions = completedSessions + staleSessions;
  const fixRate = finishedSessions > 0 ? Math.round((fixSessions / finishedSessions) * 100) : 0;
  const totalCostCents = sessions.reduce((sum, s) => sum + (s.costCents ?? 0), 0);
  const sessionsWithCost = sessions.filter((s) => s.costCents != null).length;
  const totalCostDollars = (totalCostCents / 100).toFixed(2);

  // Outcome stats
  const withOutcome = sessions.filter((s) => s.prOutcome).length;
  const merged = sessions.filter((s) => s.prOutcome === "merged").length;
  const mergedWithRevisions = sessions.filter((s) => s.prOutcome === "merged_with_revisions").length;
  const reverted = sessions.filter((s) => s.prOutcome === "reverted").length;
  const closedWithoutMerge = sessions.filter((s) => s.prOutcome === "closed_without_merge").length;
  const mergeRate = withOutcome > 0 ? Math.round(((merged + mergedWithRevisions) / withOutcome) * 100) : 0;
  const cleanMergeRate = withOutcome > 0 ? Math.round((merged / withOutcome) * 100) : 0;

  return (
    <>
      <p className="text-muted-foreground">
        History of Claude Code agent sessions.{" "}
        {totalSessions > 0 ? (
          <>
            <span className="font-medium text-foreground">{totalSessions}</span> sessions total:{" "}
            {activeSessions > 0 && (
              <span className="text-yellow-600 font-medium">{activeSessions} active, </span>
            )}
            <span className="text-emerald-600 font-medium">{completedSessions} completed</span>
            {staleSessions > 0 && (
              <span className="text-muted-foreground">, {staleSessions} stale (swept — no graceful exit)</span>
            )}
            {withPr > 0 && (
              <span className="text-muted-foreground">, {withPr} with PR</span>
            )}
            {sessionsWithCost > 0 && (
              <span className="text-muted-foreground">, total cost: ${totalCostDollars} ({sessionsWithCost} sessions with cost data)</span>
            )}
            .
          </>
        ) : (
          <>No sessions recorded yet.</>
        )}
      </p>
      {fixSessions > 0 && (
        <p className="text-sm text-muted-foreground">
          <span className="text-orange-600 font-medium">{fixSessions}</span> fix session{fixSessions !== 1 ? 's' : ''}{" "}
          ({fixRate}% fix rate) — sessions that fixed regressions from a previous PR.
        </p>
      )}
      {withOutcome > 0 && (
        <p className="text-sm text-muted-foreground">
          PR outcomes ({withOutcome} tracked):{" "}
          <span className="text-emerald-600 font-medium">{merged} merged</span>
          {mergedWithRevisions > 0 && (
            <>, <span className="text-blue-600 font-medium">{mergedWithRevisions} merged with revisions</span></>
          )}
          {reverted > 0 && (
            <>, <span className="text-red-600 font-medium">{reverted} reverted</span></>
          )}
          {closedWithoutMerge > 0 && (
            <>, <span className="text-gray-600 font-medium">{closedWithoutMerge} closed</span></>
          )}
          {" "}— {cleanMergeRate}% clean merge rate, {mergeRate}% overall merge rate.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Each session tracks what Claude Code worked on, which issue it addressed,
        and the resulting PR. Sessions are initialized with{" "}
        <code className="text-xs">pnpm crux agent-checklist init</code> and
        linked to issues via{" "}
        <code className="text-xs">pnpm crux issues start &lt;N&gt;</code>.
      </p>

      {totalSessions === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No sessions recorded</p>
          <p className="text-sm">
            Sessions are created when Claude Code runs{" "}
            <code className="text-xs">pnpm crux agent-checklist init</code> at
            session start.
          </p>
        </div>
      ) : (
        <AgentSessionsTable data={sessions} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
