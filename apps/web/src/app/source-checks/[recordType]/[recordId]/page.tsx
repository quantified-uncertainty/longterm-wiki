import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Database, ExternalLink } from "lucide-react";
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
import { getEntityHref } from "@data/entity-nav";
import { getKBFactById, getKBEntity, getKBProperty } from "@/data/factbase";
import { inferDataSource } from "@/app/grants/grants-data-source";
import { formatKBFactValue } from "@/components/wiki/factbase/format";

export const revalidate = 3600;
export const dynamicParams = true;

/** Strip internal machine-readable tags like [deterministic-row-match] from user-visible text. */
function stripInternalTags(text: string): string {
  return text.replace(/^\[[\w-]+\]\s*/g, "").replace(/\s*\[[\w-]+\]\s*/g, " ").trim();
}

/** Format a single JSON value for display in a key-value summary. */
function formatJsonValue(v: unknown): string {
  if (typeof v === "string") return v.length > 100 ? v.slice(0, 100) + "\u2026" : v;
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v === null) return "\u2014";
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (typeof v === "object") {
    const entries = Object.entries(v);
    if (entries.length <= 3) return entries.map(([k, val]) => `${k}: ${formatJsonValue(val)}`).join(", ");
    return `{${entries.length} fields}`;
  }
  return String(v);
}

/** Try to parse a string as a JSON object and return non-empty entries, or null.
 *  Also handles truncated JSON (missing closing `"` / `}`) by attempting repairs. */
function parseJsonObjectEntries(text: string): [string, unknown][] | null {
  if (!text.startsWith("{")) return null;

  // Try parsing as-is first
  for (const candidate of [text, text + '"}'  , text + '}']) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const entries = Object.entries(parsed).filter(
        ([, v]) => v !== null && v !== undefined && v !== ""
      );
      return entries.length > 0 ? entries : null;
    } catch {
      continue;
    }
  }

  // Fallback: extract key-value pairs via regex for truncated JSON
  const kvRegex = /"([^"]+)"\s*:\s*("(?:[^"\\]|\\.)*"|[\d.]+|true|false|null)/g;
  const entries: [string, unknown][] = [];
  let match;
  while ((match = kvRegex.exec(text)) !== null) {
    const key = match[1];
    let val: unknown = match[2];
    if (typeof val === "string" && val.startsWith('"')) {
      try { val = JSON.parse(val as string); } catch { val = (val as string).slice(1, -1); }
    } else if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (val === "null") val = null;
    else { const n = Number(val); if (!isNaN(n)) val = n; }
    if (val !== null && val !== undefined && val !== "") entries.push([key, val]);
  }
  return entries.length > 0 ? entries : null;
}

