import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import {
  fetchDetailed,
} from "@/lib/wiki-server";
import type {
  RpcSourceCheckDetailResult,
  RpcSourceChecksResolveNamesResult,
} from "@/lib/wiki-server";
import {
  VerdictBadge,
  formatRecordType,
  getRecordHref,
  formatCheckerModel,
} from "../../source-checks-shared";
import { cn } from "@/lib/utils";
import { isUrl } from "@/components/wiki/factbase/format";
import { getEntityHref } from "@data/entity-nav";
import { getKBFactById, getKBEntity, getKBProperty } from "@/data/factbase";
import { formatKBFactValue } from "@/components/wiki/factbase/format";

export const revalidate = 3600;
export const dynamicParams = true;

interface PageProps {
  params: Promise<{ recordType: string; recordId: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { recordType, recordId } = await params;

  // Try to resolve a human-readable name
  const namesResult = await fetchDetailed<RpcSourceChecksResolveNamesResult>(
    `/api/source-checks/resolve-names?record_type=${encodeURIComponent(recordType)}&record_ids=${encodeURIComponent(recordId)}`,
    { revalidate: 3600 }
  );
  const rawName = namesResult.ok ? namesResult.data.names[recordId] : null;
  const name = rawName?.startsWith("new:") ? rawName.slice(4).trim() : rawName;
  const title = name
    ? `Source Check: ${name}`
    : `Source Check: ${formatRecordType(recordType)} ${recordId}`;

  return {
    title,
    description: `Source verification details for ${name ?? recordId} (${formatRecordType(recordType)}).`,
    robots: { index: false },
  };
}

export default async function SourceCheckDetailPage({ params }: PageProps) {
  const { recordType, recordId } = await params;

  // Fetch detail (verdicts + evidence) and names in parallel
  const [detailResult, namesResult] = await Promise.all([
    fetchDetailed<RpcSourceCheckDetailResult>(
      `/api/source-checks/verdicts/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}`,
      { revalidate: 3600 }
    ),
    fetchDetailed<RpcSourceChecksResolveNamesResult>(
      `/api/source-checks/resolve-names?record_type=${encodeURIComponent(recordType)}&record_ids=${encodeURIComponent(recordId)}`,
      { revalidate: 3600 }
    ),
  ]);

  if (!detailResult.ok) {
    if (
      detailResult.error.type === "server-error" &&
      detailResult.error.status === 404
    ) {
      notFound();
    }
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link
          href="/source-checks"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          All Source Checks
        </Link>
        <h1 className="text-2xl font-bold mb-4">Source Check Detail</h1>
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-600">
          <p className="font-medium mb-1">Unable to load source check data</p>
          <p className="text-red-500/80">
            The wiki-server may be temporarily unavailable. Please try again
            later.
          </p>
        </div>
      </div>
    );
  }

  const { verdicts, evidence } = detailResult.data;
  const rawResolvedName = namesResult.ok
    ? namesResult.data.names[recordId]
    : null;
  // Strip "new:" prefix that can leak from personnel/division raw IDs
  const resolvedName = rawResolvedName?.startsWith("new:")
    ? rawResolvedName.slice(4).trim()
    : rawResolvedName;
  const displayName =
    resolvedName ?? `${formatRecordType(recordType)} ${recordId}`;

  // Compute evidence counts for verdict summary
  const uniqueSourceUrls = new Set(
    evidence.filter((e) => e.sourceUrl).map((e) => e.sourceUrl)
  );

  // Resolve entity info from first verdict that has an entityId
  const entityId = verdicts.find((v) => v.entityId)?.entityId ?? null;
  const entityHref = entityId ? getEntityHref(entityId) : null;

  // Build claim summary based on record type
  let claimSummary: string | null = null;
  let claimEntityName: string | null = null;
  if (recordType === "fact") {
    const fact = getKBFactById(recordId);
    if (fact) {
      const entity = getKBEntity(fact.subjectId);
      const property = getKBProperty(fact.propertyId);
      claimEntityName = entity?.name ?? fact.subjectId;
      const propertyName = property?.name ?? fact.propertyId;
      const formattedValue = formatKBFactValue(fact, property?.unit, property?.display);
      claimSummary = `${claimEntityName} — ${propertyName}: ${formattedValue}`;
    }
  }

