"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getExpandedRowModel,
  type SortingState,
  type ExpandedState,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  Search,
  Loader2,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  RotateCcw,
  ArrowUpRight,
  AlertTriangle,
} from "lucide-react";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import { VerdictBadge, VERDICT_STYLES, getRecordHref } from "@/app/source-checks/source-checks-shared";

// -- Types --

interface VerdictRow {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number;
  needsRecheck: boolean;
  nextCheckDue: string | null;
  lastComputedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface EvidenceRow {
  id: number;
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  expectedValue: string | null;
  resourceId: string | null;
  sourceUrl: string | null;
  extractedValue: string | null;
  extractedQuote: string | null;
  verdict: string;
  confidence: number | null;
  isPrimarySource: boolean;
  checkerModel: string | null;
  isStale: boolean;
  notes: string | null;
  checkedAt: string | null;
}

// ── Verdict priority (viewer-specific sort order) ───────────────────────

/** Sort priority: most actionable verdicts first. Lower = higher priority. */
const VERDICT_PRIORITY: Record<string, number> = {
  contradicted: 0,
  outdated: 1,
  partial: 2,
  unverifiable: 3,
  confirmed: 4,
  unchecked: 5,
};

// ── Columns ────────────────────────────────────────────────────────────────

function expandToggleColumn(): ColumnDef<VerdictRow> {
  return {
    id: "expand",
    size: 32,
    header: () => null,
    cell: ({ row }) => (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); row.toggleExpanded(); }}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label={row.getIsExpanded() ? "Collapse" : "Expand"}
      >
        <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", row.getIsExpanded() && "rotate-90")} />
      </button>
    ),
  };
}

