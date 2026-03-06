import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { fetchAllPaginated } from "@lib/fetch-paginated";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { AgentSessionsTable } from "./sessions-table";
import type {
  AgentSessionRow as CanonicalAgentSessionRow,
  SessionRow,
} from "@wiki-server/api-response-types";

// ── Types ─────────────────────────────────────────────────────────────────

export interface AgentSessionRow {
  id: number;
  branch: string;
  task: string;
  sessionType: string;
  issueNumber: number | null;
  worktree: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  // Fix-chain tracking
  prOutcome: string | null;
  fixesPrUrl: string | null;
  // From joined sessions table (via branch)
  prUrl: string | null;
  model: string | null;
  cost: string | null;
  costCents: number | null;
  durationMinutes: number | null;
  title: string | null;
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<AgentSessionRow[]>> {
  // Fetch agent sessions (checklist-based, tracks active work)
  const agentResult = await fetchDetailed<{ sessions: CanonicalAgentSessionRow[] }>(
    "/api/agent-sessions?limit=200",
    { revalidate: 30 }
  );
  if (!agentResult.ok) return agentResult;

  // Fetch all session logs (completed sessions with PR/cost info), paginating through all pages
  const logsResult = await fetchAllPaginated<SessionRow>({
    path: "/api/sessions",
    itemsKey: "sessions",
    pageSize: 500,
    revalidate: 60,
  });

  // Build lookup maps for enrichment:
  // 1. session_id → session log (direct FK, preferred for newer records)
  // 2. branch → session log (fallback heuristic for older records without session_id)
  const logsById = new Map<number, SessionRow>();
  const logsByBranch = new Map<string, SessionRow>();
  if (logsResult.ok) {
    for (const log of logsResult.data.items) {
      logsById.set(log.id, log);
      if (log.branch) {
        logsByBranch.set(log.branch, log);
      }
    }
  }

  const rows: AgentSessionRow[] = agentResult.data.sessions.map((s): AgentSessionRow => {
    // Prefer FK-linked session log; fall back to branch-name heuristic for older records
    const log = (s.sessionId != null ? logsById.get(s.sessionId) : undefined)
      ?? logsByBranch.get(s.branch);
    return {
      id: s.id,
      branch: s.branch,
      task: s.task,
      sessionType: s.sessionType,
      issueNumber: s.issueNumber,
      worktree: s.worktree ?? null,
      status: s.status,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      // Prefer prUrl from agent_sessions (set by `crux issues done --pr=URL`),
      // fall back to session log for older records.
      prUrl: s.prUrl ?? log?.prUrl ?? null,
      prOutcome: s.prOutcome ?? null,
      fixesPrUrl: s.fixesPrUrl ?? null,
      model: log?.model ?? null,
      cost: log?.cost ?? null,
      costCents: log?.costCents ?? null,
      durationMinutes: log?.durationMinutes ?? null,
      title: log?.title ?? null,
    };
  });

  return { ok: true, data: rows };
}

function noLocalFallback(): AgentSessionRow[] {
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
  const withPr = sessions.filter((s) => s.prUrl).length;
  const fixSessions = sessions.filter((s) => s.fixesPrUrl).length;
  const fixRate = completedSessions > 0 ? Math.round((fixSessions / completedSessions) * 100) : 0;
  const totalCostCents = sessions.reduce((sum, s) => sum + (s.costCents ?? 0), 0);
  const sessionsWithCost = sessions.filter((s) => s.costCents != null).length;
  const totalCostDollars = (totalCostCents / 100).toFixed(2);

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
