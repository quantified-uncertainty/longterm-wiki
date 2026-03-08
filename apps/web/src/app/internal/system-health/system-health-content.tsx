import {
  fetchDetailed,
  fetchFromWikiServer,
  withApiFallback,
  type ApiErrorReason,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { SystemHealthTable } from "./system-health-table";
import { OpenPRsTable, type OpenPRDisplayRow } from "./open-prs-table";
// ── Types ─────────────────────────────────────────────────────────────────

// Defined locally because MonitoringStatusResult (Hono RPC inferred) degrades
// to `any` for nested fields when resolved across the package boundary.

interface ServiceStatusEntry {
  name: string;
  status: string;
  openIncidents: number;
}

interface IncidentEntry {
  id: number;
  service: string;
  severity: string;
  status: string;
  title: string;
  detail: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  checkSource: string | null;
}

interface MonitoringStatusData {
  overall: string;
  checkedAt: string;
  services: ServiceStatusEntry[];
  dbCounts: { pages: number; entities: number; facts: number };
  recentIncidents: IncidentEntry[];
  jobsQueue: Record<string, number>;
  activeAgents: number;
}

export type IncidentDisplayRow = IncidentEntry;

interface CiCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

interface ExtendedHealthData {
  ci: {
    sha: string;
    totalChecks: number;
    allCompleted: boolean;
    allPassed: boolean;
    anyFailed: boolean;
    checks: CiCheckRun[];
  } | null;
  groundskeeperTasks: Array<{
    taskName: string;
    totalRuns: number;
    successCount: number;
    failureCount: number;
    successRate: number | null;
    avgDurationMs: number | null;
    lastRun: string;
  }>;
  integrity: {
    totalDanglingRefs: number;
    status: string;
    breakdown: {
      facts: number;
      claims: number;
      summaries: number;
      citations: number;
      editLogs: number;
    };
  };
  autoUpdate: {
    totalRuns: number;
    recentRuns: Array<{
      id: number;
      date: string;
      trigger: string;
      pagesUpdated: number;
      pagesFailed: number;
      budgetSpent: number;
      completed: boolean;
    }>;
  };
  recentSessions: Array<{
    id: number;
    sessionId: string;
    branch: string | null;
    task: string | null;
    status: string;
    issueNumber: number | null;
    prNumber: number | null;
    startedAt: string | null;
    completedAt: string | null;
    model: string | null;
  }>;
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<MonitoringStatusData>> {
  return fetchDetailed<MonitoringStatusData>("/api/monitoring/status", {
    revalidate: 30,
  });
}

async function loadExtendedData(): Promise<FetchResult<ExtendedHealthData>> {
  return fetchDetailed<ExtendedHealthData>("/api/monitoring/extended", {
    revalidate: 60,
  });
}

function noLocalFallback(): MonitoringStatusData {
  return {
    overall: "unknown",
    checkedAt: new Date().toISOString(),
    services: [],
    dbCounts: { pages: 0, entities: 0, facts: 0 },
    recentIncidents: [],
    jobsQueue: {},
    activeAgents: 0,
  };
}

// ── UI Components ─────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  subtext,
  colorClass,
}: {
  label: string;
  value: string | number | null;
  subtext?: string;
  colorClass?: string;
}) {
  const isUnavailable = value === null;
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p
        className={`text-2xl font-semibold tabular-nums ${isUnavailable ? "text-muted-foreground/50" : (colorClass ?? "")}`}
      >
        {isUnavailable ? "\u2014" : value}
      </p>
      {subtext && !isUnavailable && (
        <p className="text-xs text-muted-foreground mt-0.5">{subtext}</p>
      )}
    </div>
  );
}

const STATUS_STYLES: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  healthy: {
    bg: "bg-green-500/15",
    text: "text-green-600",
    label: "Healthy",
  },
  degraded: {
    bg: "bg-yellow-500/15",
    text: "text-yellow-600",
    label: "Degraded",
  },
  down: { bg: "bg-red-500/15", text: "text-red-500", label: "Down" },
  unknown: {
    bg: "bg-muted",
    text: "text-muted-foreground",
    label: "Not monitored",
  },
};

