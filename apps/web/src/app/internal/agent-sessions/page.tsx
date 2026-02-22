import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { AgentSessionsTable } from "./sessions-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agent Sessions | Longterm Wiki Internal",
  description:
    "History of Claude Code agent sessions: what each session worked on, which issues were addressed, and linked PRs.",
};

// ── Types ─────────────────────────────────────────────────────────────────

export interface AgentSessionRow {
  id: number;
  branch: string;
  task: string;
  sessionType: string;
  issueNumber: number | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  // From joined sessions table (via branch)
  prUrl: string | null;
  model: string | null;
  cost: string | null;
  title: string | null;
}

interface ApiAgentSession {
  id: number;
  branch: string;
  task: string;
  sessionType: string;
  issueNumber: number | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ApiSessionLog {
  id: number;
  branch: string | null;
  title: string;
  prUrl: string | null;
  model: string | null;
  cost: string | null;
  date: string;
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<AgentSessionRow[]>> {
  // Fetch agent sessions (checklist-based, tracks active work)
  const agentResult = await fetchDetailed<{ sessions: ApiAgentSession[] }>(
    "/api/agent-sessions?limit=200",
    { revalidate: 30 }
  );
  if (!agentResult.ok) return agentResult;

  // Fetch session logs (completed sessions with PR/cost info)
  const logsResult = await fetchDetailed<{ sessions: ApiSessionLog[] }>(
    "/api/sessions?limit=500",
    { revalidate: 60 }
  );

  // Build a branch → session log map for enrichment (keep most recent log per branch)
  const logsByBranch = new Map<string, ApiSessionLog>();
  if (logsResult.ok) {
    for (const log of logsResult.data.sessions) {
      if (log.branch) {
        const existing = logsByBranch.get(log.branch);
        if (!existing || log.date > existing.date) {
          logsByBranch.set(log.branch, log);
        }
      }
    }
  }

  const rows: AgentSessionRow[] = agentResult.data.sessions.map((s): AgentSessionRow => {
    const log = logsByBranch.get(s.branch);
    return {
      id: s.id,
      branch: s.branch,
      task: s.task,
      sessionType: s.sessionType,
      issueNumber: s.issueNumber,
      status: s.status,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      prUrl: log?.prUrl ?? null,
      model: log?.model ?? null,
      cost: log?.cost ?? null,
      title: log?.title ?? null,
    };
  });

  return { ok: true, data: rows };
}

function noLocalFallback(): AgentSessionRow[] {
  return [];
}

// ── Page Component ────────────────────────────────────────────────────────

export default async function AgentSessionsPage() {
  const { data: sessions, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const totalSessions = sessions.length;
  const activeSessions = sessions.filter((s) => s.status === "active").length;
  const completedSessions = sessions.filter((s) => s.status === "completed").length;
  const withPr = sessions.filter((s) => s.prUrl).length;

  return (
    <article className="prose max-w-none">
      <h1>Agent Sessions</h1>
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
            .
          </>
        ) : (
          <>No sessions recorded yet.</>
        )}
      </p>
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
    </article>
  );
}
