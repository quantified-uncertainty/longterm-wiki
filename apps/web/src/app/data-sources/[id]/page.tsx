import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { DataSourceBanner } from "@/components/internal/DataSourceBanner";
import { ProfileStatCard } from "@/components/directory";
import {
  fetchDetailed,
  type RpcDataSourceDetailResult,
  type RpcSnapshotListResult,
} from "@/lib/wiki-server";
import { resolveEntityName } from "@/lib/resolve-entity-name";
import { computeFreshness } from "@/app/data-sources/freshness";
import {
  FORMAT_LABELS,
  FORMAT_COLORS,
  RECORD_TYPE_LABELS,
  RECORD_TYPE_COLORS,
} from "@/app/data-sources/data-source-labels";
import { SnapshotsSection } from "./snapshots-section";

export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const result = await fetchDetailed<RpcDataSourceDetailResult>(
    `/api/data-sources/${encodeURIComponent(id)}`,
    { revalidate: 300 },
  );
  if (!result.ok) {
    return {
      title: `${id} | Data Sources`,
      description: `Metadata and snapshot history for data source ${id}.`,
    };
  }
  return {
    title: `${result.data.name} | Data Sources`,
    description: `Metadata, column mapping, snapshot history, and connected records for the ${result.data.name} data source.`,
  };
}

const FRESHNESS_STYLES: Record<
  string,
  { label: string; bg: string; text: string }
