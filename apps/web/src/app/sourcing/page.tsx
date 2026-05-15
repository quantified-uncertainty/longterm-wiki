import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import {
  fetchDetailed,
} from "@/lib/wiki-server";
import type {
  RpcSourcingStatsResult,
  RpcSourcingVerdictsResult,
  RpcSourcingResolveNamesResult,
} from "@/lib/wiki-server";
import { getTypedEntityByStableId, getIdRegistry } from "@/data/tablebase";
import { getKBFactById, getKBEntity, getKBProperty } from "@/data/factbase";
import { formatKBFactValue } from "@/components/wiki/factbase/format";
import { SourcingTable } from "./sourcing-table";
import { SourcingSearch } from "./sourcing-filter";
import {
  VERDICT_STYLES,
  PAGE_SIZE,
  buildFilterUrl,
  formatRecordType,
} from "./sourcing-shared";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Source Checks",
  description:
    "Directory of source checks across wiki data, including personnel records, grants, divisions, and more.",
  robots: { index: false },
};

// Revalidate every 5 minutes
export const revalidate = 300;

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const val = searchParams[key];
  return typeof val === "string" ? val : undefined;
}

export default async function SourcingPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const filterType = getParam(sp, "type") ?? "all";
  const filterVerdict = getParam(sp, "verdict") ?? "all";
  const searchQuery = getParam(sp, "q") ?? "";
  const pageNum = Math.max(1, parseInt(getParam(sp, "page") ?? "1", 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  // Build API query params for verdicts
  const verdictParams = new URLSearchParams();
  if (filterType !== "all") verdictParams.set("record_type", filterType);
  if (filterVerdict !== "all") verdictParams.set("verdict", filterVerdict);
  if (searchQuery) verdictParams.set("q", searchQuery);
  verdictParams.set("limit", String(PAGE_SIZE));
  verdictParams.set("offset", String(offset));

  // Build stats URL — pass record_type when a type filter is active so that
  // the stat cards and verdict-pill counts reflect the selected type.
  const statsParams = new URLSearchParams();
  if (filterType !== "all") statsParams.set("record_type", filterType);
  const statsQs = statsParams.toString();
  const statsUrl = statsQs
    ? `/api/sourcing/stats?${statsQs}`
    : "/api/sourcing/stats";

  // Fetch global stats (for type tabs), filtered stats (for cards + verdict tabs), and verdicts
  const [globalStatsResult, filteredStatsResult, verdictsResult] =
    await Promise.all([
      // Always fetch unfiltered stats for the type-filter tab counts
      fetchDetailed<RpcSourcingStatsResult>("/api/sourcing/stats", {
        revalidate: 300,
      }),
      // Fetch type-filtered stats for stat cards + verdict pills
      fetchDetailed<RpcSourcingStatsResult>(statsUrl, {
        revalidate: 300,
      }),
      fetchDetailed<RpcSourcingVerdictsResult>(
        `/api/sourcing/verdicts?${verdictParams.toString()}`,
        { revalidate: 300 }
      ),
    ]);

  // Handle error state
  if (!globalStatsResult.ok || !filteredStatsResult.ok || !verdictsResult.ok) {
    return (
      <div className="max-w-[90rem] mx-auto px-6 py-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-4">
          Source Checks
        </h1>
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

  const globalStats = globalStatsResult.data;
  const filteredStats = filteredStatsResult.data;
  const { verdicts, total } = verdictsResult.data;

  // Resolve names for the current page of verdicts (records + entities)
  let names: Record<string, string> = {};
  const hrefs: Record<string, string> = {};
  if (verdicts.length > 0) {
    // Phase 0: Use persisted display names from verdicts (most reliable, survive record deletion)
    for (const v of verdicts) {
      if (v.displayName) {
        names[v.recordId] = v.displayName;
      }
      if (v.entityDisplayName && v.entityId) {
        names[v.entityId] = v.entityDisplayName;
      }
    }

    // Group record IDs by type for batch resolution via wiki-server
    const byType = new Map<string, Set<string>>();
    const entityIds = new Set<string>();
    for (const v of verdicts) {
      if (!names[v.recordId]) {
        const existing = byType.get(v.recordType);
        if (existing) {
          existing.add(v.recordId);
        } else {
          byType.set(v.recordType, new Set([v.recordId]));
        }
      }
      if (v.entityId) {
        entityIds.add(v.entityId);
      }
    }

    // Resolve record names via wiki-server
    const nameResults = await Promise.all(
      [...byType.entries()].map(async ([recordType, ids]) => {
        const idList = [...ids].join(",");
        const result = await fetchDetailed<RpcSourcingResolveNamesResult>(
          `/api/sourcing/resolve-names?record_type=${encodeURIComponent(recordType)}&record_ids=${encodeURIComponent(idList)}`,
          { revalidate: 300 }
        );
        return result.ok ? result.data.names : {};
      })
    );
    for (const nameMap of nameResults) {
      names = { ...names, ...nameMap };
    }

    // Local FactBase fallback for fact names not resolved by wiki-server
    const factIds = byType.get("fact");
    if (factIds) {
      for (const factId of factIds) {
        if (!names[factId]) {
          const fact = getKBFactById(factId);
          if (fact) {
            const entity = getKBEntity(fact.subjectId);
            const property = getKBProperty(fact.propertyId);
            names[factId] = `${entity?.name ?? fact.subjectId} — ${property?.name ?? fact.propertyId}`;
          }
        }
      }
    }

    // Strip "new:" prefix from display names (artefact of record creation)
    // Also strip type-prefix pattern "TypeName: ..." (e.g. "Personnel: Josh Batson at Anthropic")
    // since the Type column already shows the record type.
    const TYPE_PREFIX_RE = /^[A-Z][A-Za-z -]+:\s+/;
    for (const [key, value] of Object.entries(names)) {
      let cleaned = value;
      if (cleaned.startsWith("new:")) {
        cleaned = cleaned.slice(4);
      }
      // Strip type prefix like "Personnel: " / "Grant: " / "Fact: " from record names.
      // Only strip if the key is NOT an entity stableId (entity names should be preserved).
      if (!key.startsWith("sid_") && TYPE_PREFIX_RE.test(cleaned)) {
        cleaned = cleaned.replace(TYPE_PREFIX_RE, "");
      }
      names[key] = cleaned;
    }

    // Resolve fact names locally from FactBase as fallback (wiki-server may not
    // have the resolve-names endpoint deployed yet)
    for (const v of verdicts) {
      if (v.recordType === "fact" && !names[v.recordId]) {
        const fact = getKBFactById(v.recordId);
        if (fact) {
          const property = getKBProperty(fact.propertyId);
          const entity = getKBEntity(fact.subjectId);
          const propertyName = property?.name ?? fact.propertyId;
          const entityName = entity?.name ?? fact.subjectId;
          names[v.recordId] = `${entityName} — ${propertyName}`;
        }
      }
    }

    // Resolve entity names + hrefs locally from database.json (fast, no roundtrip)
    if (entityIds.size > 0) {
      const registry = getIdRegistry();
      for (const stableId of entityIds) {
        const entity = getTypedEntityByStableId(stableId);
        if (entity) {
          names[stableId] = entity.title;
          const wikiId = registry.bySlug[entity.id];
          if (wikiId) {
            hrefs[stableId] = `/wiki/${wikiId}`;
          }
        }
      }
    }
  }

  // Build claim summaries for each verdict
  // Key: `${recordType}:${recordId}:${fieldName ?? ""}` (matches table row key)
  const claims: Record<string, string> = {};
  for (const v of verdicts) {
    const key = `${v.recordType}:${v.recordId}:${v.fieldName ?? ""}`;
    if (v.recordType === "fact") {
      const fact = getKBFactById(v.recordId);
      if (fact) {
        const property = getKBProperty(fact.propertyId);
        const propertyName = property?.name ?? fact.propertyId;
        const formattedValue = formatKBFactValue(fact, property?.unit, property?.display);
        claims[key] = `${propertyName} = ${formattedValue}`;
      } else if (v.fieldName) {
        claims[key] = v.fieldName;
      }
    } else if (v.fieldName) {
      // For non-fact record types, show the field name as the claim
      claims[key] = v.fieldName;
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Data quality breakdown from verdict counts
  const bv = filteredStats.by_verdict ?? {};
  const confirmedCount = bv.confirmed ?? 0;
  const contradictedCount = bv.contradicted ?? 0;
  const outdatedCount = bv.outdated ?? 0;
  const partialCount = bv.partial ?? 0;
  const unverifiableCount = bv.unverifiable ?? 0;
  const uncheckedCount = bv.unchecked ?? 0;
  const hasIssuesCount = contradictedCount + outdatedCount + partialCount;
  const deadLinkCount = filteredStats.dead_link_count ?? 0;
  const checkedCount = filteredStats.total - uncheckedCount;
  const accuracyDenom = confirmedCount + contradictedCount + outdatedCount;
  const accuracyRate =
    accuracyDenom > 0
      ? Math.round((confirmedCount / accuracyDenom) * 100)
      : null;
  const pctOfChecked = (n: number) =>
    checkedCount > 0 ? `${Math.round((n / checkedCount) * 100)}%` : "—";

  // Type tabs always use global stats (so all types are visible)
  const globalTotal = globalStats.by_type
    ? Object.values(globalStats.by_type).reduce((a, b) => a + b, 0)
    : globalStats.total;
  const typeEntries = Object.entries(globalStats.by_type).sort(
    ([, a], [, b]) => b - a
  );
  // Verdict tabs use filteredStats (contextual to selected type).
  // Ensure "partial" is always present in the verdict filter (2,040+ records use it).
  const byVerdictWithPartial = { ...filteredStats.by_verdict };
  if (!("partial" in byVerdictWithPartial)) {
    byVerdictWithPartial.partial = 0;
  }
  const verdictEntries = Object.entries(byVerdictWithPartial).sort(
    ([, a], [, b]) => b - a
  );

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          All Source Checks
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl mb-2">
          Automated source checking of wiki data against original sources. Each
          record is checked against one or more external sources to confirm
          accuracy.
        </p>
        <Link
          href="/wiki/E2200"
          className="text-xs text-primary hover:underline"
        >
          View internal dashboard with coverage &amp; action queue &rarr;
        </Link>
      </div>

      {/* Row 1 — Data Quality breakdown */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <p className="text-xs text-muted-foreground mb-1">Verified Correct</p>
          <p className="text-2xl font-bold tabular-nums text-emerald-600">
            {confirmedCount.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {pctOfChecked(confirmedCount)} of checked
          </p>
        </div>
        <div
          className={cn(
            "rounded-lg border p-4",
            hasIssuesCount > 0
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-border/60"
          )}
        >
          <p className="text-xs text-muted-foreground mb-1">Has Issues</p>
          <p
            className={cn(
              "text-2xl font-bold tabular-nums",
              hasIssuesCount > 0 && "text-amber-600"
            )}
          >
            {hasIssuesCount.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {pctOfChecked(hasIssuesCount)} of checked
          </p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Can&apos;t Verify</p>
          <p className="text-2xl font-bold tabular-nums text-red-600">
            {unverifiableCount.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {pctOfChecked(unverifiableCount)} of checked
            {deadLinkCount > 0 && (
              <span className="block text-[10px] mt-0.5">
                incl. {deadLinkCount.toLocaleString()} dead links
              </span>
            )}
          </p>
        </div>
        <div className="rounded-lg border border-dashed border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Not Yet Checked</p>
          <p className="text-2xl font-bold tabular-nums text-muted-foreground">
            {uncheckedCount.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            of {filteredStats.total.toLocaleString()} total
          </p>
        </div>
      </div>

      {/* Row 2 — Action Items */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div
          className={cn(
            "rounded-lg border p-4",
            contradictedCount > 0
              ? "border-red-500/30 bg-red-500/5"
              : "border-border/60"
          )}
        >
          <p className="text-xs text-muted-foreground mb-1">
            Contradicted
          </p>
          <p
            className={cn(
              "text-2xl font-bold tabular-nums",
              contradictedCount > 0 && "text-red-600"
            )}
          >
            {contradictedCount.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {contradictedCount > 0 ? "Fix now — data may be wrong" : "None found"}
          </p>
        </div>
        <div
          className={cn(
            "rounded-lg border p-4",
            outdatedCount > 0
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-border/60"
          )}
        >
          <p className="text-xs text-muted-foreground mb-1">Outdated</p>
          <p
            className={cn(
              "text-2xl font-bold tabular-nums",
              outdatedCount > 0 && "text-amber-600"
            )}
          >
            {outdatedCount.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {outdatedCount > 0 ? "Source has newer info" : "All current"}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Accuracy Rate</p>
          <p
            className={cn(
              "text-2xl font-bold tabular-nums",
              accuracyRate === null
                ? ""
                : accuracyRate >= 90
                  ? "text-emerald-600"
                  : accuracyRate >= 75
                    ? "text-amber-600"
                    : "text-red-600"
            )}
          >
            {accuracyRate !== null ? `${accuracyRate}%` : "N/A"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            confirmed / (confirmed + wrong + outdated)
          </p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Needs Recheck</p>
          <p
            className={cn(
              "text-2xl font-bold tabular-nums",
              (filteredStats.needs_recheck ?? 0) > 0 && "text-amber-600"
            )}
          >
            {(filteredStats.needs_recheck ?? 0).toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {(filteredStats.needs_recheck ?? 0) > 0
              ? "Flagged for re-check"
              : "All up to date"}
          </p>
        </div>
      </div>

      {/* Filter tabs — record type */}
      <div className="space-y-3 mb-4">
        <div className="flex gap-1.5 flex-wrap">
          <Link
            href={buildFilterUrl("/sourcing", {
              type: "all",
              verdict: filterVerdict,
              q: searchQuery,
            })}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              filterType === "all"
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            All types ({globalTotal})
          </Link>
          {typeEntries.map(([type, count]) => (
            <Link
              key={type}
              href={buildFilterUrl("/sourcing", {
                type,
                verdict: filterVerdict,
                q: searchQuery,
              })}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                filterType === type && filterType !== "all"
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
            >
              {formatRecordType(type)} ({count})
            </Link>
          ))}
        </div>

        {/* Filter tabs — verdict (independent of type filter) */}
        <div className="flex gap-1.5 flex-wrap">
          <Link
            href={buildFilterUrl("/sourcing", {
              type: filterType,
              verdict: "all",
              q: searchQuery,
            })}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              filterVerdict === "all"
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            All verdicts
          </Link>
          {verdictEntries.map(([v, count]) => {
            const style = VERDICT_STYLES[v] || VERDICT_STYLES.unchecked;
            const isActive = filterVerdict === v && filterVerdict !== "all";
            return (
              <Link
                key={v}
                href={buildFilterUrl("/sourcing", {
                  type: filterType,
                  verdict: v,
                  q: searchQuery,
                })}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  isActive
                    ? `${style.bg} ${style.text}`
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
              >
                {v} ({count})
              </Link>
            );
          })}
        </div>
      </div>

      {/* Search + results count */}
      <div className="flex items-center gap-4 mb-4">
        <SourcingSearch />
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {`${total} results`}
        </span>
      </div>

      {/* Table */}
      <SourcingTable verdicts={verdicts} names={names} hrefs={hrefs} claims={claims} />

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2 px-1 mt-4">
          <span className="text-sm text-muted-foreground">
            Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of{" "}
            {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            {/* First page */}
            {pageNum > 1 ? (
              <Link
                href={buildFilterUrl("/sourcing", {
                  type: filterType,
                  verdict: filterVerdict,
                  q: searchQuery,
                  page: 1,
                })}
                className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
                title="First page"
              >
                <ChevronsLeft className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground opacity-30 cursor-not-allowed">
                <ChevronsLeft className="h-3.5 w-3.5" />
              </span>
            )}
            {/* Prev page */}
            {pageNum > 1 ? (
              <Link
                href={buildFilterUrl("/sourcing", {
                  type: filterType,
                  verdict: filterVerdict,
                  q: searchQuery,
                  page: pageNum - 1,
                })}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground opacity-30 cursor-not-allowed">
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </span>
            )}
            {/* Page indicator */}
            <span className="px-3 py-1 text-xs font-medium text-muted-foreground tabular-nums whitespace-nowrap">
              Page {pageNum} of {totalPages}
            </span>
            {/* Next page */}
            {pageNum < totalPages ? (
              <Link
                href={buildFilterUrl("/sourcing", {
                  type: filterType,
                  verdict: filterVerdict,
                  q: searchQuery,
                  page: pageNum + 1,
                })}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground opacity-30 cursor-not-allowed">
                Next <ChevronRight className="h-3.5 w-3.5" />
              </span>
            )}
            {/* Last page */}
            {pageNum < totalPages ? (
              <Link
                href={buildFilterUrl("/sourcing", {
                  type: filterType,
                  verdict: filterVerdict,
                  q: searchQuery,
                  page: totalPages,
                })}
                className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
                title="Last page"
              >
                <ChevronsRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground opacity-30 cursor-not-allowed">
                <ChevronsRight className="h-3.5 w-3.5" />
              </span>
            )}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-4">
        Data from <code className="text-[11px]">source_check_verdicts</code>{" "}
        table. Click a row to view detailed evidence.
      </p>
    </div>
  );
}
