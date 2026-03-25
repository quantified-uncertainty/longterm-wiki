import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  fetchDetailed,
} from "@/lib/wiki-server";
import type {
  RpcSourceChecksStatsResult,
  RpcSourceChecksVerdictsResult,
  RpcSourceChecksResolveNamesResult,
} from "@/lib/wiki-server";
import { getTypedEntityByStableId, getIdRegistry } from "@/data/tablebase";
import { SourceChecksTable } from "./source-checks-table";
import { SourceChecksSearch } from "./source-checks-filter";
import {
  VERDICT_STYLES,
  PAGE_SIZE,
  buildFilterUrl,
  formatRecordType,
} from "./source-checks-shared";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Source Checks",
  description:
    "Directory of source verification checks across wiki data, including personnel records, grants, divisions, and more.",
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

export default async function SourceChecksPage({ searchParams }: PageProps) {
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
  verdictParams.set("limit", String(PAGE_SIZE));
  verdictParams.set("offset", String(offset));

  // Build stats URL — pass record_type when a type filter is active so that
  // the stat cards and verdict-pill counts reflect the selected type.
  const statsParams = new URLSearchParams();
  if (filterType !== "all") statsParams.set("record_type", filterType);
  const statsQs = statsParams.toString();
  const statsUrl = statsQs
    ? `/api/source-checks/stats?${statsQs}`
    : "/api/source-checks/stats";

  // Fetch global stats (for type tabs), filtered stats (for cards + verdict tabs), and verdicts
  const [globalStatsResult, filteredStatsResult, verdictsResult] =
    await Promise.all([
      // Always fetch unfiltered stats for the type-filter tab counts
      fetchDetailed<RpcSourceChecksStatsResult>("/api/source-checks/stats", {
        revalidate: 300,
      }),
      // Fetch type-filtered stats for stat cards + verdict pills
      fetchDetailed<RpcSourceChecksStatsResult>(statsUrl, {
        revalidate: 300,
      }),
      fetchDetailed<RpcSourceChecksVerdictsResult>(
        `/api/source-checks/verdicts?${verdictParams.toString()}`,
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
    // Group record IDs by type for batch resolution via wiki-server
    const byType = new Map<string, Set<string>>();
    const entityIds = new Set<string>();
    for (const v of verdicts) {
      const existing = byType.get(v.recordType);
      if (existing) {
        existing.add(v.recordId);
      } else {
        byType.set(v.recordType, new Set([v.recordId]));
      }
      if (v.entityId) {
        entityIds.add(v.entityId);
      }
    }

    // Resolve record names via wiki-server
    const nameResults = await Promise.all(
      [...byType.entries()].map(async ([recordType, ids]) => {
        const idList = [...ids].join(",");
        const result = await fetchDetailed<RpcSourceChecksResolveNamesResult>(
          `/api/source-checks/resolve-names?record_type=${encodeURIComponent(recordType)}&record_ids=${encodeURIComponent(idList)}`,
          { revalidate: 300 }
        );
        return result.ok ? result.data.names : {};
      })
    );
    for (const nameMap of nameResults) {
      names = { ...names, ...nameMap };
    }

    // Strip "new:" prefix from display names (artefact of record creation)
    for (const [key, value] of Object.entries(names)) {
      if (value.startsWith("new:")) {
        names[key] = value.slice(4);
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

  // Client-side search filtering (server already filtered by type/verdict)
  const filteredVerdicts = searchQuery
    ? verdicts.filter((v) => {
        const recordName = names[v.recordId] ?? "";
        const entityName = v.entityId ? (names[v.entityId] ?? "") : "";
        const searchLower = searchQuery.toLowerCase();
        return (
          v.recordId.toLowerCase().includes(searchLower) ||
          v.recordType.toLowerCase().includes(searchLower) ||
          recordName.toLowerCase().includes(searchLower) ||
          entityName.toLowerCase().includes(searchLower) ||
          (v.reasoning?.toLowerCase().includes(searchLower) ?? false)
        );
      })
    : verdicts;

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Stats — use filteredStats for cards (reflects type filter)
  const avgConfidence =
    filteredStats.avg_confidence > 0
      ? `${Math.round(filteredStats.avg_confidence * 100)}%`
      : "N/A";

  // Type tabs always use global stats (so all types are visible)
  const globalTotal = globalStats.by_type
    ? Object.values(globalStats.by_type).reduce((a, b) => a + b, 0)
    : globalStats.total;
  const typeEntries = Object.entries(globalStats.by_type).sort(
    ([, a], [, b]) => b - a
  );
  // Verdict tabs use filteredStats (contextual to selected type)
  const verdictEntries = Object.entries(filteredStats.by_verdict).sort(
    ([, a], [, b]) => b - a
  );

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Source Checks
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl mb-2">
          Automated verification of wiki data against original sources. Each
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

      {/* Stats cards — reflect active type filter */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Total Verdicts</p>
          <p className="text-2xl font-bold tabular-nums">
            {filteredStats.total}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Avg Confidence</p>
          <p className="text-2xl font-bold tabular-nums">{avgConfidence}</p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Contradicted</p>
          <p
            className={cn(
              "text-2xl font-bold tabular-nums",
              (filteredStats.by_verdict.contradicted ?? 0) > 0 &&
                "text-red-600"
            )}
          >
            {filteredStats.by_verdict.contradicted ?? 0}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Outdated</p>
          <p
            className={cn(
              "text-2xl font-bold tabular-nums",
              (filteredStats.by_verdict.outdated ?? 0) > 0 && "text-amber-600"
            )}
          >
            {filteredStats.by_verdict.outdated ?? 0}
          </p>
        </div>
      </div>

      {/* Filter tabs — record type */}
      <div className="space-y-3 mb-4">
        <div className="flex gap-1.5 flex-wrap">
          <Link
            href={buildFilterUrl("/source-checks", {
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
              href={buildFilterUrl("/source-checks", {
                type,
                verdict: filterVerdict,
                q: searchQuery,
              })}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                filterType === type
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
            >
              {formatRecordType(type)} ({count})
            </Link>
          ))}
        </div>

        {/* Filter tabs — verdict */}
        <div className="flex gap-1.5 flex-wrap">
          <Link
            href={buildFilterUrl("/source-checks", {
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
            return (
              <Link
                key={v}
                href={buildFilterUrl("/source-checks", {
                  type: filterType,
                  verdict: v,
                  q: searchQuery,
                })}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  filterVerdict === v
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
        <SourceChecksSearch />
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {searchQuery
            ? `${filteredVerdicts.length} of ${total} results`
            : `${total} results`}
        </span>
      </div>

      {/* Table */}
      <SourceChecksTable verdicts={filteredVerdicts} names={names} hrefs={hrefs} />

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-1 mt-4">
          <span className="text-sm text-muted-foreground">
            Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of{" "}
            {total}
          </span>
          <div className="flex items-center gap-1">
            {pageNum > 1 ? (
              <Link
                href={buildFilterUrl("/source-checks", {
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
              <span className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground opacity-40 cursor-not-allowed">
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </span>
            )}
            <span className="px-2 text-xs text-muted-foreground tabular-nums">
              {pageNum} / {totalPages}
            </span>
            {pageNum < totalPages ? (
              <Link
                href={buildFilterUrl("/source-checks", {
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
              <span className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground opacity-40 cursor-not-allowed">
                Next <ChevronRight className="h-3.5 w-3.5" />
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