/** Format an extractedQuote for display. Strips "Matched row:" prefix and renders JSON nicely. */
function FormatQuote({ quote }: { quote: string }) {
  let text = quote.trim();

  // Strip "Matched row:" or similar prefixes
  const prefixMatch = text.match(/^(?:Matched row|Found row|Row match)[:\s]*/i);
  if (prefixMatch) {
    text = text.slice(prefixMatch[0].length).trim();
  }

  const entries = parseJsonObjectEntries(text);
  if (entries) {
    return (
      <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 mb-2 text-sm">
        <table className="w-full">
          <tbody>
            {entries.slice(0, 8).map(([k, v]) => (
              <tr key={k} className="border-b border-border/20 last:border-0">
                <td className="pr-3 py-0.5 text-muted-foreground whitespace-nowrap align-top text-xs font-medium">
                  {k}
                </td>
                <td className="py-0.5 text-foreground/80 break-all">
                  {formatJsonValue(v)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length > 8 && (
          <div className="text-xs text-muted-foreground mt-1">+{entries.length - 8} more fields</div>
        )}
      </div>
    );
  }

  return (
    <blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground italic mb-2">
      {text}
    </blockquote>
  );
}

/** Format an extractedValue for display. Detects JSON and renders as a table. */
function FormatExtractedValue({ value }: { value: string }) {
  let trimmed = value.trim();

  // Strip "Matched row:" or similar prefixes before parsing
  const prefixMatch = trimmed.match(/^(?:Matched row|Found row|Row match)[:\s]*/i);
  if (prefixMatch) {
    trimmed = trimmed.slice(prefixMatch[0].length).trim();
  }

  // JSON objects — render as structured table
  const entries = parseJsonObjectEntries(trimmed);
  if (entries) {
    return (
      <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-sm">
        <table className="w-full">
          <tbody>
            {entries.slice(0, 8).map(([k, v]) => (
              <tr key={k} className="border-b border-border/20 last:border-0">
                <td className="pr-3 py-0.5 text-muted-foreground whitespace-nowrap align-top text-xs font-medium">
                  {k}
                </td>
                <td className="py-0.5 text-foreground/80 break-all">
                  {formatJsonValue(v)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length > 8 && (
          <div className="text-xs text-muted-foreground mt-1">+{entries.length - 8} more fields</div>
        )}
      </div>
    );
  }

  // JSON arrays
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) return <span className="text-sm text-muted-foreground">[empty]</span>;
        if (parsed.every((item) => typeof item !== "object" || item === null)) {
          const shown = parsed.slice(0, 5).map((item) => formatJsonValue(item));
          const remaining = parsed.length - shown.length;
          return (
            <span className="text-sm">
              {shown.join(", ")}
              {remaining > 0 && <span className="text-muted-foreground"> (+{remaining} more)</span>}
            </span>
          );
        }
        return <span className="text-sm text-muted-foreground">[{parsed.length} items]</span>;
      }
    } catch {
      // Not valid JSON — fall through to truncation
    }
  }

  // Non-JSON: truncate long values
  if (trimmed.length > 200) {
    return (
      <span className="text-sm" title={trimmed}>
        {trimmed.slice(0, 200)}&hellip;
      </span>
    );
  }

  return <span className="text-sm">{trimmed}</span>;
}

interface PageProps {
  params: Promise<{ recordType: string; recordId: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const rawParams = await params;
  const recordType = decodeURIComponent(rawParams.recordType);
  const recordId = decodeURIComponent(rawParams.recordId);

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
    description: `Source check details for ${name ?? recordId} (${formatRecordType(recordType)}).`,
    robots: { index: false },
  };
}

export default async function SourceCheckDetailPage({ params }: PageProps) {
  const rawParams = await params;
  // Next.js may leave URL-encoded characters (e.g. %3A for :) in dynamic
  // route params. Decode them so the wiki-server API receives the actual
  // recordId (e.g. "page:1day-sooner:fn3" instead of "page%3A1day-sooner%3Afn3").
  const recordType = decodeURIComponent(rawParams.recordType);
  const recordId = decodeURIComponent(rawParams.recordId);

  // Map recordType back to source table name for record-lookup API
  const RECORD_TYPE_TO_TABLE: Record<string, string> = {
    grant: "grants", personnel: "personnel", division: "divisions",
    investment: "investments", "funding-round": "funding_rounds",
    "funding-program": "funding_programs", publication: "publications",
    "wiki-page": "wiki_pages", "policy-stakeholder": "policy_stakeholders",
    citation: "citation_quotes",
  };
  const sourceTable = RECORD_TYPE_TO_TABLE[recordType] ?? recordType.replace(/-/g, "_") + "s";

  // Fetch detail (verdicts + evidence), names, and the actual DB record in parallel
  const [detailResult, namesResult, recordResult] = await Promise.all([
    fetchDetailed<RpcSourceCheckDetailResult>(
      `/api/source-checks/verdicts/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}`,
      { revalidate: 3600 }
    ),
    fetchDetailed<RpcSourceChecksResolveNamesResult>(
      `/api/source-checks/resolve-names?record_type=${encodeURIComponent(recordType)}&record_ids=${encodeURIComponent(recordId)}`,
      { revalidate: 3600 }
    ),
    fetchDetailed<{ record: Record<string, unknown>; displayNames: Record<string, { title: string }> }>(
      `/api/record-lookup/${encodeURIComponent(sourceTable)}/${encodeURIComponent(recordId)}`,
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
        </div>
        <h1 className="text-2xl font-bold mb-1">
          {claimSummary ?? displayName}
        </h1>
        {claimSummary && resolvedName && resolvedName !== claimSummary && (
          <p className="text-sm text-muted-foreground mb-2">{resolvedName}</p>
        )}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {/* Things page link — only for record types with PG primary keys (not facts or citations) */}
          {!recordType.startsWith("fact") && !recordType.startsWith("citation") && !recordType.includes("wiki-page") && (
            <Link href={`/things/${encodeURIComponent(recordId)}`} className="text-primary hover:underline">
              View record &rarr;
            </Link>
          )}
          {recordHref && !recordHref.startsWith("/things/") && (
            <Link href={recordHref} className="text-primary hover:underline">
              {recordType === "personnel"
                ? "People directory"
                : recordType === "fact"
                  ? "View fact"
                  : `View ${formatRecordType(recordType).toLowerCase()}`} &rarr;
            </Link>
          )}
          {entityHref && (
            <Link href={entityHref} className="text-primary hover:underline">
              {recordType === "personnel"
                ? "Organization page"
                : recordType === "division"
                  ? "Parent organization"
                  : claimEntityName
                    ? `${claimEntityName} page`
                    : "Profile page"} &rarr;
            </Link>
          )}
        </div>
      </div>

      {/* What's being checked — show our database record */}
      {(() => {
        const isHolistic = verdicts.every((v) => v.fieldName === null);
        const dbRecord = recordResult.ok ? recordResult.data.record : null;
        // Fields to skip — internal IDs, timestamps, and metadata
        const skipFields = new Set([
          "id", "createdAt", "updatedAt", "syncedAt", "sourceId",
          "organizationId", "orgEntityId", "granteeId", "programId",
          "entityId", "parentThingId", "stableId", "wikiId",
        ]);

        // Filter to meaningful display fields
        const displayFields = dbRecord
          ? Object.entries(dbRecord).filter(
              ([k, v]) => v != null && v !== "" && !skipFields.has(k)
            )
          : [];

        return (
          <div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-3 mb-6 text-sm">
            <p className="text-muted-foreground mb-2">
              {isHolistic ? "Holistic verification" : "Field-level verification"} &mdash;{" "}
              {isHolistic
                ? `checking the entire ${formatRecordType(recordType).toLowerCase()} record against its original source.`
                : `checking specific fields of this ${formatRecordType(recordType).toLowerCase()} record.`}
            </p>
            {displayFields.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground transition-colors select-none">
                  Our database record ({displayFields.length} fields)
                </summary>
                <div className="mt-2 rounded-md border border-border/30 bg-background px-3 py-2">
                  <table className="w-full text-sm">
                    <tbody>
                      {displayFields.slice(0, 12).map(([k, v]) => (
                        <tr key={k} className="border-b border-border/20 last:border-0">
                          <td className="pr-3 py-0.5 text-muted-foreground whitespace-nowrap align-top text-xs font-medium">
                            {k}
                          </td>
                          <td className="py-0.5 text-foreground/80 break-all">
                            {typeof v === "number"
                              ? v.toLocaleString("en-US")
                              : String(v).length > 150
                                ? String(v).slice(0, 150) + "\u2026"
                                : String(v)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {displayFields.length > 12 && (
                    <div className="text-xs text-muted-foreground mt-1">
                      +{displayFields.length - 12} more fields
                    </div>
                  )}
                </div>
              </details>
            )}
          </div>
        );
      })()}

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
                  <p className="text-sm text-muted-foreground">{stripInternalTags(v.reasoning)}</p>
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
            // Key on field + entity + verdict + values + notes to avoid collapsing distinct field checks
            const dedupeKey = [
              c.fieldName ?? "",
              c.entityId ?? "",
              c.verdict,
              c.expectedValue ?? "",
              c.extractedValue ?? "",
              (c.notes ?? "").slice(0, 100),
            ].join("::");
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
            <h2 className="text-sm font-medium text-muted-foreground mb-4">
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
                      {(() => {
                        const ds = inferDataSource(sourceUrl);
                        // Resource ID: prefer from evidence, fall back to data source pattern
                        const rid = checks.find((c) => c.resourceId)?.resourceId ?? ds?.resourceId;
                        return (
                          <>
                            {ds && (
                              <Link
                                href={`/sources?tab=data-sources`}
                                className="inline-flex items-center gap-1 ml-2 px-2 py-0.5 rounded-full text-[10px] font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 hover:underline"
                              >
                                {ds.name}
                              </Link>
                            )}
                            {rid && (
                              <Link
                                href={`/resources/${encodeURIComponent(rid)}`}
                                className="inline-flex items-center gap-1 ml-2 text-xs text-primary hover:underline"
                              >
                                <Database className="h-3 w-3" />
                                Resource
                              </Link>
                            )}
                          </>
                        );
                      })()}
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

                        {/* Matched data — show extractedQuote as structured key-value pairs if JSON */}
                        {e.extractedQuote && (
                          <FormatQuote quote={e.extractedQuote} />
                        )}

                        {/* Expected vs Found — only show if not already covered by the quote */}
                        {(e.expectedValue || e.extractedValue) && !e.extractedQuote && (
                          <div className="space-y-2 mb-2">
                            {e.expectedValue && (
                              <div className="text-sm">
                                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Expected: </span>
                                {e.expectedValue}
                              </div>
                            )}
                            {e.extractedValue && (
                              <div>
                                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1">Matched data</div>
                                <FormatExtractedValue value={e.extractedValue} />
                              </div>
                            )}
                          </div>
                        )}

                        {/* Notes */}
                        {e.notes && (
                          <p className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground/70">Note:</span> {stripInternalTags(e.notes)}
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
      <details className="text-xs text-muted-foreground border-t border-border pt-4 mt-8">
        <summary className="cursor-pointer hover:text-foreground transition-colors">
          Debug info
        </summary>
        <div className="mt-2 space-y-0.5">
          <p>Record type: <code className="text-[11px] bg-muted px-1 py-0.5 rounded">{recordType}</code></p>
          <p>Record ID: <code className="text-[11px] bg-muted px-1 py-0.5 rounded">{recordId}</code></p>
        </div>
      </details>
    </div>
  );
}
