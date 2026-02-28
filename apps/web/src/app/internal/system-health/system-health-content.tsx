import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { SystemHealthTable } from "./system-health-table";
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
  lastHealthCheck: unknown;
  recentIncidents: IncidentEntry[];
  jobsQueue: Record<string, number>;
  activeAgents: number;
}

export interface IncidentDisplayRow {
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

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<MonitoringStatusData>> {
  return fetchDetailed<MonitoringStatusData>("/api/monitoring/status", {
    revalidate: 30,
  });
}

function noLocalFallback(): MonitoringStatusData {
  return {
    overall: "unknown",
    checkedAt: new Date().toISOString(),
    services: [],
    dbCounts: { pages: 0, entities: 0, facts: 0 },
    lastHealthCheck: null,
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
  value: string | number;
  subtext?: string;
  colorClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p
        className={`text-2xl font-semibold tabular-nums ${colorClass ?? ""}`}
      >
        {value}
      </p>
      {subtext && (
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
    label: "Unknown",
  },
};

const SERVICE_LABELS: Record<string, string> = {
  "wiki-server": "Wiki Server",
  groundskeeper: "Groundskeeper",
  "discord-bot": "Discord Bot",
  "vercel-frontend": "Vercel Frontend",
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

function OverallBanner({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.unknown;
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
          Last checked:{" "}
          {new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  );
}

// ── Content Component ────────────────────────────────────────────────────

export async function SystemHealthContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const { overall, services, dbCounts, recentIncidents, jobsQueue, activeAgents } =
    data;
  const openIncidentCount = recentIncidents.filter(
    (i) => i.status === "open"
  ).length;
  const criticalCount = recentIncidents.filter(
    (i) => i.severity === "critical" && i.status === "open"
  ).length;

  // Map incidents to the shape the table expects
  const incidentRows: IncidentDisplayRow[] = recentIncidents.map((i) => ({
    id: i.id,
    service: i.service,
    severity: i.severity,
    status: i.status,
    title: i.title,
    detail: i.detail,
    detectedAt: i.detectedAt,
    resolvedAt: i.resolvedAt,
    resolvedBy: i.resolvedBy,
    checkSource: i.checkSource,
  }));

  const totalJobs = Object.values(jobsQueue).reduce(
    (sum, n) => sum + n,
    0
  );
  const pendingJobs = jobsQueue["pending"] ?? 0;

  return (
    <>
      <p className="text-muted-foreground">
        Unified view of service health, infrastructure status, and recent
        incidents. Data is aggregated from the wiki-server health endpoint,
        groundskeeper heartbeats, and recorded incidents.
      </p>

      {/* Overall status banner */}
      <OverallBanner status={overall} />

      {/* Service status cards */}
      {services.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          {services.map((svc) => (
            <ServiceCard key={svc.name} service={svc} />
          ))}
        </div>
      )}

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatCard
          label="Active agents"
          value={activeAgents}
          colorClass={activeAgents > 0 ? "text-blue-600" : undefined}
        />
        <StatCard
          label="Open incidents"
          value={openIncidentCount}
          subtext="last 24h"
          colorClass={openIncidentCount > 0 ? "text-yellow-600" : undefined}
        />
        <StatCard
          label="Critical"
          value={criticalCount}
          colorClass={criticalCount > 0 ? "text-red-500" : "text-green-600"}
        />
        <StatCard
          label="Wiki pages"
          value={dbCounts.pages.toLocaleString()}
          subtext={`${dbCounts.entities} entities`}
        />
        <StatCard
          label="Jobs queue"
          value={totalJobs}
          subtext={pendingJobs > 0 ? `${pendingJobs} pending` : "idle"}
        />
      </div>

      {/* Recent incidents */}
      <h3 className="text-sm font-semibold text-muted-foreground mb-3">
        Recent incidents (last 24h)
      </h3>
      {incidentRows.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground mb-6">
          <p className="text-lg font-medium mb-2">No recent incidents</p>
          <p className="text-sm">
            Incidents are recorded when health checks, wellness checks, or the
            groundskeeper daemon detect service problems.
          </p>
        </div>
      ) : (
        <SystemHealthTable data={incidentRows} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
