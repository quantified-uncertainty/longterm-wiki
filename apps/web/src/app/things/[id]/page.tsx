import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  Database,
  ShieldCheck,
  ExternalLink,
  ArrowLeft,
  ArrowRight,
  Layers,
} from "lucide-react";
import { fetchDetailed } from "@/lib/wiki-server";
import type { RpcSourceCheckDetailResult } from "@/lib/wiki-server";
import {
  VerdictBadge,
  formatRecordType,
} from "../../source-checks/source-checks-shared";

export const revalidate = 300;
export const dynamicParams = true;

// ── Types ──────────────────────────────────────────────────────────────

interface ThingDetail {
  id: string;
  thingType: string;
  title: string;
  parentThingId: string | null;
  sourceTable: string;
  sourceId: string;
  entityType: string | null;
  description: string | null;
  sourceUrl: string | null;
  wikiId: string | null;
  parentTitle: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  syncedAt: string | null;
  childrenCount: number;
  childrenByType: Record<string, number>;
  href: string | null;
}

// Source tables that support source-check verdicts
const VERDICT_SOURCE_TABLES = new Set([
  "fact",
  "grant",
  "personnel",
  "division",
  "funding_program",
  "investment",
  "funding_round",
  "publication",
  "wiki-page",
]);

/** Map source_table names to the recordType format used by source-checks API */
function sourceTableToRecordType(sourceTable: string): string {
  return sourceTable.replace(/_/g, "-");
}