  const recordHref = getRecordHref(recordType, recordId);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <Link
        href="/source-checks"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        All Source Checks
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <span className="capitalize">{formatRecordType(recordType)}</span>
          <span>&middot;</span>
          <span className="font-mono">{recordId}</span>
        </div>
        <h1 className="text-2xl font-bold mb-1">
          {claimSummary ?? displayName}
        </h1>
        {claimSummary && resolvedName && resolvedName !== claimSummary && (
          <p className="text-sm text-muted-foreground mb-2">{resolvedName}</p>
        )}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {recordHref && (
            <Link href={recordHref} className="text-primary hover:underline">
              {recordType === "personnel"
                ? "People directory"
                : `View ${formatRecordType(recordType).toLowerCase()} record`} &rarr;
            </Link>
          )}
          {entityHref && (
            <Link href={entityHref} className="text-primary hover:underline">
              {recordType === "personnel"
                ? "View organization page"
                : recordType === "division"
                  ? "View parent organization"
                  : claimEntityName
                    ? `${claimEntityName} wiki page`
                    : "View entity page"} &rarr;
            </Link>
          )}
        </div>
      </div>

      {/* Verdict summary cards */}
      {verdicts.length > 0 ? (
        <div className="space-y-4 mb-8">
          {verdicts.map((v, i) => {
            // Count evidence items that match this verdict's fieldName
            const fieldEvidence = evidence.filter(
              (e) => (e.fieldName ?? null) === (v.fieldName ?? null)
            );
            const fieldUniqueUrls = new Set(
              fieldEvidence.filter((e) => e.sourceUrl).map((e) => e.sourceUrl)
            );

            return (
              <div
                key={`${v.fieldName ?? "overall"}-${i}`}
                className="rounded-lg border border-border/60 p-5"
              >
                <div className="flex items-start justify-between gap-4 mb-3">
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
                    {fieldEvidence.length > 0 && (
                      <p>
                        {fieldEvidence.length} evidence check
                        {fieldEvidence.length !== 1 ? "s" : ""}
                        {fieldUniqueUrls.size > 0 &&
                          fieldUniqueUrls.size !== fieldEvidence.length && (
                            <>
                              {" "}from {fieldUniqueUrls.size} unique source
                              {fieldUniqueUrls.size !== 1 ? "s" : ""}
                            </>
                          )}
                      </p>
                    )}
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

                {/* Confidence bar */}
                {v.confidence != null && (
                  <div
                    className="w-full bg-muted rounded-full h-2 mb-3"
                    role="progressbar"
                    aria-valuenow={Math.round(v.confidence * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${v.verdict} confidence: ${Math.round(v.confidence * 100)}%`}
                  >
                    <div
                      className={cn(
                        "h-2 rounded-full transition-all",
                        v.verdict === "confirmed"
                          ? "bg-emerald-500"
                          : v.verdict === "contradicted"
                            ? "bg-red-500"
                            : v.verdict === "outdated"
                              ? "bg-amber-500"
                              : v.verdict === "partial"
                                ? "bg-amber-400"
                                : "bg-gray-400"
                      )}
                      style={{ width: `${Math.round(v.confidence * 100)}%` }}
                    />
                  </div>
                )}

                {v.reasoning && (
                  <p className="text-sm text-muted-foreground">{v.reasoning}</p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 p-6 text-center text-muted-foreground mb-8">
          <p>No verdict records found for this item.</p>
        </div>
      )}

      {/* Evidence — grouped by source URL, deduplicated */}
      {evidence.length > 0 && (() => {
        // Group evidence by source URL
        const bySource = new Map<string, typeof evidence>();
        for (const e of evidence) {
          const key = e.sourceUrl || "(no source)";
          const group = bySource.get(key);
          if (group) group.push(e);
          else bySource.set(key, [e]);
        }

        // Deduplicate within each source group: collapse checks with same verdict + similar notes
        // Keep the most recent check, show count of duplicates
        type DeduplicatedCheck = (typeof evidence)[number] & { duplicateCount: number };
        function deduplicateChecks(checks: typeof evidence): DeduplicatedCheck[] {
          const seen = new Map<string, DeduplicatedCheck>();
          for (const c of checks) {
            // Key on verdict + first 100 chars of notes (to catch near-identical notes)
            const dedupeKey = `${c.verdict}:${(c.notes || c.extractedValue || "").slice(0, 100)}`;
            const existing = seen.get(dedupeKey);
            if (existing) {
              existing.duplicateCount++;
              // Keep the more recent one
              if (c.checkedAt && existing.checkedAt && c.checkedAt > existing.checkedAt) {
                seen.set(dedupeKey, { ...c, duplicateCount: existing.duplicateCount });
              }
            } else {
              seen.set(dedupeKey, { ...c, duplicateCount: 1 });
            }
          }
          return [...seen.values()];
        }

        return (
          <section className="mb-8">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-4">
              Evidence &mdash; {uniqueSourceUrls.size} source{uniqueSourceUrls.size !== 1 ? "s" : ""}, {evidence.length} check{evidence.length !== 1 ? "s" : ""}
            </h2>
            <div className="space-y-4">
              {[...bySource.entries()].map(([sourceUrl, checks]) => (
                <div key={sourceUrl} className="rounded-lg border border-border/60 overflow-hidden">
                  {/* Source header */}
                  {sourceUrl !== "(no source)" && (
                    <div className="bg-muted/30 px-4 py-2.5 border-b border-border/40">
                      <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline dark:text-blue-400"
                      >
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                        {(() => { try { return new URL(sourceUrl).hostname + new URL(sourceUrl).pathname; } catch { return sourceUrl; } })()}
                      </a>
                      <span className="text-xs text-muted-foreground ml-2">
                        ({checks.length} check{checks.length !== 1 ? "s" : ""})
                      </span>
                    </div>
                  )}

                  {/* Individual checks for this source (deduplicated) */}
                  <div className="divide-y divide-border/30">
                    {deduplicateChecks(checks).map((e) => (
                      <div key={e.id} className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <VerdictBadge verdict={e.verdict} />
                          {e.confidence != null && (
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {Math.round(e.confidence * 100)}%
                            </span>
                          )}
                          {e.isPrimarySource && (
                            <span className="inline-flex items-center rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-semibold text-blue-600">
                              primary
                            </span>
                          )}
                          {e.duplicateCount > 1 && (
                            <span className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                              {e.duplicateCount} similar checks
                            </span>
                          )}
                          <span className="ml-auto text-xs text-muted-foreground">
                            {e.checkerModel && formatCheckerModel(e.checkerModel)}
                            {e.checkedAt && <> &middot; {new Date(e.checkedAt).toLocaleDateString()}</>}
                          </span>
                        </div>

                        {/* Expected vs Found */}
                        {(e.expectedValue || e.extractedValue) && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2 text-sm">
                            {e.expectedValue && (
                              <div>
                                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Expected: </span>
                                {e.expectedValue}
                              </div>
                            )}
                            {e.extractedValue && (
                              <div>
                                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Found: </span>
                                {e.extractedValue}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Quote */}
                        {e.extractedQuote && (
                          <blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground italic mb-2">
                            {e.extractedQuote}
                          </blockquote>
                        )}

                        {/* Notes */}
                        {e.notes && (
                          <p className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground/70">Note:</span> {e.notes}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

      {evidence.length === 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Evidence
          </h2>
          <div className="rounded-lg border border-border/60 p-6 text-center text-muted-foreground">
            <p>No evidence records found for this item.</p>
          </div>
        </section>
      )}

      {/* Footer */}
      <div className="text-xs text-muted-foreground border-t border-border pt-4 mt-8">
        <span className="font-mono">{recordId}</span>
      </div>
    </div>
  );
}
