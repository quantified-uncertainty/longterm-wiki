import {
  fetchDetailed,
  withApiFallback,
  type RpcResourcePipelineResult,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { ResourcePipelineFilters } from "./resource-pipeline-filters";
import { ResourceListTable } from "./resource-list-table";

// ── Types ────────────────────────────────────────────────────────────────

export const FETCH_STATUS_VALUES = [
  "ok",
  "dead",
  "soft_404",
  "not_found",
  "timeout",
  "unreachable",
  "paywall",
  "error",
] as const;
export type FetchStatusValue = (typeof FETCH_STATUS_VALUES)[number];

export const SINCE_DAYS_OPTIONS = [1, 7, 30, 90] as const;
export type SinceDaysValue = (typeof SINCE_DAYS_OPTIONS)[number];

export interface PipelineParams {
  sinceDays: SinceDaysValue;
  fetchStatus: FetchStatusValue | null;
}

export function parseParams(searchParams: Record<string, string | string[] | undefined>): PipelineParams {
  const rawDays = Array.isArray(searchParams.sinceDays)
    ? searchParams.sinceDays[0]
    : searchParams.sinceDays;
  const parsedDays = rawDays ? Number(rawDays) : NaN;
  const sinceDays: SinceDaysValue =
    SINCE_DAYS_OPTIONS.find((d) => d === parsedDays) ?? 7;

  const rawStatus = Array.isArray(searchParams.fetchStatus)
    ? searchParams.fetchStatus[0]
    : searchParams.fetchStatus;
  const fetchStatus =
    rawStatus && FETCH_STATUS_VALUES.includes(rawStatus as FetchStatusValue)
      ? (rawStatus as FetchStatusValue)
      : null;

  return { sinceDays, fetchStatus };
}

// ── Data loading ─────────────────────────────────────────────────────────

async function loadFromApi(
  params: PipelineParams
): Promise<FetchResult<RpcResourcePipelineResult>> {
  const qs = new URLSearchParams({ sinceDays: String(params.sinceDays) });
  if (params.fetchStatus) qs.set("fetchStatus", params.fetchStatus);
  return await fetchDetailed<RpcResourcePipelineResult>(
    `/api/resources/pipeline?${qs.toString()}`,
    { revalidate: 60 }
  );
}

function emptyData(params: PipelineParams): RpcResourcePipelineResult {
  return {
    sinceDays: params.sinceDays,
    fetchStatusFilter: params.fetchStatus,
    totals: { inWindow: 0, all: 0 },
    byFetchStatus: {},
    byEnrichmentStatus: {},
    contentFill: { withFullText: 0, withMetadataOnly: 0, uncached: 0 },
    stuck: { total: 0, sample: [] },
    recentFetched: [],
  };
}

// ── Display helpers ──────────────────────────────────────────────────────

const FETCH_STATUS_COLOR: Record<string, string> = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  dead: "bg-red-500/15 text-red-700 dark:text-red-400",
  soft_404: "bg-red-500/10 text-red-700 dark:text-red-400",
  not_found: "bg-red-500/10 text-red-700 dark:text-red-400",
  timeout: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  unreachable: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  paywall: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  error: "bg-red-500/15 text-red-700 dark:text-red-400",
  unknown: "bg-muted text-muted-foreground",
};

function StatusPill({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-mono ${color}`}
    >
      <span className="font-semibold">{count.toLocaleString()}</span>
      <span>{label}</span>
    </span>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums mt-1">
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {hint && (
        <div className="text-xs text-muted-foreground mt-1">{hint}</div>
      )}
    </div>
  );
}

// ── Content component ────────────────────────────────────────────────────

interface Props {
  searchParams: Record<string, string | string[] | undefined>;
}

export async function ResourcePipelineContent({ searchParams }: Props) {
  const params = parseParams(searchParams);

  const { data, source, apiError } = await withApiFallback(
    () => loadFromApi(params),
    () => emptyData(params)
  );

  const fetchEntries = Object.entries(data.byFetchStatus).sort(
    (a, b) => b[1] - a[1]
  );
  const enrichmentEntries = Object.entries(data.byEnrichmentStatus).sort(
    (a, b) => b[1] - a[1]
  );

  const totalContent =
    data.contentFill.withFullText +
    data.contentFill.withMetadataOnly +
    data.contentFill.uncached;
  const fillPct =
    totalContent > 0
      ? ((data.contentFill.withFullText / totalContent) * 100).toFixed(1)
      : "0";

  return (
    <>
      <p className="text-muted-foreground">
        Per-resource pipeline outcomes during the last{" "}
        <span className="font-medium text-foreground">
          {params.sinceDays} day{params.sinceDays === 1 ? "" : "s"}
        </span>
        . Tracks fetch reachability (ok / paywall / dead), citation_content
        fill rate, and resources stuck mid-pipeline (fetched but not enriched).
      </p>

      <ResourcePipelineFilters
        sinceDays={params.sinceDays}
        fetchStatus={params.fetchStatus}
        sinceDaysOptions={[...SINCE_DAYS_OPTIONS]}
        fetchStatusOptions={[...FETCH_STATUS_VALUES]}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Fetched in window"
          value={data.totals.inWindow}
          hint={`${data.totals.all.toLocaleString()} resources total`}
        />
        <StatCard
          label="Citation content fill"
          value={`${fillPct}%`}
          hint={`${data.contentFill.withFullText.toLocaleString()} with full text`}
        />
        <StatCard
          label="Metadata only"
          value={data.contentFill.withMetadataOnly}
          hint="Title fetched, no body text"
        />
        <StatCard
          label="Stuck (not enriched)"
          value={data.stuck.total}
          hint="Fetched, awaiting classify/enrich"
        />
      </div>

      <h2>Fetch status distribution</h2>
      {fetchEntries.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {fetchEntries.map(([status, count]) => (
            <StatusPill
              key={status}
              label={status}
              count={count}
              color={FETCH_STATUS_COLOR[status] ?? "bg-muted text-muted-foreground"}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No fetches recorded in the selected window.
        </p>
      )}

      <h2>Enrichment pipeline stage</h2>
      {enrichmentEntries.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {enrichmentEntries.map(([status, count]) => (
            <StatusPill
              key={status}
              label={status}
              count={count}
              color="bg-indigo-500/15 text-indigo-700 dark:text-indigo-400"
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No enrichment activity in the selected window.
        </p>
      )}

      <h2>
        Stuck resources{" "}
        <span className="text-muted-foreground text-base font-normal">
          ({data.stuck.total.toLocaleString()})
        </span>
      </h2>
      <p className="text-sm text-muted-foreground">
        Resources that have been fetched but never reached the{" "}
        <code className="text-xs">classified</code> /{" "}
        <code className="text-xs">enriched</code> stage. Sorted oldest first —
        the top entries are the most stale.
      </p>
      {data.stuck.sample.length > 0 ? (
        <ResourceListTable data={data.stuck.sample} />
      ) : (
        <p className="text-sm text-muted-foreground italic">
          No stuck resources in the selected window.
        </p>
      )}

      <h2>Recent fetches</h2>
      <p className="text-sm text-muted-foreground">
        25 most recently fetched resources matching the current filter.
      </p>
      {data.recentFetched.length > 0 ? (
        <ResourceListTable data={data.recentFetched} />
      ) : (
        <p className="text-sm text-muted-foreground italic">
          No fetches in the selected window.
        </p>
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