// ── Metadata ───────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const rawParams = await params;
  const id = decodeURIComponent(rawParams.id);

  const result = await fetchDetailed<ThingDetail>(`/api/things/${encodeURIComponent(id)}`, {
    revalidate: 300,
  });

  const title = result.ok ? `Thing: ${result.data.title}` : `Thing: ${id}`;

  return {
    title,
    description: result.ok
      ? `Universal record inspector for ${result.data.title} (${result.data.thingType}).`
      : `Universal record inspector for ${id}.`,
    robots: { index: false },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatTimestamp(ts: string | null): string {
  if (!ts) return "\u2014";
  try {
    return new Date(ts).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return ts;
  }
}

function ChildrenSummary({ count, byType }: { count: number; byType: Record<string, number> }) {
  if (count === 0) return <span className="text-muted-foreground">\u2014</span>;

  const entries = Object.entries(byType).sort(([, a], [, b]) => b - a);
  return (
    <span>
      {count} total
      {entries.length > 0 && (
        <span className="text-muted-foreground ml-1">
          ({entries.map(([type, n], i) => (
            <span key={type}>
              {i > 0 && ", "}
              {n} {type}
            </span>
          ))})
        </span>
      )}
    </span>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────

export default async function ThingDetailPage({ params }: PageProps) {
  const rawParams = await params;
  const id = decodeURIComponent(rawParams.id);

  // Fetch thing detail
  const thingResult = await fetchDetailed<ThingDetail>(
    `/api/things/${encodeURIComponent(id)}`,
    { revalidate: 300 }
  );

  if (!thingResult.ok) {
    if (
      thingResult.error.type === "server-error" &&
      thingResult.error.status === 404
    ) {
      notFound();
    }
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-4">Thing Detail</h1>
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-600">
          <p className="font-medium mb-1">Unable to load thing data</p>
          <p className="text-red-500/80">
            The wiki-server may be temporarily unavailable. Please try again later.
          </p>
        </div>
      </div>
    );
  }

  const thing = thingResult.data;

  // Fetch source-check verdicts if the source table supports them
  const recordType = sourceTableToRecordType(thing.sourceTable);
  let verdicts: RpcSourceCheckDetailResult | null = null;

  if (VERDICT_SOURCE_TABLES.has(thing.sourceTable)) {
    const verdictsResult = await fetchDetailed<RpcSourceCheckDetailResult>(
      `/api/source-checks/verdicts/${encodeURIComponent(recordType)}/${encodeURIComponent(thing.sourceId)}`,
      { revalidate: 300 }
    );
    if (verdictsResult.ok) {
      verdicts = verdictsResult.data;
    }
  }

  const hasVerdicts = verdicts && verdicts.verdicts.length > 0;

  // Metadata rows for the key-value table
  const metadataRows: { label: string; value: React.ReactNode }[] = [
    {
      label: "Source Table",
      value: (
        <code className="text-[12px] bg-muted px-1.5 py-0.5 rounded">
          {thing.sourceTable}
        </code>
      ),
    },
    {
      label: "Source ID",
      value: (
        <code className="text-[12px] bg-muted px-1.5 py-0.5 rounded break-all">
          {thing.sourceId}
        </code>
      ),
    },
  ];

  if (thing.entityType) {
    metadataRows.push({
      label: "Entity Type",
      value: (
        <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-semibold text-blue-600 dark:text-blue-400">
          {thing.entityType}
        </span>
      ),
    });
  }

  if (thing.description) {
    metadataRows.push({
      label: "Description",
      value: (
        <span className="text-sm">
          {thing.description.length > 300
            ? thing.description.slice(0, 300) + "\u2026"
            : thing.description}
        </span>
      ),
    });
  }

  if (thing.sourceUrl) {
    metadataRows.push({
      label: "Source URL",
      value: (
        <a
          href={thing.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400 break-all"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          {(() => {
            try {
              const url = new URL(thing.sourceUrl);
              return url.hostname + url.pathname;
            } catch {
              return thing.sourceUrl;
            }
          })()}
        </a>
      ),
    });
  }

  if (thing.wikiId) {
    metadataRows.push({
      label: "Wiki ID",
      value: (
        <Link
          href={`/wiki/${thing.wikiId}`}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          {thing.wikiId}
        </Link>
      ),
    });
  }

  if (thing.parentTitle) {
    metadataRows.push({
      label: "Parent",
      value: thing.parentThingId ? (
        <Link
          href={`/things/${encodeURIComponent(thing.parentThingId)}`}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          {thing.parentTitle}
        </Link>
      ) : (
        <span className="text-sm">{thing.parentTitle}</span>
      ),
    });
  }

  metadataRows.push({
    label: "Children",
    value: <ChildrenSummary count={thing.childrenCount} byType={thing.childrenByType} />,
  });

  metadataRows.push(
    { label: "Created", value: formatTimestamp(thing.createdAt) },
    { label: "Updated", value: formatTimestamp(thing.updatedAt) },
    { label: "Synced", value: formatTimestamp(thing.syncedAt) }
  );

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-violet-600 dark:text-violet-400">
            <Database className="h-3 w-3" />
            {thing.thingType}
          </span>
        </div>

        <h1 className="text-2xl font-bold mb-1">{thing.title}</h1>

        {thing.parentTitle && thing.parentThingId && (
          <p className="text-sm text-muted-foreground mb-2">
            Child of{" "}
            <Link
              href={`/things/${encodeURIComponent(thing.parentThingId)}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {thing.parentTitle}
            </Link>
          </p>
        )}
      </div>

      {/* Navigation links */}
      <div className="flex flex-wrap gap-3 mb-8">
        {thing.href && (
          <Link
            href={thing.href}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors"
          >
            <ArrowRight className="h-3.5 w-3.5" />
            View full page
          </Link>
        )}
        {thing.parentThingId && (
          <Link
            href={`/wiki/E1929?q=${encodeURIComponent(thing.parentThingId)}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors"
          >
            <Layers className="h-3.5 w-3.5" />
            View entity profile
          </Link>
        )}
        {hasVerdicts && (
          <Link
            href={`/source-checks/${encodeURIComponent(recordType)}/${encodeURIComponent(thing.sourceId)}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Source checks
          </Link>
        )}
      </div>

      {/* Thing Metadata table */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Metadata
        </h2>
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border/30">
              {metadataRows.map((row) => (
                <tr key={row.label}>
                  <td className="px-4 py-2.5 text-muted-foreground font-medium whitespace-nowrap w-36 align-top">
                    {row.label}
                  </td>
                  <td className="px-4 py-2.5">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Source Check Verdicts */}
      {hasVerdicts && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" />
              Source Check Verdicts
            </span>
          </h2>
          <div className="space-y-3">
            {verdicts!.verdicts.map((v, i) => (
              <div
                key={`${v.fieldName ?? "overall"}-${i}`}
                className="rounded-lg border border-border/60 p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    {v.fieldName && (
                      <p className="text-xs text-muted-foreground mb-1">
                        Field:{" "}
                        <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
                          {v.fieldName}
                        </code>
                      </p>
                    )}
                    <div className="flex items-center gap-3">
                      <VerdictBadge verdict={v.verdict} />
                      {v.confidence != null && (
                        <span className="text-sm tabular-nums font-medium">
                          {Math.round(v.confidence * 100)}% confidence
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    {v.lastComputedAt && (
                      <p>
                        Last checked:{" "}
                        {new Date(v.lastComputedAt).toLocaleDateString()}
                      </p>
                    )}
                    {v.needsRecheck && (
                      <p className="text-amber-500 font-medium mt-0.5">
                        Needs recheck
                      </p>
                    )}
                  </div>
                </div>

                {v.reasoning && (
                  <p className="text-sm text-muted-foreground mt-2">
                    {v.reasoning}
                  </p>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3">
            <Link
              href={`/source-checks/${encodeURIComponent(recordType)}/${encodeURIComponent(thing.sourceId)}`}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              View full evidence
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </section>
      )}

      {/* Debug footer */}
      <details className="text-xs text-muted-foreground border-t border-border pt-4 mt-8">
        <summary className="cursor-pointer hover:text-foreground transition-colors">
          Debug info
        </summary>
        <div className="mt-2 space-y-0.5">
          <p>
            Thing ID:{" "}
            <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
              {thing.id}
            </code>
          </p>
          <p>
            Source Table:{" "}
            <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
              {thing.sourceTable}
            </code>
          </p>
          <p>
            Source ID:{" "}
            <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
              {thing.sourceId}
            </code>
          </p>
          {thing.parentThingId && (
            <p>
              Parent Thing ID:{" "}
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
                {thing.parentThingId}
              </code>
            </p>
          )}
          {thing.wikiId && (
            <p>
              Wiki ID:{" "}
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
                {thing.wikiId}
              </code>
            </p>
          )}
          {thing.entityType && (
            <p>
              Entity Type:{" "}
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
                {thing.entityType}
              </code>
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