/** Services that are actually monitored. discord-bot and vercel-frontend
 *  have no health check wiring and permanently show "Not monitored". */
const MONITORED_SERVICES = new Set([
  "wiki-server",
  "groundskeeper",
  "github-actions",
]);

const SERVICE_LABELS: Record<string, string> = {
  "wiki-server": "Wiki Server",
  groundskeeper: "Groundskeeper",
  "github-actions": "GitHub Actions",
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.unknown;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${style.bg} ${style.text}`}
    >
      {style.label}
    </span>
  );
}

function ServiceCard({
  service,
}: {
  service: { name: string; status: string; openIncidents: number };
}) {
  const style = STATUS_STYLES[service.status] ?? STATUS_STYLES.unknown;
  const label = SERVICE_LABELS[service.name] ?? service.name;

  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium">{label}</p>
        <StatusBadge status={service.status} />
      </div>
      {service.openIncidents > 0 && (
        <p className={`text-xs ${style.text}`}>
          {service.openIncidents} open incident
          {service.openIncidents !== 1 ? "s" : ""}
        </p>
      )}
    </div>
  );
}

function OverallBanner({ status, checkedAt }: { status: string; checkedAt: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.unknown;
  const checkedDate = new Date(checkedAt);
  const checkedTimeStr = checkedDate.toISOString().slice(11, 16); // HH:MM UTC
  return (
    <div
      className={`rounded-lg border-2 p-4 mb-6 flex items-center gap-3 ${style.bg}`}
    >
      <span className={`text-3xl ${style.text}`}>
        {status === "healthy"
          ? "\u2713"
          : status === "degraded"
            ? "\u26A0"
            : status === "down"
              ? "\u2717"
              : "?"}
      </span>
      <div>
        <p className={`text-lg font-semibold ${style.text}`}>
          System {style.label}
        </p>
        <p className="text-xs text-muted-foreground">
          Last checked: {checkedTimeStr} UTC
        </p>
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-muted-foreground mb-3 mt-8">
      {children}
    </h3>
  );
}

function SectionUnavailable({ title, error }: { title: string; error?: ApiErrorReason | null }) {
  const detail = error
    ? error.type === "server-error"
      ? `HTTP ${error.status} ${error.statusText}`
      : error.type === "connection-error"
        ? error.message
        : error.type
    : "unknown error";
  return (
    <>
      <SectionHeader>{title}</SectionHeader>
      <div className="rounded-lg border border-red-200 bg-red-500/5 p-4 text-sm text-muted-foreground mb-6">
        Failed to load ({detail})
      </div>
    </>
  );
}


/** Deduplicate CI check runs by name, keeping the most informative conclusion. */
function deduplicateChecks(checks: CiCheckRun[]): CiCheckRun[] {
  const byName = new Map<string, CiCheckRun>();
  // Priority: failure > success > other > skipped
  const priority = (c: string | null) =>
    c === "failure" ? 3 : c === "success" ? 2 : c === "skipped" ? 0 : 1;
  for (const check of checks) {
    const existing = byName.get(check.name);
    if (!existing || priority(check.conclusion) > priority(existing.conclusion)) {
      byName.set(check.name, check);
    }
  }
  return Array.from(byName.values());
}

function CiStatusSection({ ci }: { ci: ExtendedHealthData["ci"] }) {
  if (!ci) {
    return (
      <>
        <SectionHeader>CI Pipeline (main branch)</SectionHeader>
        <div className="rounded-lg border border-border/60 p-4 text-muted-foreground text-sm mb-6">
          CI status unavailable (GITHUB_TOKEN not configured on server)
        </div>
      </>
    );
  }

  const statusColor = ci.allPassed
    ? "text-green-600"
    : ci.anyFailed
      ? "text-red-500"
      : "text-yellow-600";
  const statusLabel = ci.allPassed
    ? "All checks passed"
    : ci.anyFailed
      ? "Some checks failed"
      : "Checks in progress";
  const statusBg = ci.allPassed
    ? "bg-green-500/15"
    : ci.anyFailed
      ? "bg-red-500/15"
      : "bg-yellow-500/15";

  return (
    <>
      <SectionHeader>CI Pipeline (main branch)</SectionHeader>
      <div className={`rounded-lg border border-border/60 p-4 mb-4 ${statusBg}`}>
        <div className="flex items-center justify-between mb-2">
          <span className={`text-sm font-semibold ${statusColor}`}>
            {statusLabel}
          </span>
          <span className="text-xs text-muted-foreground font-mono">
            {ci.sha}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {ci.checks.length} check{ci.checks.length !== 1 ? "s" : ""}
          {ci.allCompleted ? " completed" : " running"}
          {ci.totalChecks > ci.checks.length && ` (${ci.totalChecks} total)`}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-6">
        {deduplicateChecks(ci.checks).map((check) => {
          const isSuccess = check.conclusion === "success";
          const isFailed = check.conclusion === "failure";
          const isRunning = check.status !== "completed";
          const bgClass = isFailed
            ? "bg-red-500/10"
            : isSuccess
              ? ""
              : isRunning
                ? "bg-yellow-500/10"
                : "";
          return (
            <div
              key={check.name}
              className={`rounded border border-border/60 px-3 py-2 flex items-center justify-between ${bgClass}`}
            >
              <span className="text-xs truncate mr-2">{check.name}</span>
              <span
                className={`text-xs font-medium shrink-0 ${
                  isFailed
                    ? "text-red-500"
                    : isSuccess
                      ? "text-green-600"
                      : "text-yellow-600"
                }`}
              >
                {isRunning
                  ? check.status
                  : check.conclusion ?? "unknown"}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function GroundskeeperSection({
  tasks,
}: {
  tasks: ExtendedHealthData["groundskeeperTasks"];
}) {
  if (tasks.length === 0) {
    return (
      <>
        <SectionHeader>Groundskeeper Tasks (last 24h)</SectionHeader>
        <div className="rounded-lg border border-border/60 p-4 text-muted-foreground text-sm mb-6">
          No task runs recorded in the last 24 hours.
        </div>
      </>
    );
  }

  const failingTasks = tasks.filter(
    (t) => t.successRate !== null && t.successRate < 80
  );

  return (
    <>
      <SectionHeader>Groundskeeper Tasks (last 24h)</SectionHeader>

      {/* Alert banner for failing tasks */}
      {failingTasks.length > 0 && (
        <div className="rounded-lg border-2 border-red-300 bg-red-500/10 p-4 mb-4">
          <p className="text-sm font-semibold text-red-600 mb-2">
            {failingTasks.length} task{failingTasks.length !== 1 ? "s" : ""} failing
          </p>
          <div className="space-y-1">
            {failingTasks.map((task) => (
              <p key={task.taskName} className="text-xs text-red-600/80">
                <span className="font-mono font-medium">{task.taskName}</span>
                {" \u2014 "}
                {task.failureCount} of {task.totalRuns} run{task.totalRuns !== 1 ? "s" : ""} failed
                {task.successRate !== null && ` (${task.successRate}% success rate)`}
              </p>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60">
              <th className="text-left text-xs text-muted-foreground font-medium py-2 pr-4">
                Task
              </th>
              <th className="text-right text-xs text-muted-foreground font-medium py-2 px-3">
                Runs
              </th>
              <th className="text-right text-xs text-muted-foreground font-medium py-2 px-3">
                Success Rate
              </th>
              <th className="text-right text-xs text-muted-foreground font-medium py-2 px-3">
                Avg Duration
              </th>
              <th className="text-right text-xs text-muted-foreground font-medium py-2 pl-3">
                Last Run
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const isFailing = task.successRate !== null && task.successRate < 80;
              const rateColor =
                task.successRate === null
                  ? ""
                  : task.successRate >= 95
                    ? "text-green-600"
                    : task.successRate >= 80
                      ? "text-yellow-600"
                      : "text-red-500";
              return (
                <tr
                  key={task.taskName}
                  className={`border-b border-border/30 ${isFailing ? "bg-red-500/5" : ""}`}
                >
                  <td className="py-2 pr-4 font-mono text-xs">
                    {task.taskName}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {task.totalRuns}
                    {task.failureCount > 0 && (
                      <span className="text-red-500 ml-1">
                        ({task.failureCount} failed)
                      </span>
                    )}
                  </td>
                  <td
                    className={`py-2 px-3 text-right tabular-nums font-medium ${rateColor}`}
                  >
                    {task.successRate !== null
                      ? `${task.successRate}%`
                      : "-"}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                    {task.avgDurationMs !== null
                      ? task.avgDurationMs > 1000
                        ? `${(task.avgDurationMs / 1000).toFixed(1)}s`
                        : `${task.avgDurationMs}ms`
                      : "-"}
                  </td>
                  <td className="py-2 pl-3 text-right text-xs text-muted-foreground" suppressHydrationWarning>
                    {formatRelativeTime(task.lastRun)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function IntegritySection({
  integrity,
}: {
  integrity: ExtendedHealthData["integrity"];
}) {
  const isClean = integrity.status === "clean";

  return (
    <>
      <SectionHeader>Data Integrity</SectionHeader>
      <div
        className={`rounded-lg border border-border/60 p-4 mb-6 ${
          isClean ? "bg-green-500/10" : "bg-yellow-500/10"
        }`}
      >
        <div className="flex items-center justify-between mb-2">
          <span
            className={`text-sm font-semibold ${
              isClean ? "text-green-600" : "text-yellow-600"
            }`}
          >
            {isClean
              ? "No dangling references"
              : `${integrity.totalDanglingRefs} dangling reference${integrity.totalDanglingRefs !== 1 ? "s" : ""}`}
          </span>
        </div>
        {!isClean && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-2">
            {Object.entries(integrity.breakdown).map(([key, count]) =>
              count > 0 ? (
                <div
                  key={key}
                  className="text-xs text-muted-foreground"
                >
                  <span className="font-medium text-yellow-700">
                    {count}
                  </span>{" "}
                  in {key}
                </div>
              ) : null
            )}
          </div>
        )}
      </div>
    </>
  );
}

function AutoUpdateSection({
  autoUpdate,
}: {
  autoUpdate: ExtendedHealthData["autoUpdate"];
}) {
  return (
    <>
      <SectionHeader>Auto-Update System</SectionHeader>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <StatCard label="Total runs" value={autoUpdate.totalRuns} />
        <StatCard
          label="Recent updates"
          value={autoUpdate.recentRuns.reduce(
            (sum, r) => sum + r.pagesUpdated,
            0
          )}
          subtext="pages (last 5 runs)"
        />
        <StatCard
          label="Recent failures"
          value={autoUpdate.recentRuns.reduce(
            (sum, r) => sum + r.pagesFailed,
            0
          )}
          subtext="pages (last 5 runs)"
          colorClass={
            autoUpdate.recentRuns.some((r) => r.pagesFailed > 0)
              ? "text-yellow-600"
              : "text-green-600"
          }
        />
      </div>
      {autoUpdate.recentRuns.length > 0 && (
        <div className="overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60">
                <th className="text-left text-xs text-muted-foreground font-medium py-2 pr-4">
                  Date
                </th>
                <th className="text-left text-xs text-muted-foreground font-medium py-2 px-3">
                  Trigger
                </th>
                <th className="text-right text-xs text-muted-foreground font-medium py-2 px-3">
                  Updated
                </th>
                <th className="text-right text-xs text-muted-foreground font-medium py-2 px-3">
                  Failed
                </th>
                <th className="text-right text-xs text-muted-foreground font-medium py-2 pl-3">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {autoUpdate.recentRuns.map((run) => (
                <tr
                  key={run.id}
                  className="border-b border-border/30"
                >
                  <td className="py-2 pr-4 text-xs">{run.date}</td>
                  <td className="py-2 px-3 text-xs">{run.trigger}</td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {run.pagesUpdated}
                  </td>
                  <td
                    className={`py-2 px-3 text-right tabular-nums ${
                      run.pagesFailed > 0 ? "text-red-500" : ""
                    }`}
                  >
                    {run.pagesFailed}
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums text-muted-foreground">
                    {"$"}{run.budgetSpent.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const GITHUB_REPO = "quantified-uncertainty/longterm-wiki";

function CurrentDeploymentSection() {
  const commitSha = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "";
  const commitRef = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF ?? "";
  const commitMessage =
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE ?? "";
  const buildTimestamp = process.env.NEXT_PUBLIC_BUILD_TIMESTAMP ?? "";

  if (!commitSha && !buildTimestamp) {
    return (
      <>
        <SectionHeader>Current Deployment</SectionHeader>
        <div className="rounded-lg border border-border/60 p-4 text-muted-foreground text-sm mb-6">
          Build metadata unavailable (not deployed via Vercel)
        </div>
      </>
    );
  }

  const shortSha = commitSha.slice(0, 8);
  const commitUrl = commitSha
    ? `https://github.com/${GITHUB_REPO}/commit/${commitSha}`
    : null;

  // If the branch looks like a PR branch (e.g. "claude/foo"), link to the
  // repo's PR list filtered by head ref. For "main", link to the commit.
  const isPrBranch = commitRef && commitRef !== "main";
  const prSearchUrl = isPrBranch
    ? `https://github.com/${GITHUB_REPO}/pulls?q=is%3Apr+head%3A${encodeURIComponent(commitRef)}`
    : null;

  const buildAge = buildTimestamp ? formatRelativeTime(buildTimestamp) : null;

  return (
    <>
      <SectionHeader>Current Deployment</SectionHeader>
      <div className="rounded-lg border border-border/60 p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {/* Commit */}
          <div>
            <span className="text-muted-foreground text-xs">Commit</span>
            <div className="font-mono text-xs mt-0.5">
              {commitUrl ? (
                <a
                  href={commitUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  {shortSha}
                </a>
              ) : (
                shortSha || "\u2014"
              )}
              {commitMessage && (
                <span className="ml-2 text-muted-foreground truncate inline-block max-w-[300px] align-bottom">
                  {commitMessage}
                </span>
              )}
            </div>
          </div>

          {/* Branch / PR */}
          <div>
            <span className="text-muted-foreground text-xs">Branch</span>
            <div className="text-xs mt-0.5">
              <span className="font-mono">{commitRef || "\u2014"}</span>
              {prSearchUrl && (
                <a
                  href={prSearchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 text-blue-600 hover:underline"
                >
                  View PR
                </a>
              )}
            </div>
          </div>

          {/* Build time */}
          <div>
            <span className="text-muted-foreground text-xs">Built</span>
            <div className="text-xs mt-0.5" suppressHydrationWarning>
              {buildAge && <span>{buildAge}</span>}
              {buildTimestamp && (
                <span className="ml-2 text-muted-foreground">
                  {new Date(buildTimestamp).toISOString().replace("T", " ").slice(0, 19)} UTC
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

// ── Content Component ────────────────────────────────────────────────────

interface PullsApiResponse {
  pulls: OpenPRDisplayRow[];
  error?: string;
}

export async function SystemHealthContent() {
  const [
    { data, source, apiError },
    extendedResult,
    pullsData,
  ] = await Promise.all([
    withApiFallback(loadFromApi, noLocalFallback),
    loadExtendedData(),
    fetchFromWikiServer<PullsApiResponse>("/api/github/pulls", {
      revalidate: 30,
    }),
  ]);

  const extended = extendedResult.ok ? extendedResult.data : null;
  const extendedError = !extendedResult.ok ? extendedResult.error : null;
  const openPRs: OpenPRDisplayRow[] = pullsData?.pulls ?? [];

  const { overall, checkedAt, services: rawServices, recentIncidents } =
    data;

  // Augment github-actions service status with CI data when available.
  // Filter out unmonitored services (discord-bot, vercel-frontend) that
  // permanently show "Not monitored" — they have no health check wiring.
  const services = rawServices
    .filter((svc) => MONITORED_SERVICES.has(svc.name))
    .map((svc) => {
      if (svc.name === "github-actions" && svc.status === "unknown" && extended?.ci) {
        const ciStatus = extended.ci.anyFailed
          ? "degraded" as const
          : extended.ci.allPassed
            ? "healthy" as const
            : "unknown" as const;
        return { ...svc, status: ciStatus };
      }
      return svc;
    });

  // Count open incidents from service cards (all-time) to reconcile with
  // the recent-only (last 24h) incident list shown below
  const totalOpenIncidentsAllTime = services.reduce(
    (sum, svc) => sum + svc.openIncidents,
    0
  );
  const incidentRows: IncidentDisplayRow[] = recentIncidents;
  const recentOpenCount = recentIncidents.filter((i) => i.status === "open").length;
  const olderOpenCount = totalOpenIncidentsAllTime - recentOpenCount;

  return (
    <>
      <p className="text-muted-foreground">
        Unified view of service health, infrastructure status, and recent
        incidents. Data is aggregated from the wiki-server health endpoint,
        groundskeeper heartbeats, and recorded incidents.
      </p>

      {/* Overall status banner */}
      <OverallBanner status={overall} checkedAt={checkedAt} />

      {/* Service status cards — only monitored services */}
      {services.length > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          {services.map((svc) => (
            <ServiceCard key={svc.name} service={svc} />
          ))}
        </div>
      )}

      {/* Current deployment */}
      <CurrentDeploymentSection />

      {/* CI Pipeline Status */}
      {extended ? (
        <CiStatusSection ci={extended.ci} />
      ) : extendedError ? (
        <SectionUnavailable title="CI Pipeline (main branch)" error={extendedError} />
      ) : null}

      {/* Data Integrity */}
      {extended ? (
        <IntegritySection integrity={extended.integrity} />
      ) : extendedError ? (
        <SectionUnavailable title="Data Integrity" error={extendedError} />
      ) : null}

      {/* Open Pull Requests */}
      <h3 className="text-sm font-semibold text-muted-foreground mb-3">
        Open pull requests
      </h3>
      {openPRs.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground mb-6">
          <p className="text-lg font-medium mb-2">No open pull requests</p>
          <p className="text-sm">
            {pullsData?.error
              ? `Could not fetch PRs: ${pullsData.error}`
              : "Open PRs will appear here when agents or contributors create them."}
          </p>
        </div>
      ) : (
        <div className="mb-6">
          <OpenPRsTable data={openPRs} />
        </div>
      )}

      {/* Recent incidents */}
      <SectionHeader>Recent incidents (last 24h)</SectionHeader>
      {incidentRows.length === 0 && olderOpenCount === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground mb-6">
          <p className="text-lg font-medium mb-2">No recent incidents</p>
          <p className="text-sm">
            Incidents are recorded when health checks, wellness checks, or the
            groundskeeper daemon detect service problems.
          </p>
        </div>
      ) : (
        <>
          {incidentRows.length > 0 && (
            <SystemHealthTable data={incidentRows} />
          )}
          {olderOpenCount > 0 && (
            <div className="rounded-lg border border-yellow-300 bg-yellow-500/10 p-4 mb-6 text-sm">
              <span className="font-medium text-yellow-700">
                {olderOpenCount} older open incident{olderOpenCount !== 1 ? "s" : ""}
              </span>
              <span className="text-muted-foreground">
                {" "}detected more than 24h ago{incidentRows.length === 0 ? " (none in last 24h)" : ""}
              </span>
            </div>
          )}
        </>
      )}

      {/* Groundskeeper Tasks */}
      {extended ? (
        <GroundskeeperSection tasks={extended.groundskeeperTasks} />
      ) : extendedError ? (
        <SectionUnavailable title="Groundskeeper Tasks (last 24h)" error={extendedError} />
      ) : null}

      {/* Auto-Update System */}
      {extended ? (
        <AutoUpdateSection autoUpdate={extended.autoUpdate} />
      ) : extendedError ? (
        <SectionUnavailable title="Auto-Update System" error={extendedError} />
      ) : null}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
