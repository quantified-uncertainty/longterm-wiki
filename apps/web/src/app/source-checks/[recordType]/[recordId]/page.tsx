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
} from "../../source-checks-shared";
import { cn } from "@/lib/utils";
import { isUrl } from "@/components/wiki/factbase/format";

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
  const name = namesResult.ok ? namesResult.data.names[recordId] : null;
  const title = name
    ? `Source Check: ${name}`
    : `Source Check: ${formatRecordType(recordType)} ${recordId}`;

  return {
    title: `${title} | Longterm Wiki`,
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
  const resolvedName = namesResult.ok
    ? namesResult.data.names[recordId]
    : null;
  const displayName =
    resolvedName ?? `${formatRecordType(recordType)} ${recordId}`;

  // Deduplicate evidence by unique source URLs
  const uniqueSourceUrls = new Set(evidence.map((e) => e.sourceUrl).filter(Boolean));

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
      <div className="mb-8">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <span className="capitalize">{formatRecordType(recordType)}</span>
          <span>/</span>
          <span className="font-mono">{recordId}</span>
        </div>
        <h1 className="text-2xl font-bold mb-2">{displayName}</h1>
        {(() => {
          const recordHref = getRecordHref(recordType, recordId);
          return recordHref ? (
            <Link
              href={recordHref}
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              View {formatRecordType(recordType).toLowerCase()} record &rarr;
            </Link>
          ) : null;
        })()}
      </div>

      {/* Verdict summary cards */}
      {verdicts.length > 0 ? (
        <div className="space-y-4 mb-8">
          {verdicts.map((v, i) => (
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
                  <p>
                    {evidence.length} evidence check{evidence.length !== 1 ? "s" : ""}
                    {uniqueSourceUrls.size > 0 && uniqueSourceUrls.size !== evidence.length
                      ? ` from ${uniqueSourceUrls.size} source${uniqueSourceUrls.size !== 1 ? "s" : ""}`
                      : ""}
                  </p>
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
                <div className="w-full bg-muted rounded-full h-2 mb-3">
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
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 p-6 text-center text-muted-foreground mb-8">
          <p>No verdict records found for this item.</p>
        </div>
      )}

      {/* Evidence cards */}
      {evidence.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Evidence ({evidence.length} check{evidence.length !== 1 ? "s" : ""})
          </h2>
          <div className="space-y-3">
            {evidence.map((e) => (
              <div
                key={e.id}
                className="rounded-lg border border-border/60 p-4"
              >
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    <VerdictBadge verdict={e.verdict} />
                    {e.confidence != null && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {Math.round(e.confidence * 100)}% confidence
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {e.checkerModel && <span>{e.checkerModel}</span>}
                    {e.checkedAt && (
                      <span className="tabular-nums">
                        {new Date(e.checkedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>

                {/* Source URL */}
                {e.sourceUrl && (
                  <div className="mb-2">
                    {isUrl(e.sourceUrl) ? (
                      <a
                        href={e.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 dark:text-blue-400 break-all"
                      >
                        <ExternalLink className="h-3 w-3 shrink-0" />
                        {e.sourceUrl}
                      </a>
                    ) : (
                      <span className="font-mono text-xs break-all">{e.sourceUrl}</span>
                    )}
                  </div>
                )}

                {/* Expected vs Found */}
                {(e.expectedValue || e.extractedValue) && (
                  <div className="grid grid-cols-2 gap-3 text-xs mb-2">
                    {e.expectedValue && (
                      <div>
                        <span className="text-muted-foreground font-medium">Expected: </span>
                        <span>{e.expectedValue}</span>
                      </div>
                    )}
                    {e.extractedValue && (
                      <div>
                        <span className="text-muted-foreground font-medium">Found: </span>
                        <span>{e.extractedValue}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Quote */}
                {e.extractedQuote && (
                  <blockquote className="text-xs text-muted-foreground border-l-2 border-border pl-3 italic">
                    &ldquo;{e.extractedQuote}&rdquo;
                  </blockquote>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

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
        Record Type:{" "}
        <code className="px-1 py-0.5 bg-muted rounded">{recordType}</code>{" "}
        &middot; Record ID:{" "}
        <code className="px-1 py-0.5 bg-muted rounded">{recordId}</code>
      </div>
    </div>
  );
}
