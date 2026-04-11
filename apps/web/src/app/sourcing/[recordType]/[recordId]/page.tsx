import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Database, ExternalLink } from "lucide-react";
import {
  fetchDetailed,
} from "@/lib/wiki-server";
import type {
  RpcSourcingDetailResult,
  RpcSourcingResolveNamesResult,
} from "@/lib/wiki-server";
import {
  VerdictBadge,
  formatRecordType,
  getRecordHref,
  formatCheckerModel,
  humanizeFieldLabel,
} from "../../sourcing-shared";
import { getEntityHref } from "@data/entity-nav";
import { getKBFactById, getKBEntity, getKBProperty } from "@/data/factbase";
import { inferDataSource } from "@/app/grants/grants-data-source";
import { formatKBFactValue } from "@/components/wiki/factbase/format";

export const revalidate = 3600;
export const dynamicParams = true;

/** Known internal machine-readable tags that appear as leading prefixes in reasoning/notes
 *  text written by sourcing pipelines. Restricted to a closed set so that legitimate
 *  bracketed content inside the body (e.g. "[USD]", "[2024]") is preserved. */
const INTERNAL_TAG_NAMES = [
  "deterministic-row-match",
  "dead_link",
  "archive",
  "skip",
] as const;
const INTERNAL_TAG_PREFIX_RE = new RegExp(
  `^(?:\\[(?:${INTERNAL_TAG_NAMES.join("|")})(?:[^\\]]*)?\\]\\s*)+`
);

/** Strip known internal machine-readable tags (e.g. [deterministic-row-match]) from the
 *  start of user-visible text. Only leading tags are stripped; bracketed content elsewhere
 *  in the string is preserved. */
