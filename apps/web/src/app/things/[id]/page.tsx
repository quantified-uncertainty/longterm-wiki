import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  Database,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";
import { fetchDetailed } from "@/lib/wiki-server";
import type { RpcSourcingDetailResult } from "@/lib/wiki-server";
import { sanitizeRawLargeNumbers } from "@/lib/format-compact";
import {
  VerdictBadge,
  getStoredVerdictHref,
} from "../../sourcing/sourcing-shared";
import { isAnySid } from "@longterm-wiki/id-utils";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import type { EntityProfileShellHeaderLink } from "@/components/entity/EntityProfileShell";
import { SOURCE_CHECK_VERDICT_PRIORITY } from "@/components/shared/verdict-styles";

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

interface RecordLookupResult {
  sourceTable: string;
  sourceId: string;
  record: Record<string, unknown>;
  displayNames: Record<string, { title: string; slug: string; entityType: string }>;
}

/** Fields already shown in the Metadata section — skip in Record Data. */
const METADATA_FIELDS = new Set(["source_table", "sourceTable", "source_id", "sourceId"]);

/**
 * Map source_table names (DB) to the recordType format used by sourcing API.
 * DB uses snake_case plural ("funding_rounds"), sourcing uses kebab-case singular ("funding-round").
 * Only tables that support sourcing verdicts are included.
 */
const SOURCE_TABLE_TO_RECORD_TYPE: Record<string, string> = {
  facts: "fact",
  grants: "grant",
  personnel: "personnel",
  divisions: "division",
  funding_programs: "funding-program",
  investments: "investment",
  funding_rounds: "funding-round",
  publications: "publication",
  wiki_pages: "wiki-page",
  equity_positions: "equity-position",
  policy_stakeholders: "policy-stakeholder",
  benchmark_results: "benchmark-result",
};

/** Source tables that support sourcing verdicts (derived from the map above). */
const VERDICT_SOURCE_TABLES = new Set(Object.keys(SOURCE_TABLE_TO_RECORD_TYPE));

function sourceTableToRecordType(sourceTable: string): string {
  return SOURCE_TABLE_TO_RECORD_TYPE[sourceTable] ?? sourceTable.replace(/_/g, "-");
}

/**
 * Reduce a list of per-field verdicts to a single rollup verdict, preferring
 * the most actionable (contradicted > outdated > partial > ...). Mirrors
 * `rollupVerdictFromSummary` from `@/components/entity/entity-sourcing` but
 * works on `RpcSourcingDetailResult.verdicts` directly so we don't need to
 * round-trip through the entity-summary endpoint.
 */