> = {
  fresh: {
    label: "Fresh",
    bg: "bg-emerald-100 dark:bg-emerald-900/40",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  due: {
    label: "Due",
    bg: "bg-amber-100 dark:bg-amber-900/40",
    text: "text-amber-700 dark:text-amber-300",
  },
  overdue: {
    label: "Overdue",
    bg: "bg-red-100 dark:bg-red-900/40",
    text: "text-red-700 dark:text-red-300",
  },
  static: {
    label: "Static",
    bg: "bg-gray-100 dark:bg-gray-900/40",
    text: "text-gray-600 dark:text-gray-400",
  },
  unknown: {
    label: "Unknown",
    bg: "bg-gray-100 dark:bg-gray-900/40",
    text: "text-gray-600 dark:text-gray-400",
  },
};

const STATUS_STYLES: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "text-blue-600" },
  archived: { label: "Archived", color: "text-muted-foreground" },
  defunct: { label: "Defunct", color: "text-red-600" },
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return iso;
  const days = Math.round(ms / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

function shortHash(h: string | null): string {
  if (!h) return "—";
  return h.length > 10 ? h.slice(0, 10) : h;
}

function TermList({
  items,
}: {
  items: Array<{ label: string; value: React.ReactNode }>;
}) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {items.map(({ label, value }) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground/80 mb-3">
      {children}
    </h2>
  );
}

function JsonBlock({ data }: { data: unknown }) {
  return (
    <pre className="text-xs bg-muted/40 border border-border/60 rounded-lg p-3 overflow-x-auto max-h-72">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export default async function DataSourceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const detailResult = await fetchDetailed<RpcDataSourceDetailResult>(
    `/api/data-sources/${encodeURIComponent(id)}`,
    { revalidate: 300 },
  );

  if (!detailResult.ok) {
    if (
      detailResult.error.type === "server-error" &&
      detailResult.error.status === 404
    ) {
      notFound();
    }
    return (
      <div className="max-w-[80rem] mx-auto px-6 py-8">
        <DataSourceBanner
          source="api"
          apiError={
            detailResult.error.type !== "not-configured"
              ? detailResult.error
              : undefined
          }
        />
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm">
          <p className="font-medium mb-1">Failed to load data source</p>
          <p className="text-muted-foreground">
            {detailResult.error.type === "not-configured"
              ? "Wiki server not configured."
              : detailResult.error.type === "connection-error"
                ? detailResult.error.message
                : `Server returned ${detailResult.error.status} ${detailResult.error.statusText}`}
          </p>
        </div>
      </div>
    );
  }

  const source = detailResult.data;
  const freshness = computeFreshness(
    source.lastSnapshotAt,
    source.updateFrequency,
  );
  const freshnessStyle =
    FRESHNESS_STYLES[freshness] ?? FRESHNESS_STYLES.unknown;
  const statusStyle = STATUS_STYLES[source.sourceStatus] ?? {
    label: source.sourceStatus,
    color: "text-muted-foreground",
  };
  const formatLabel = FORMAT_LABELS[source.dataFormat] ?? source.dataFormat;
  const formatColor =
    FORMAT_COLORS[source.dataFormat] ?? "text-muted-foreground";
  const recordTypeLabel =
    RECORD_TYPE_LABELS[source.recordType] ?? source.recordType;
  const recordTypeColor =
    RECORD_TYPE_COLORS[source.recordType] ?? "text-muted-foreground";

  const publisher = source.publisherEntityId
    ? resolveEntityName(source.publisherEntityId)
    : null;

  const snapshotsResult = await fetchDetailed<RpcSnapshotListResult>(
    `/api/data-sources/${encodeURIComponent(id)}/snapshots?limit=20`,
    { revalidate: 300 },
  );
  const snapshots = snapshotsResult.ok ? snapshotsResult.data.snapshots : [];
  const snapshotTotal = snapshotsResult.ok ? snapshotsResult.data.total : 0;

  const recordsLinkHref =
    source.recordType === "grant" ? `/grants?dataSource=${source.id}` : null;

  const statCards: Array<{
    label: string;
    value: string;
    sub?: string;
    href?: string;
  }> = [
    {
      label: "Records",
      value:
        source.snapshotRecordCount != null
          ? source.snapshotRecordCount.toLocaleString()
          : "—",
      sub:
        source.snapshotRecordCount != null
          ? "in latest snapshot"
          : "no snapshot yet",
      href: recordsLinkHref ?? undefined,
    },
    {
      label: "Last Snapshot",
      value: source.lastSnapshotAt ? relativeTime(source.lastSnapshotAt) : "—",
      sub: source.lastSnapshotAt
        ? new Date(source.lastSnapshotAt).toISOString().slice(0, 10)
        : "never fetched",
    },
    {
      label: "Snapshots",
      value: snapshotTotal.toLocaleString(),
      sub: snapshotsResult.ok ? "total stored" : "unavailable",
    },
    {
      label: "Update Frequency",
      value: source.updateFrequency ?? "—",
      sub: source.updateFrequency ? "expected cadence" : undefined,
    },
  ];

  const metadataItems: Array<{ label: string; value: React.ReactNode }> = [
    { label: "Source slug", value: <code className="text-xs">{source.id}</code> },
    {
      label: "Format",
      value: <span className={`font-medium ${formatColor}`}>{formatLabel}</span>,
    },
    {
      label: "Record type",
      value: (
        <span className={`font-medium ${recordTypeColor}`}>
          {recordTypeLabel}
        </span>
      ),
    },
    { label: "Access method", value: source.accessMethod },
    {
      label: "Fetch URL",
      value: source.fetchUrl ? (
        <a
          href={source.fetchUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-foreground hover:underline break-all"
        >
          {source.fetchUrl}
        </a>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: "Publisher",
      value: publisher ? (
        publisher.href ? (
          <Link
            href={publisher.href}
            className="text-accent-foreground hover:underline"
          >
            {publisher.name}
          </Link>
        ) : (
          publisher.name
        )
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: "Resource",
      value: source.resourceId ? (
        <Link
          href={`/resources/${source.resourceId}`}
          className="text-accent-foreground hover:underline"
        >
          View resource record →
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: "Created",
      value: (
        <span className="tabular-nums text-muted-foreground">
          {new Date(source.createdAt).toISOString().slice(0, 10)}
        </span>
      ),
    },
    {
      label: "Updated",
      value: (
        <span className="tabular-nums text-muted-foreground">
          {new Date(source.updatedAt).toISOString().slice(0, 10)}
        </span>
      ),
    },
  ];

  return (
    <div className="max-w-[80rem] mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <nav className="text-xs text-muted-foreground mb-4" aria-label="Breadcrumb">
        <Link href="/wiki/E2131" className="hover:underline">
          Data Sources
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground/80">{source.name}</span>
      </nav>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          {source.name}
        </h1>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${freshnessStyle.bg} ${freshnessStyle.text}`}
          >
            {freshnessStyle.label}
          </span>
          <span className={`text-xs font-medium ${statusStyle.color}`}>
            {statusStyle.label}
          </span>
          <span className="text-muted-foreground text-xs">·</span>
          <span className={`text-xs font-medium ${formatColor}`}>
            {formatLabel}
          </span>
          <span className={`text-xs font-medium ${recordTypeColor}`}>
            {recordTypeLabel}
          </span>
        </div>
        {source.fetchUrl && (
          <p className="text-sm text-muted-foreground break-all">
            <a
              href={source.fetchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {source.fetchUrl}
            </a>
          </p>
        )}
      </div>

      <DataSourceBanner source="api" />

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        {statCards.map((card) => (
          <ProfileStatCard
            key={card.label}
            label={card.label}
            value={card.value}
            sub={card.sub}
            href={card.href}
          />
        ))}
      </div>

      {/* Main grid: metadata + side sections */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <section>
            <SectionHeader>Metadata</SectionHeader>
            <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5">
              <TermList items={metadataItems} />
            </div>
          </section>

          {source.columnMapping &&
            Object.keys(source.columnMapping).length > 0 && (
              <section>
                <SectionHeader>Column Mapping</SectionHeader>
                <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5">
                  <p className="text-xs text-muted-foreground mb-3">
                    Maps raw source columns → canonical fields used by the
                    importer.
                  </p>
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-xs">
                    {Object.entries(source.columnMapping).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="font-mono text-muted-foreground">
                          {k}
                        </dt>
                        <dd className="font-mono break-all">{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </section>
            )}

          {source.verificationConfig && (
            <section>
              <SectionHeader>Verification Config</SectionHeader>
              <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5">
                <p className="text-xs text-muted-foreground mb-3">
                  Strategy and fields used by source-check to match records
                  against this source.
                </p>
                <JsonBlock data={source.verificationConfig} />
              </div>
            </section>
          )}

          {source.sourceSchema && (
            <section>
              <SectionHeader>Source Schema</SectionHeader>
              <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5">
                <JsonBlock data={source.sourceSchema} />
              </div>
            </section>
          )}
        </div>

        <aside className="space-y-8">
          <section>
            <SectionHeader>Connected Records</SectionHeader>
            <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5 text-sm">
              {recordsLinkHref ? (
                <Link
                  href={recordsLinkHref}
                  className="flex items-center justify-between gap-2 text-accent-foreground hover:underline"
                >
                  <span>
                    Grants from this source
                    {source.snapshotRecordCount != null && (
                      <span className="text-muted-foreground font-normal ml-2">
                        ({source.snapshotRecordCount.toLocaleString()})
                      </span>
                    )}
                  </span>
                  <span className="shrink-0">→</span>
                </Link>
              ) : (
                <p className="text-muted-foreground text-xs">
                  No directory filter exists for{" "}
                  <span className="font-medium">{recordTypeLabel}</span>{" "}
                  records yet.
                </p>
              )}
            </div>
          </section>

          <section>
            <SectionHeader>Latest Snapshot</SectionHeader>
            <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-5 text-sm">
              {source.latestSnapshot ? (
                <TermList
                  items={[
                    {
                      label: "Fetched",
                      value: (
                        <span className="tabular-nums">
                          {new Date(
                            source.latestSnapshot.fetchedAt,
                          ).toLocaleString()}
                        </span>
                      ),
                    },
                    {
                      label: "Records",
                      value:
                        source.latestSnapshot.recordCount != null
                          ? source.latestSnapshot.recordCount.toLocaleString()
                          : "—",
                    },
                    {
                      label: "Hash",
                      value: (
                        <code
                          className="text-xs"
                          title={source.latestSnapshot.snapshotHash}
                        >
                          {shortHash(source.latestSnapshot.snapshotHash)}
                        </code>
                      ),
                    },
                    {
                      label: "Mapping",
                      value: source.latestSnapshot.mappingValid ? (
                        <span className="text-emerald-600">valid</span>
                      ) : (
                        <span className="text-red-600">invalid</span>
                      ),
                    },
                    {
                      label: "Parser",
                      value: source.latestSnapshot.parserVersion ?? "—",
                    },
                  ]}
                />
              ) : (
                <p className="text-muted-foreground text-xs">
                  No snapshots recorded yet.
                </p>
              )}
            </div>
          </section>
        </aside>
      </div>

      {/* Snapshot history */}
      <section className="mt-10">
        <div className="flex items-baseline justify-between mb-3">
          <SectionHeader>Snapshot History</SectionHeader>
          {snapshotTotal > snapshots.length && (
            <span className="text-xs text-muted-foreground">
              showing {snapshots.length} of {snapshotTotal}
            </span>
          )}
        </div>
        <SnapshotsSection snapshots={snapshots} />
      </section>
    </div>
  );
}