function buildColumns(names: NameMap, hrefs: HrefMap): ColumnDef<VerdictRow>[] {
  return [
    expandToggleColumn(),
    {
      accessorKey: "recordType",
      header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
      size: 80,
      cell: ({ row }) => (
        <span className="text-xs font-medium capitalize">{row.original.recordType}</span>
      ),
    },
    {
      accessorKey: "entityId",
      header: ({ column }) => <SortableHeader column={column}>Entity</SortableHeader>,
      cell: ({ row }) => {
        const id = row.original.entityId;
        if (!id) return <span className="text-xs text-muted-foreground">-</span>;
        const resolvedName = names[id];
        const href = hrefs[id];
        const display = resolvedName
          ? (resolvedName.length > 28 ? resolvedName.slice(0, 26) + "…" : resolvedName)
          : (id.length > 12 ? id.slice(0, 10) + "…" : id);
        if (href) {
          return (
            <a href={href} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400" title={resolvedName || id}>
              {display}
            </a>
          );
        }
        return (
          <span className={cn("text-xs", resolvedName ? "font-medium" : "font-mono text-muted-foreground")} title={resolvedName || id}>
            {display}
          </span>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "recordId",
      header: ({ column }) => <SortableHeader column={column}>Field</SortableHeader>,
      cell: ({ row }) => {
        const resolvedName = names[row.original.recordId];
        const recordId = row.original.recordId;
        const recordHref = getRecordHref(row.original.recordType, recordId);

        if (resolvedName) {
          const display = resolvedName.length > 30 ? resolvedName.slice(0, 28) + "…" : resolvedName;
          if (recordHref) {
            return (
              <a href={recordHref} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400" title={resolvedName}>
                {display}
              </a>
            );
          }
          return (
            <span className="text-xs font-medium" title={resolvedName}>
              {display}
            </span>
          );
        }

        // Fallback: show raw ID, linked if a detail page exists
        const idDisplay = recordId.length > 15 ? recordId.slice(0, 12) + "…" : recordId;
        if (recordHref) {
          return (
            <a href={recordHref} className="text-xs font-mono text-blue-600/70 hover:underline dark:text-blue-400/70" title={recordId}>
              {idDisplay}
            </a>
          );
        }
        return (
          <span className="text-xs font-mono text-muted-foreground" title={recordId}>
            {idDisplay}
          </span>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "verdict",
      header: ({ column }) => <SortableHeader column={column}>Verdict</SortableHeader>,
      size: 100,
      sortingFn: (a, b) =>
        (VERDICT_PRIORITY[a.original.verdict] ?? 99) - (VERDICT_PRIORITY[b.original.verdict] ?? 99),
      cell: ({ row }) => <VerdictBadge verdict={row.original.verdict} />,
    },
    {
      accessorKey: "confidence",
      header: ({ column }) => <SortableHeader column={column}>Conf.</SortableHeader>,
      size: 70,
      cell: ({ row }) => {
        const c = row.original.confidence;
        if (c == null) return <span className="text-xs text-muted-foreground">-</span>;
        return <span className="text-sm tabular-nums font-medium">{Math.round(c * 100)}%</span>;
      },
    },
    {
      accessorKey: "reasoning",
      header: "Reasoning",
      cell: ({ row }) => {
        const r = row.original.reasoning;
        if (!r) return <span className="text-xs text-muted-foreground">-</span>;
        return (
          <span className="text-xs text-muted-foreground line-clamp-2" title={r}>
            {r}
          </span>
        );
      },
    },
    {
      accessorKey: "lastComputedAt",
      header: ({ column }) => <SortableHeader column={column}>Checked</SortableHeader>,
      size: 90,
      cell: ({ row }) => {
        const d = row.original.lastComputedAt;
        if (!d) return <span className="text-xs text-muted-foreground">-</span>;
        return <span className="text-xs text-muted-foreground tabular-nums">{new Date(d).toLocaleDateString()}</span>;
      },
    },
    {
      id: "detail",
      size: 36,
      header: () => null,
      cell: ({ row }) => (
        <a
          href={`/source-checks/${encodeURIComponent(row.original.recordType)}/${encodeURIComponent(row.original.recordId)}`}
          className="p-1 rounded hover:bg-muted transition-colors inline-flex"
          title="View source check detail"
        >
          <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
        </a>
      ),
    },
  ];
}

// -- Expanded evidence detail (grouped by source URL) --

type DetailCache = Record<string, { status: "loading" | "error" | "loaded"; data?: { evidence: EvidenceRow[]; currentCheckerModel?: string }; error?: string }>;

/** Group evidence rows by sourceUrl for display. */
function groupBySourceUrl(evidence: EvidenceRow[]): Map<string, EvidenceRow[]> {
  const groups = new Map<string, EvidenceRow[]>();
  for (const e of evidence) {
    const key = e.sourceUrl || "(no source URL)";
    const existing = groups.get(key);
    if (existing) {
      existing.push(e);
    } else {
      groups.set(key, [e]);
    }
  }
  return groups;
}

function EvidenceTable({ evidence }: { evidence: EvidenceRow[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-border/40 text-left text-muted-foreground">
          <th className="py-1.5 pr-3 font-medium">Verdict</th>
          <th className="py-1.5 pr-3 font-medium">Confidence</th>
          <th className="py-1.5 pr-3 font-medium">Expected</th>
          <th className="py-1.5 pr-3 font-medium">Found</th>
          <th className="py-1.5 pr-3 font-medium">Model</th>
          <th className="py-1.5 font-medium">Checked</th>
        </tr>
      </thead>
      <tbody>
        {evidence.map((e) => (
          <tr key={e.id} className={cn("border-b border-border/20 last:border-0", e.isStale && "opacity-60")}>
            <td className="py-1.5 pr-3"><VerdictBadge verdict={e.verdict} /></td>
            <td className="py-1.5 pr-3 tabular-nums">{e.confidence != null ? `${Math.round(e.confidence * 100)}%` : "-"}</td>
            <td className="py-1.5 pr-3 max-w-[150px] truncate" title={e.expectedValue ?? undefined}>
              {e.expectedValue || "-"}
            </td>
            <td className="py-1.5 pr-3 max-w-[150px] truncate" title={e.extractedValue ?? undefined}>
              {e.extractedValue || "-"}
            </td>
            <td className="py-1.5 pr-3">
              <span className={cn("text-muted-foreground", e.isStale && "text-amber-500")}>
                {e.checkerModel || "-"}
                {e.isStale && (
                  <span title="Stale: checked with an outdated model"><AlertTriangle className="inline h-3 w-3 ml-1 text-amber-500" /></span>
                )}
              </span>
            </td>
            <td className="py-1.5 tabular-nums text-muted-foreground">
              {e.checkedAt ? new Date(e.checkedAt).toLocaleDateString() : "-"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExpandedDetail({
  recordType,
  recordId,
  cache,
  onLoad,
}: {
  recordType: string;
  recordId: string;
  cache: DetailCache;
  onLoad: (recordType: string, recordId: string) => void;
}) {
  const key = `${recordType}:${recordId}`;
  const entry = cache[key];

  useEffect(() => {
    if (!entry) onLoad(recordType, recordId);
  }, [recordType, recordId, entry, onLoad]);

  if (!entry || entry.status === "loading") {
    return (
      <div className="flex items-center gap-2 px-6 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading evidence...
      </div>
    );
  }

  if (entry.status === "error") {
    return (
      <div className="flex items-center gap-3 px-6 py-4 text-sm text-red-500">
        <span>Failed: {entry.error}</span>
        <button type="button" onClick={() => onLoad(recordType, recordId)}
          className="inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10">
          <RotateCcw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  }

  const evidence = entry.data?.evidence ?? [];
  if (evidence.length === 0) {
    return <div className="px-6 py-4 text-sm text-muted-foreground">No evidence records found.</div>;
  }

  const staleCount = evidence.filter((e) => e.isStale).length;
  const grouped = groupBySourceUrl(evidence);

  return (
    <div className="px-6 py-4 bg-muted/30">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-xs font-semibold text-muted-foreground">
          Evidence ({evidence.length} check{evidence.length !== 1 ? "s" : ""} across {grouped.size} source{grouped.size !== 1 ? "s" : ""})
        </div>
        {staleCount > 0 && (
          <div className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-500/15 text-amber-500">
            <AlertTriangle className="h-3 w-3" />
            {staleCount} stale
          </div>
        )}
      </div>

      <div className="space-y-4">
        {[...grouped.entries()].map(([sourceUrl, items]) => (
          <div key={sourceUrl} className="rounded-md border border-border/40 overflow-hidden">
            {/* Source URL header */}
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border/30">
              {sourceUrl !== "(no source URL)" ? (
                <a href={sourceUrl} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline flex items-center gap-1 dark:text-blue-400 min-w-0">
                  <ExternalLink className="h-3 w-3 shrink-0" />
                  <span className="truncate">{(() => { try { return new URL(sourceUrl).hostname + new URL(sourceUrl).pathname; } catch { return sourceUrl; } })()}</span>
                </a>
              ) : (
                <span className="text-xs text-muted-foreground italic">{sourceUrl}</span>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                {items.length} check{items.length !== 1 ? "s" : ""}
              </span>
            </div>
            {/* Evidence rows for this source */}
            <div className="overflow-x-auto px-3 py-1">
              <EvidenceTable evidence={items} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// -- Name resolution --

type NameMap = Record<string, string>;
type HrefMap = Record<string, string>;

interface ResolvedData {
  names: NameMap;
  hrefs: HrefMap;
}

/**
 * Batch-resolve record IDs and entity IDs to human-readable names via the proxy API.
 * Groups IDs by record type and makes one request per type.
 * Also resolves entityId stableIds as record_type=entity (with wiki page hrefs).
 */
async function resolveNames(
  verdicts: VerdictRow[]
): Promise<ResolvedData> {
  // Group unique record IDs by record type
  const byType = new Map<string, Set<string>>();
  for (const v of verdicts) {
    const existing = byType.get(v.recordType);
    if (existing) {
      existing.add(v.recordId);
    } else {
      byType.set(v.recordType, new Set([v.recordId]));
    }
    // Also collect entity IDs for resolution
    if (v.entityId) {
      const entitySet = byType.get("entity");
      if (entitySet) {
        entitySet.add(v.entityId);
      } else {
        byType.set("entity", new Set([v.entityId]));
      }
    }
  }

  const names: NameMap = {};
  const hrefs: HrefMap = {};

  // Fetch names for each record type in parallel
  const fetches = [...byType.entries()].map(async ([recordType, ids]) => {
    const idList = [...ids].join(",");
    try {
      const res = await fetch(
        `/api/verification-names-proxy?record_type=${encodeURIComponent(recordType)}&record_ids=${encodeURIComponent(idList)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.names) {
        for (const [id, name] of Object.entries(data.names as Record<string, string>)) {
          names[id] = name;
        }
      }
      if (data.hrefs) {
        for (const [id, href] of Object.entries(data.hrefs as Record<string, string>)) {
          hrefs[id] = href;
        }
      }
    } catch (e) {
      // Non-critical: display falls back to raw ID
      console.warn(`[entity-source-checks] Failed to resolve names for ${recordType}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  await Promise.all(fetches);
  return { names, hrefs };
}

// -- Main viewer --

interface CoverageRow {
  recordType: string;
  total: number;
  verified: number;
  percentage: number;
}

export function EntitySourceChecksViewer() {
  const [verdicts, setVerdicts] = useState<VerdictRow[]>([]);
  const [coverageData, setCoverageData] = useState<CoverageRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<DetailCache>({});
  const [recordNames, setRecordNames] = useState<NameMap>({});
  const [entityHrefs, setEntityHrefs] = useState<HrefMap>({});

  // Filter state
  const [filterType, setFilterType] = useState("all");
  const [filterVerdict, setFilterVerdict] = useState("all");

  // Load all verdicts on mount (paginated), then resolve names
  useEffect(() => {
    (async () => {
      try {
        // Fetch verdicts and coverage in parallel
        const coveragePromise = fetch("/api/verification-coverage-proxy")
          .then(async (res) => {
            if (!res.ok) return [];
            const data = await res.json();
            return (data.coverage ?? []) as CoverageRow[];
          })
          .catch((e) => {
            console.warn(`[entity-source-checks] Coverage fetch failed: ${e instanceof Error ? e.message : String(e)}`);
            return [] as CoverageRow[];
          });

        const PAGE_SIZE = 200;
        let offset = 0;
        let allVerdicts: VerdictRow[] = [];
        while (true) {
          const res = await fetch(`/api/entity-verifications-proxy?limit=${PAGE_SIZE}&offset=${offset}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const page = data.verdicts ?? [];
          allVerdicts = [...allVerdicts, ...page];
          const total = data.total as number | undefined;
          if (total !== undefined && allVerdicts.length >= total) break;
          if (page.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
        }
        setVerdicts(allVerdicts);

        const coverageResult = await coveragePromise;
        setCoverageData(coverageResult);

        // Resolve names in background (non-blocking)
        if (allVerdicts.length > 0) {
          resolveNames(allVerdicts).then(
            ({ names, hrefs }) => { setRecordNames(names); setEntityHrefs(hrefs); },
            (e) => console.warn(`[entity-source-checks] Name resolution failed: ${e instanceof Error ? e.message : String(e)}`)
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Memoize filter options and filtered data to keep stable references.
  // Without memoization, `filtered` is a new array every render, which
  // TanStack Table treats as a data change — triggering autoResetPageIndex
  // on every render and causing an infinite re-render loop that freezes the page.
  const { typeCounts, verdictCounts } = useMemo(() => {
    const tc = new Map<string, number>();
    const vc = new Map<string, number>();
    for (const v of verdicts) {
      tc.set(v.recordType, (tc.get(v.recordType) ?? 0) + 1);
      vc.set(v.verdict, (vc.get(v.verdict) ?? 0) + 1);
    }
    return { typeCounts: tc, verdictCounts: vc };
  }, [verdicts]);

  const filtered = useMemo(
    () =>
      verdicts.filter((v) => {
        if (filterType !== "all" && v.recordType !== filterType) return false;
        if (filterVerdict !== "all" && v.verdict !== filterVerdict) return false;
        return true;
      }),
    [verdicts, filterType, filterVerdict]
  );

  // Memoize columns so they update when record names / hrefs are resolved
  const columns = useMemo(() => buildColumns(recordNames, entityHrefs), [recordNames, entityHrefs]);

  // Table state — default sort by verdict (actionable items first: contradicted > outdated > partial > ...)
  const [sorting, setSorting] = useState<SortingState>([{ id: "verdict", desc: false }]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 100 });

  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [globalFilter, filterType, filterVerdict]);

  const table = useReactTable({
    data: filtered,
    columns,
    getRowId: (row) => `${row.recordType}:${row.recordId}:${row.fieldName ?? ""}`,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onExpandedChange: setExpanded,
    onPaginationChange: setPagination,
    globalFilterFn: "includesString",
    state: { sorting, globalFilter, expanded, pagination },
    // Disable auto-resets — this component manages pagination reset
    // explicitly via its own useEffect. Without this, any state change
    // could trigger auto-resets that fight with controlled state.
    autoResetPageIndex: false,
    autoResetExpanded: false,
  });

  const fetchDetail = useCallback(async (recordType: string, recordId: string) => {
    const key = `${recordType}:${recordId}`;
    setDetailCache((prev) => ({ ...prev, [key]: { status: "loading" } }));
    try {
      const res = await fetch(`/api/verification-detail?recordType=${encodeURIComponent(recordType)}&recordId=${encodeURIComponent(recordId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setDetailCache((prev) => ({ ...prev, [key]: { status: "loaded", data: json } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[entity-source-checks] Failed to load evidence for ${key}: ${msg}`);
      setDetailCache((prev) => ({ ...prev, [key]: { status: "error", error: msg } }));
    }
  }, []);

  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageCount = table.getPageCount();
  const currentPage = table.getState().pagination.pageIndex + 1;
  const { pageIndex, pageSize: ps } = table.getState().pagination;
  const rangeStart = pageIndex * ps + 1;
  const rangeEnd = Math.min((pageIndex + 1) * ps, filteredCount);

  // Stats
  const withConfidence = verdicts.filter((v) => v.confidence != null);
  const avgConfidence = withConfidence.length > 0
    ? withConfidence.reduce((s, v) => s + v.confidence!, 0) / withConfidence.length : 0;
  const contradictedCount = verdicts.filter((v) => v.verdict === "contradicted").length;
  const needsRecheckCount = verdicts.filter((v) => v.needsRecheck).length;

  // Coverage stats
  const totalRecords = coverageData.reduce((sum, r) => sum + r.total, 0);
  const totalVerified = coverageData.reduce((sum, r) => sum + r.verified, 0);
  const overallCoveragePct = totalRecords > 0
    ? Math.round((totalVerified / totalRecords) * 100)
    : 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading source checks...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">
        Failed to load source checks: {error}
      </div>
    );
  }

  return (
    <div className="not-prose">
      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        {totalRecords > 0 && (
          <div className="rounded-lg border border-border/60 p-4">
            <p className="text-xs text-muted-foreground mb-1">Total Records</p>
            <p className="text-2xl font-bold tabular-nums">{totalRecords.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-1">{coverageData.length} record types</p>
          </div>
        )}
        {totalRecords > 0 && (
          <div className="rounded-lg border border-border/60 p-4">
            <p className="text-xs text-muted-foreground mb-1">Verified</p>
            <p className={cn("text-2xl font-bold tabular-nums", overallCoveragePct < 50 ? "text-amber-600" : "text-emerald-600")}>{overallCoveragePct}%</p>
            <p className="text-xs text-muted-foreground mt-1">{totalVerified.toLocaleString()} / {totalRecords.toLocaleString()}</p>
          </div>
        )}
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Total Verdicts</p>
          <p className="text-2xl font-bold tabular-nums">{verdicts.length}</p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Avg Confidence</p>
          <p className="text-2xl font-bold tabular-nums">{avgConfidence > 0 ? `${Math.round(avgConfidence * 100)}%` : "N/A"}</p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Contradicted</p>
          <p className={cn("text-2xl font-bold tabular-nums", contradictedCount > 0 ? "text-red-600" : "")}>{contradictedCount}</p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Needs Recheck</p>
          <p className={cn("text-2xl font-bold tabular-nums", needsRecheckCount > 0 ? "text-amber-600" : "")}>{needsRecheckCount}</p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="space-y-3 mb-4">
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => setFilterType("all")}
            className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              filterType === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
            All types ({verdicts.length})
          </button>
          {[...typeCounts.entries()].sort(([, a], [, b]) => b - a).map(([type, count]) => (
            <button key={type} onClick={() => setFilterType(type)}
              className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                filterType === type ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
              {type} ({count})
            </button>
          ))}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => setFilterVerdict("all")}
            className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              filterVerdict === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
            All verdicts
          </button>
          {[...verdictCounts.entries()].sort(([, a], [, b]) => b - a).map(([v, count]) => {
            const style = VERDICT_STYLES[v] || VERDICT_STYLES.unchecked;
            const isActive = filterVerdict === v;
            return (
              <button key={v} onClick={() => setFilterVerdict(v)}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  isActive
                    ? `${style.bg} ${style.text}`
                    : "bg-muted text-muted-foreground hover:bg-muted/80",
                )}>
                {v} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Search + count */}
      <div className="flex items-center gap-4 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search by entity, record, or reasoning..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {filteredCount} results
        </span>
      </div>

      {/* Empty state for zero-result filters */}
      {filtered.length === 0 && (
        <div className="rounded-lg border border-border/60 bg-muted/30 px-6 py-8 text-center text-sm text-muted-foreground mb-4">
          No source checks match your filters. Try adjusting the type or verdict filters.
        </div>
      )}

      {/* Table */}
      <DataTable
        table={table}
        renderExpandedRow={(row) => {
          if (!row.getIsExpanded()) return null;
          return (
            <ExpandedDetail
              recordType={row.original.recordType}
              recordId={row.original.recordId}
              cache={detailCache}
              onLoad={fetchDetail}
            />
          );
        }}
      />

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between px-1 mt-4">
          <span className="text-sm text-muted-foreground">
            Showing {rangeStart}--{rangeEnd} of {filteredCount}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            <span className="px-2 text-xs text-muted-foreground tabular-nums">{currentPage} / {pageCount}</span>
            <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-4">
        Data from <code className="text-[11px]">source_check_verdicts</code> table.
        Click a row to expand and see per-source evidence grouped by URL.
      </p>
    </div>
  );
}