function rollupRecordVerdict(verdicts: RpcSourcingDetailResult["verdicts"]): string | null {
  if (verdicts.length === 0) return null;
  let best: string | null = null;
  let bestPriority = Infinity;
  for (const v of verdicts) {
    const p = SOURCE_CHECK_VERDICT_PRIORITY[v.verdict] ?? 99;
    if (p < bestPriority) {
      bestPriority = p;
      best = v.verdict;
    }
  }
  return best;
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
  if (!ts) return "—";
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
  if (count === 0) return <span className="text-muted-foreground">{"—"}</span>;

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

function RecordValue({
  fieldKey,
  value,
  displayNames,
}: {
  fieldKey: string;
  value: unknown;
  displayNames: Record<string, { title: string; slug: string; entityType: string }>;
}) {
  // Null / undefined
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">{"—"}</span>;
  }

  // Boolean
  if (typeof value === "boolean") {
    return <span>{value ? "Yes" : "No"}</span>;
  }

  // Number
  if (typeof value === "number") {
    return <span className="tabular-nums">{value.toLocaleString("en-US")}</span>;
  }

  // String values
  if (typeof value === "string") {
    // Entity stableId reference (but not the record's own id field)
    if (fieldKey !== "id" && isAnySid(value) && displayNames[value]) {
      const dn = displayNames[value];
      return (
        <span>
          <Link href={`/wiki/${dn.slug}`} className="text-primary hover:underline">
            {dn.title}
          </Link>
          <span className="text-xs text-muted-foreground ml-1">({dn.entityType})</span>
        </span>
      );
    }

    // URL
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400 break-all"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          {(() => {
            try {
              const url = new URL(value);
              const display = url.hostname + url.pathname;
              return display.length > 80 ? display.slice(0, 80) + "…" : display;
            } catch {
              return value.length > 80 ? value.slice(0, 80) + "…" : value;
            }
          })()}
        </a>
      );
    }

    // ISO date-like string (e.g. "2025-03-15T00:00:00.000Z" or "2025-03-15")
    if (/^\d{4}-\d{2}-\d{2}(T|\s)/.test(value)) {
      return <span>{formatTimestamp(value)}</span>;
    }

    // Long string — truncate
    if (value.length > 300) {
      return <span className="text-sm">{value.slice(0, 300)}{"…"}</span>;
    }

    return <span className="text-sm">{value}</span>;
  }

  // Arrays — check for stableId references first
  if (Array.isArray(value)) {
    const hasSids = value.some(
      (v) => typeof v === "string" && isAnySid(v) && displayNames[v]
    );
    if (hasSids) {
      return (
        <span className="flex flex-wrap gap-1.5">
          {value.map((item, i) => {
            if (typeof item === "string" && isAnySid(item) && displayNames[item]) {
              const dn = displayNames[item];
              return (
                <span key={`${item}-${i}`}>
                  {i > 0 && <span className="text-muted-foreground">, </span>}
                  <Link href={`/wiki/${dn.slug}`} className="text-primary hover:underline">
                    {dn.title}
                  </Link>
                  <span className="text-xs text-muted-foreground ml-1">({dn.entityType})</span>
                </span>
              );
            }
            if (typeof item === "object" && item !== null) {
              return <span key={`obj-${i}`} className="text-sm">{JSON.stringify(item)}</span>;
            }
            return <span key={`${item}-${i}`}>{String(item)}</span>;
          })}
        </span>
      );
    }
  }

  // Objects and non-stableId arrays — JSON fallback
  if (typeof value === "object") {
    let json: string;
    try {
      json = JSON.stringify(value, null, 2);
    } catch {
      json = "[Unable to serialize]";
    }
    const display = json.length > 300 ? json.slice(0, 300) + "…" : json;
    return (
      <pre className="text-xs bg-muted px-2 py-1 rounded overflow-x-auto max-w-full whitespace-pre-wrap">
        {display}
      </pre>
    );
  }

  return <span className="text-sm">{String(value)}</span>;
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

  // Fetch sourcing verdicts and record data in parallel
  const recordType = sourceTableToRecordType(thing.sourceTable);
  const supportsVerdicts = VERDICT_SOURCE_TABLES.has(thing.sourceTable);

  const verdictsPromise = supportsVerdicts
    ? fetchDetailed<RpcSourcingDetailResult>(
        `/api/sourcing/verdicts/${encodeURIComponent(recordType)}/${encodeURIComponent(thing.sourceId)}`,
        { revalidate: 300 }
      )
    : Promise.resolve(null);

  const recordPromise = fetchDetailed<RecordLookupResult>(
    `/api/record-lookup/${encodeURIComponent(thing.sourceTable)}/${encodeURIComponent(thing.sourceId)}`,
    { revalidate: 300 }
  );

  const [verdictsSettled, recordSettled] = await Promise.allSettled([
    verdictsPromise,
    recordPromise,
  ]);

  let verdicts: RpcSourcingDetailResult | null = null;
  if (verdictsSettled.status === "fulfilled" && verdictsSettled.value && verdictsSettled.value.ok) {
    verdicts = verdictsSettled.value.data;
  }

  let recordData: RecordLookupResult | null = null;
  if (recordSettled.status === "fulfilled" && recordSettled.value.ok) {
    recordData = recordSettled.value.data;
  }

  const hasVerdicts = verdicts && verdicts.verdicts.length > 0;
  const rollupVerdict = supportsVerdicts && verdicts ? rollupRecordVerdict(verdicts.verdicts) : null;
  const sourcingHref = supportsVerdicts ? getStoredVerdictHref(recordType, thing.sourceId) : null;

  // Header pieces -----------------------------------------------------------

  const titlePills = (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-violet-600 dark:text-violet-400">
      <Database className="h-3 w-3" />
      {thing.thingType}
    </span>
  );

  const subtitle = thing.parentTitle && thing.parentThingId ? (
    <p className="text-sm text-muted-foreground">
      Child of{" "}
      <Link
        href={`/things/${encodeURIComponent(thing.parentThingId)}`}
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        {thing.parentTitle}
      </Link>
    </p>
  ) : undefined;

  const headerLinks: EntityProfileShellHeaderLink[] = [];
  if (thing.href) {
    headerLinks.push({ label: "Full page", href: thing.href });
  }
  if (thing.parentThingId) {
    headerLinks.push({
      label: "Entity profile",
      href: `/wiki/E1929?entity=${encodeURIComponent(thing.parentThingId)}`,
    });
  }
  if (sourcingHref) {
    headerLinks.push({ label: "Source checks", href: sourcingHref });
  }

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
    // Older composed fact descriptions embed raw numeric literals
    // (e.g. "Internal Revenue: 1700000000"); rewrite at render time.
    const sanitized = sanitizeRawLargeNumbers(thing.description);
    metadataRows.push({
      label: "Description",
      value: (
        <span className="text-sm">
          {sanitized.length > 300
            ? sanitized.slice(0, 300) + "…"
            : sanitized}
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
    <EntityProfileShell
      breadcrumbs={[
        { label: "Things", href: "/things" },
        { label: thing.title },
      ]}
      title={thing.title}
      titlePills={titlePills}
      subtitle={subtitle}
      headerLinks={headerLinks}
      verdict={supportsVerdicts ? rollupVerdict : undefined}
      verdictHref={sourcingHref ?? undefined}
    >
      <div className="space-y-8">
        {/* Thing Metadata table */}
        <section>
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

        {/* Record Data */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <span className="inline-flex items-center gap-1.5">
              <Database className="h-4 w-4" />
              Record Data
            </span>
          </h2>
          {recordData && Object.keys(recordData.record).length > 0 ? (
            <div className="rounded-lg border border-border/60 overflow-hidden">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border/30">
                  {Object.entries(recordData.record)
                    .filter(([key]) => !METADATA_FIELDS.has(key))
                    .map(([key, value]) => (
                      <tr key={key}>
                        <td className="px-4 py-2.5 text-muted-foreground font-medium whitespace-nowrap w-48 align-top">
                          <code className="text-[12px]">{key}</code>
                        </td>
                        <td className="px-4 py-2.5">
                          <RecordValue
                            fieldKey={key}
                            value={value}
                            displayNames={recordData!.displayNames}
                          />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Record data unavailable</p>
          )}
        </section>

        {/* Source Check Verdicts */}
        {hasVerdicts ? (
          <section>
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
          </section>
        ) : supportsVerdicts ? (
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4" />
                Source Check
              </span>
            </h2>
            <div className="rounded-lg border border-dashed border-border/60 p-4">
              <p className="text-sm text-muted-foreground">
                This record has not been sourced yet.
              </p>
            </div>
          </section>
        ) : null}

        {/* Debug footer */}
        <details className="text-xs text-muted-foreground border-t border-border pt-4">
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
    </EntityProfileShell>
  );
}