function stripInternalTags(text: string): string {
  return text.replace(INTERNAL_TAG_PREFIX_RE, "").trim();
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
  const namesResult = await fetchDetailed<RpcSourcingResolveNamesResult>(
    `/api/sourcing/resolve-names?record_type=${encodeURIComponent(recordType)}&record_ids=${encodeURIComponent(recordId)}`,
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

export default async function SourcingDetailPage({ params }: PageProps) {
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
    fetchDetailed<RpcSourcingDetailResult>(
      `/api/sourcing/verdicts/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}`,
      { revalidate: 3600 }
    ),
    fetchDetailed<RpcSourcingResolveNamesResult>(
      `/api/sourcing/resolve-names?record_type=${encodeURIComponent(recordType)}&record_ids=${encodeURIComponent(recordId)}`,
      { revalidate: 3600 }
    ),
    fetchDetailed<{
      record: Record<string, unknown>;
      displayNames: Record<string, { title: string; slug?: string; entityType?: string }>;
    }>(
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
          href="/sourcing"
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

  // Compute claim/record data for the side-by-side layout
  const isHolistic = verdicts.every((v) => v.fieldName === null);
  const dbRecord = recordResult.ok ? recordResult.data.record : null;
  const recordDisplayNames = recordResult.ok ? recordResult.data.displayNames : {};
  const skipFields = new Set([
    "id", "createdAt", "updatedAt", "syncedAt", "sourceId",
    "organizationId", "orgEntityId", "granteeId", "programId",
    "entityId", "parentThingId", "stableId", "wikiId",
    // Always redundant: personEntityId duplicates personId; sourceResourceId shown in source header
    "personEntityId", "sourceResourceId",
  ]);
  // Per-type extra skip fields
  if (recordType === "grant") {
    skipFields.add("granteeDisplayName"); // redundant with `name` for grants
  }
  let displayFields: [string, unknown][] = dbRecord
    ? Object.entries(dbRecord).filter(
        ([k, v]) => v != null && v !== "" && !skipFields.has(k)
      )
    : [];

  // For facts, populate displayFields from FactBase since record-lookup doesn't cover them
  if (recordType === "fact" && displayFields.length === 0) {
    const fact = getKBFactById(recordId);
    if (fact) {
      const entity = getKBEntity(fact.subjectId);
      const property = getKBProperty(fact.propertyId);
      const formattedValue = formatKBFactValue(fact, property?.unit, property?.display);
      const fields: [string, unknown][] = [];
      if (entity) fields.push(["subject", entity.name]);
      if (property) fields.push(["property", property.name]);
      fields.push(["value", formattedValue]);
      if (fact.asOf) fields.push(["asOf", fact.asOf]);
      if (fact.validEnd) fields.push(["validEnd", fact.validEnd]);
      if (fact.source) fields.push(["source", fact.source]);
      if (fact.sourceQuote) fields.push(["sourceQuote", fact.sourceQuote]);
      if (fact.notes) fields.push(["notes", fact.notes]);
      if (fact.currency) fields.push(["currency", fact.currency]);
      if (fact.usdEquivalent != null) fields.push(["usdEquivalent", fact.usdEquivalent]);
      displayFields = fields;
    }
  }

  // Build a supplemental sid-resolution map from FactBase for cases where
  // recordDisplayNames (from record-lookup) is empty (e.g. facts).
  // Scan displayFields for comma-separated sid lists and resolve each via getKBEntity.
  const factbaseSidNames: Record<string, { title: string }> = {};
  for (const [, v] of displayFields) {
    if (typeof v !== "string") continue;
    const parts = v.split(",").map((s) => s.trim());
    for (const part of parts) {
      if (/^sid_[a-zA-Z0-9]+$/.test(part) && !recordDisplayNames[part]) {
        const kbEntity = getKBEntity(part);
        if (kbEntity?.name) {
          factbaseSidNames[part] = { title: kbEntity.name };
        }
      }
    }
  }
  // Merge factbase resolutions into recordDisplayNames (recordDisplayNames takes precedence)
  const allDisplayNames: Record<string, { title: string; slug?: string; entityType?: string }> = {
    ...factbaseSidNames,
    ...recordDisplayNames,
  };

  // Group evidence by source URL for the right column
  const evidenceBySource = new Map<string, typeof evidence>();
  for (const e of evidence) {
    const key = e.sourceUrl || "(no source)";
    const group = evidenceBySource.get(key);
    if (group) group.push(e);
    else evidenceBySource.set(key, [e]);
  }

  // Deduplicate within each source group
  type DeduplicatedCheck = (typeof evidence)[number] & { duplicateCount: number };
  function deduplicateChecks(checks: typeof evidence): DeduplicatedCheck[] {
    const seen = new Map<string, DeduplicatedCheck>();
    for (const c of checks) {
      const dedupeKey = [
        c.fieldName ?? "",
        c.entityId ?? "",
        c.verdict,
        c.expectedValue ?? "",
        c.extractedValue ?? "",
        c.extractedQuote ?? "",
        (c.notes ?? "").slice(0, 100),
      ].join("::");
      const existing = seen.get(dedupeKey);
      if (existing) {
        existing.duplicateCount++;
        if (c.checkedAt && existing.checkedAt && c.checkedAt > existing.checkedAt) {
          seen.set(dedupeKey, { ...c, duplicateCount: existing.duplicateCount });
        }
      } else {
        seen.set(dedupeKey, { ...c, duplicateCount: 1 });
      }
    }
    return [...seen.values()];
  }

  // Get the verdict for the case-header treatment
  const primaryVerdict = verdicts[0];
  const primaryConfidence = primaryVerdict?.confidence ?? null;

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      {/* Breadcrumbs */}
      <Link
        href="/sourcing"
        className="inline-flex items-center gap-1.5 text-xs uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground transition-colors mb-8"
      >
        <ArrowLeft className="w-3 h-3" />
        Index
      </Link>

      {/* Editorial header — compact masthead */}
      <header className="mb-8 pb-5 border-b border-foreground/15">
        {/* Eyebrow: type · id · cross-references */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3 text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-mono">
          <span>{formatRecordType(recordType)}</span>
          <span className="text-foreground/30">·</span>
          <span>{recordId}</span>
          {!recordType.startsWith("fact") && !recordType.startsWith("citation") && !recordType.includes("wiki-page") && (
            <>
              <span className="text-foreground/30">·</span>
              <Link
                href={`/things/${encodeURIComponent(recordId)}`}
                className="hover:text-foreground transition-colors border-b border-dotted border-foreground/30 hover:border-foreground"
              >
                Record
              </Link>
            </>
          )}
          {recordHref && !recordHref.startsWith("/things/") && (
            <>
              <span className="text-foreground/30">·</span>
              <Link
                href={recordHref}
                className="hover:text-foreground transition-colors border-b border-dotted border-foreground/30 hover:border-foreground"
              >
                {recordType === "personnel" ? "People" : recordType === "fact" ? "Fact" : formatRecordType(recordType)}
              </Link>
            </>
          )}
          {entityHref && (
            <>
              <span className="text-foreground/30">·</span>
              <Link
                href={entityHref}
                className="hover:text-foreground transition-colors border-b border-dotted border-foreground/30 hover:border-foreground"
              >
                {recordType === "personnel"
                  ? "Organization"
                  : recordType === "division"
                    ? "Parent"
                    : claimEntityName ?? "Profile"}
              </Link>
            </>
          )}
        </div>

        {/* Title */}
        <h1 className="text-2xl font-bold leading-tight tracking-tight text-foreground">
          {(claimSummary ?? displayName).replace(/\s*->\s*/g, " → ")}
        </h1>

        {/* Subtitle — only when meaningfully different and not a truncated stub */}
        {claimSummary &&
          resolvedName &&
          resolvedName !== claimSummary &&
          resolvedName.length > 6 &&
          !claimSummary.includes(resolvedName) && (
            <p className="text-sm text-muted-foreground mt-1">
              {resolvedName}
            </p>
          )}
      </header>

      {/* Verdict — editorial treatment, like a verdict in a court ruling */}
      {verdicts.length > 0 ? (
        <div className="space-y-3 mb-10">
          {verdicts.map((v, i) => {
            const fieldEvidence = evidence.filter(
              (e) => (e.fieldName ?? null) === (v.fieldName ?? null)
            );
            const fieldUniqueUrls = new Set(
              fieldEvidence.filter((e) => e.sourceUrl).map((e) => e.sourceUrl)
            );
            const verdictColor =
              v.verdict === "confirmed" ? "text-emerald-700 dark:text-emerald-400"
              : v.verdict === "contradicted" ? "text-red-700 dark:text-red-400"
              : v.verdict === "outdated" ? "text-amber-700 dark:text-amber-400"
              : v.verdict === "partial" ? "text-amber-700 dark:text-amber-400"
              : "text-muted-foreground";

            // Detect cross-check disagreement: multiple distinct verdict values in evidence
            const evidenceVerdicts = fieldEvidence.map((e) => e.verdict);
            const uniqueEvidenceVerdicts = [...new Set(evidenceVerdicts)];
            const hasDisagreement = uniqueEvidenceVerdicts.length > 1;
            const disagreementCounts = uniqueEvidenceVerdicts.map(
              (ev) => `${evidenceVerdicts.filter((x) => x === ev).length} ${ev}`
            );

            return (
              <div
                key={`${v.fieldName ?? "overall"}-${i}`}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1"
              >
                <div className="flex items-baseline gap-3">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono">
                    Verdict
                  </span>
                  <span className={`text-xl font-semibold tracking-tight ${verdictColor}`}>
                    {v.verdict}
                  </span>
                  {v.confidence != null && (
                    <span
                      className="text-sm tabular-nums text-foreground/70"
                    >
                      {Math.round(v.confidence * 100)}%
                    </span>
                  )}
                </div>
                {v.fieldName && (
                  <span
                    className="text-xs text-muted-foreground"
                  >
                    field: {v.fieldName}
                  </span>
                )}
                <span className="ml-auto text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-mono">
                  {fieldEvidence.length > 0 && (
                    <>
                      {fieldEvidence.length} check{fieldEvidence.length !== 1 ? "s" : ""}
                      {fieldUniqueUrls.size > 0 && fieldUniqueUrls.size !== fieldEvidence.length && (
                        <> · {fieldUniqueUrls.size} src</>
                      )}
                    </>
                  )}
                  {v.lastComputedAt && (
                    <> · {new Date(v.lastComputedAt).toLocaleDateString()}</>
                  )}
                  {v.needsRecheck && (
                    <> · <span className="text-amber-600 font-semibold">recheck</span></>
                  )}
                </span>
                {hasDisagreement && (
                  <div className="basis-full mt-1">
                    <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded px-2 py-0.5">
                      ⚠ Checks disagree: {disagreementCounts.join(", ")}
                    </span>
                  </div>
                )}
                {v.reasoning && (
                  <p
                    className="basis-full text-sm text-muted-foreground italic leading-relaxed mt-1"
                  >
                    {stripInternalTags(v.reasoning)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mb-10 text-sm text-muted-foreground italic">
          No verdict on file.
        </div>
      )}

      {/* Audit ledger: claim vs evidence with vertical rule between */}
      <div className="grid grid-cols-1 lg:grid-cols-2 lg:divide-x lg:divide-foreground/15 mb-12 min-w-0">
        {/* Left column: Our claim */}
        <section className="lg:pr-8 pb-8 lg:pb-0 min-w-0">
          <div className="flex items-baseline justify-between mb-5">
            <h2 className="text-base font-semibold tracking-tight">
              Our claim
            </h2>
            <span className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-mono">
              {isHolistic ? "entire record" : "specific fields"}
            </span>
          </div>
          {displayFields.length > 0 ? (
            <dl className="space-y-3.5">
              {displayFields.map(([k, v]) => {
                const strV = typeof v === "string" ? v : String(v);
                const isLongText = typeof v === "string" && v.length > 300;

                // Multi-sid: comma-separated list of sid_ IDs
                const multiSidMatch = typeof v === "string"
                  ? v.split(",").map((s) => s.trim()).filter((s) => /^sid_[a-zA-Z0-9]+$/.test(s))
                  : [];
                const isMultiSid = multiSidMatch.length > 1;

                // Single sid
                const looksLikeId = !isMultiSid && typeof v === "string" && /^sid_[a-zA-Z0-9]+$/.test(v);
                const resolvedIdEntry = looksLikeId ? allDisplayNames[strV] : null;

                // Currency formatting: keys "amount" or "usdEquivalent" with numeric string
                const isCurrencyKey = k === "amount" || k === "usdEquivalent";
                const numericVal = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
                const isCurrencyVal = isCurrencyKey && !isNaN(numericVal) && isFinite(numericVal);
                const currencyCode = isCurrencyVal
                  ? (k === "usdEquivalent" ? "USD" : (typeof dbRecord?.["currency"] === "string" ? dbRecord["currency"] : "USD"))
                  : null;

                // Date formatting
                const fullDateMatch = typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
                const partialDateMatch = typeof v === "string" && /^\d{4}-\d{2}$/.test(v);

                // URL detection
                const isUrl = typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://"));

                // Boolean
                const isBoolVal = typeof v === "boolean" || strV === "true" || strV === "false";

                return (
                  <div key={k} className="grid grid-cols-[6rem_1fr] gap-3 text-sm min-w-0">
                    <dt className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground pt-0.5 font-mono break-all">
                      {humanizeFieldLabel(k)}
                    </dt>
                    <dd className="text-foreground/90 break-words whitespace-pre-wrap leading-relaxed min-w-0">
                      {isCurrencyVal ? (
                        <span>
                          {new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency: currencyCode ?? "USD",
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 0,
                          }).format(numericVal)}
                        </span>
                      ) : isBoolVal ? (
                        <span>{(v === true || strV === "true") ? "Yes" : "No"}</span>
                      ) : isMultiSid ? (
                        <span>
                          {multiSidMatch.map((sid, idx) => {
                            const entry = allDisplayNames[sid];
                            return (
                              <span key={sid}>
                                {idx > 0 && ", "}
                                {entry ? (
                                  <Link
                                    href={`/things/${encodeURIComponent(sid)}`}
                                    className="text-primary hover:underline"
                                    title={sid}
                                  >
                                    {entry.title}
                                  </Link>
                                ) : (
                                  <span className="font-mono text-xs">{sid}</span>
                                )}
                              </span>
                            );
                          })}
                        </span>
                      ) : resolvedIdEntry ? (
                        <Link
                          href={`/things/${encodeURIComponent(strV)}`}
                          className="text-primary hover:underline"
                          title={strV}
                        >
                          {resolvedIdEntry.title}
                        </Link>
                      ) : isUrl ? (
                        <a
                          href={strV}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline break-all"
                          title={strV}
                        >
                          {strV.length > 80 ? strV.slice(0, 80) + "…" : strV}
                        </a>
                      ) : partialDateMatch ? (
                        <span>
                          {new Date(strV + "-01").toLocaleDateString("en-US", { year: "numeric", month: "long" })}
                        </span>
                      ) : fullDateMatch ? (
                        <span>
                          {new Date(strV).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                        </span>
                      ) : typeof v === "number" ? (
                        v.toLocaleString("en-US")
                      ) : isLongText ? (
                        <details>
                          <summary className="cursor-pointer list-none">
                            <span>{stripInternalTags(strV).slice(0, 280)}</span>
                            <span className="text-muted-foreground">… </span>
                            <span className="text-xs uppercase tracking-[0.1em] text-foreground/60 hover:text-foreground border-b border-dotted border-foreground/30">
                              expand
                            </span>
                          </summary>
                          <span className="block mt-2">{stripInternalTags(strV).replace(/\[ref\][^\[]*\[\/ref\]/g, "")}</span>
                        </details>
                      ) : looksLikeId ? (
                        <span className="font-mono text-xs">{strV}</span>
                      ) : (
                        stripInternalTags(strV).replace(/\[ref\][^\[]*\[\/ref\]/g, "")
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : (
            <p
              className="text-sm text-muted-foreground italic"
            >
              No record data available.
            </p>
          )}
        </section>

        {/* Right column: Source evidence */}
        <section className="lg:pl-8 pt-8 lg:pt-0 border-t lg:border-t-0 border-foreground/15 min-w-0">
          <div className="flex items-baseline justify-between mb-5">
            <h2 className="text-base font-semibold tracking-tight">
              Source evidence
            </h2>
            <span className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-mono">
              {uniqueSourceUrls.size} src · {evidence.length} check{evidence.length !== 1 ? "s" : ""}
            </span>
          </div>
          {evidence.length === 0 ? (
            <p
              className="text-sm text-muted-foreground italic"
            >
              No evidence on file.
            </p>
          ) : (
            <div className="space-y-6">
              {[...evidenceBySource.entries()].map(([sourceUrl, checks], srcIdx) => (
                <div key={sourceUrl} className={srcIdx > 0 ? "pt-6 border-t border-foreground/10" : ""}>
                  {/* Source citation — like a footnote reference */}
                  {sourceUrl !== "(no source)" && (
                    <div className="mb-3 text-xs">
                      <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-baseline gap-1.5 text-foreground/80 hover:text-foreground border-b border-dotted border-foreground/40 hover:border-foreground break-all font-mono"
                      >
                        {(() => { try { return new URL(sourceUrl).hostname + new URL(sourceUrl).pathname; } catch { return sourceUrl; } })()}
                        <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                      </a>
                      {(() => {
                        // inferDataSource() is grant-specific — only use its resourceId fallback
                        // on grant record pages to avoid leaking grant resources into other types.
                        const ds = recordType === "grant" ? inferDataSource(sourceUrl) : null;
                        const rid =
                          checks.find((c) => c.resourceId)?.resourceId ??
                          (recordType === "grant" ? ds?.resourceId : undefined);
                        return (
                          <>
                            {ds && (
                              <Link
                                href={`/sources?tab=data-sources`}
                                className="inline-block ml-3 text-[10px] uppercase tracking-[0.15em] text-foreground/60 hover:text-foreground font-mono"
                              >
                                {ds.name}
                              </Link>
                            )}
                            {rid && (
                              <Link
                                href={`/resources/${encodeURIComponent(rid)}`}
                                className="inline-flex items-center gap-1 ml-3 text-[10px] uppercase tracking-[0.1em] text-foreground/60 hover:text-foreground font-mono"
                              >
                                <Database className="h-2.5 w-2.5" />
                                resource
                              </Link>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {/* Individual checks */}
                  <div className="space-y-5">
                    {deduplicateChecks(checks).map((e) => {
                      const evVerdictColor =
                        e.verdict === "confirmed" ? "text-emerald-700 dark:text-emerald-400"
                        : e.verdict === "contradicted" ? "text-red-700 dark:text-red-400"
                        : "text-amber-700 dark:text-amber-400";

                      // Try to parse extracted value/quote as structured data for display
                      const structuredEntries = (() => {
                        const text = (e.extractedQuote || e.extractedValue || "").trim();
                        if (!text) return null;
                        const stripped = text.replace(/^(?:Matched row|Found row|Row match)[:\s]*/i, "").trim();
                        return parseJsonObjectEntries(stripped);
                      })();

                      return (
                        <div key={e.id}>
                          {/* Inline verdict line */}
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
                            <span className={`text-sm font-semibold ${evVerdictColor}`}>
                              {e.verdict}
                            </span>
                            {e.confidence != null && (
                              <span className="text-xs tabular-nums text-muted-foreground font-mono">
                                {Math.round(e.confidence * 100)}%
                              </span>
                            )}
                            {e.isPrimarySource && (
                              <span className="text-[10px] uppercase tracking-[0.15em] text-blue-700 dark:text-blue-400 font-mono">
                                primary
                              </span>
                            )}
                            {e.duplicateCount > 1 && (
                              <span className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-mono">
                                ×{e.duplicateCount}
                              </span>
                            )}
                            <span className="ml-auto text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-mono">
                              {e.checkerModel && formatCheckerModel(e.checkerModel)}
                              {e.checkedAt && <> · {new Date(e.checkedAt).toLocaleDateString()}</>}
                            </span>
                          </div>

                          {/* Contradicted diff: show expected vs extracted side-by-side */}
                          {e.verdict === "contradicted" && e.expectedValue && e.extractedValue && !structuredEntries && (
                            <div className="mb-3 pl-3 border-l-2 border-red-400/60 space-y-1 text-sm">
                              <div className="flex gap-2">
                                <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-mono w-14 shrink-0 pt-0.5">Claimed</span>
                                <span className="text-foreground/90">{e.expectedValue}</span>
                              </div>
                              <div className="flex gap-2">
                                <span className="text-[10px] uppercase tracking-[0.12em] text-red-600 dark:text-red-400 font-mono w-14 shrink-0 pt-0.5">Found</span>
                                <span className="text-red-700 dark:text-red-300 font-medium">{e.extractedValue}</span>
                              </div>
                            </div>
                          )}

                          {/* Matched data — render as dl matching the claim style */}
                          {structuredEntries && structuredEntries.length > 0 && (
                            <dl className="space-y-2 mb-3 pl-3 border-l border-foreground/15 min-w-0">
                              {structuredEntries.slice(0, 8).map(([k, val]) => (
                                <div key={k} className="grid grid-cols-[6rem_1fr] gap-3 text-sm min-w-0">
                                  <dt className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground pt-0.5 font-mono break-all">
                                    {humanizeFieldLabel(k)}
                                  </dt>
                                  <dd className="text-foreground/90 break-words min-w-0">
                                    {formatJsonValue(val)}
                                  </dd>
                                </div>
                              ))}
                              {structuredEntries.length > 8 && (
                                <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground font-mono">
                                  +{structuredEntries.length - 8} more
                                </div>
                              )}
                            </dl>
                          )}

                          {/* Fallback: extracted quote as a blockquote */}
                          {!structuredEntries && e.extractedQuote && (
                            <blockquote
                              className="border-l-2 border-foreground/30 pl-4 my-2 text-sm italic text-foreground/80 leading-relaxed"
                            >
                              {e.extractedQuote}
                            </blockquote>
                          )}

                          {/* Note */}
                          {e.notes && (
                            <p
                              className="text-sm text-muted-foreground leading-relaxed mt-2"
                            >
                              <span
                                className="text-[10px] uppercase tracking-[0.12em] text-foreground/60 mr-2 not-italic"
                              >
                                Note
                              </span>
                              {stripInternalTags(e.notes)}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Editorial colophon — case number footer */}
      <div
        className="pt-6 border-t border-foreground/15 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70 flex flex-wrap items-baseline gap-x-4 gap-y-1"
      >
        <span>Case № {recordId}</span>
        {primaryVerdict?.lastComputedAt && (
          <span>Filed {new Date(primaryVerdict.lastComputedAt).toLocaleDateString()}</span>
        )}
        {primaryConfidence != null && (
          <span>Confidence {Math.round(primaryConfidence * 100)}%</span>
        )}
      </div>

    </div>
  );
}
