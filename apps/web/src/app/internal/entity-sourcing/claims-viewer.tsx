"use client";

import { useState, useEffect, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getExpandedRowModel,
  type SortingState,
  type ExpandedState,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  Loader2,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
} from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaimRow {
  id: number;
  batchId: string;
  claimText: string;
  entityId: string | null;
  targetTable: string;
  targetField: string | null;
  proposedValue: string | null;
  sourceUrl: string;
  resourceId: string | null;
  status: string;
  confidence: number | null;
  reasoning: string | null;
  extractedValue: string | null;
  checkerModel: string | null;
  verifiedAt: string | null;
  submittedBy: string | null;
  createdAt: string;
}

interface ClaimStats {
  total: number;
  pending: number;
  verifying: number;
  verified: number;
  contradicted: number;
  unverifiable: number;
  expired: number;
  uniqueEntities: number;
  totalBatches: number;
  avgConfidence: number;
  recordLinks: { totalLinks: number; linkedClaims: number };
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  verified: { bg: "bg-emerald-100 dark:bg-emerald-900/30", text: "text-emerald-800 dark:text-emerald-300" },
  contradicted: { bg: "bg-red-100 dark:bg-red-900/30", text: "text-red-800 dark:text-red-300" },
  unverifiable: { bg: "bg-red-100 dark:bg-red-900/30", text: "text-red-700 dark:text-red-300" },
  pending: { bg: "bg-blue-100 dark:bg-blue-900/30", text: "text-blue-800 dark:text-blue-300" },
  verifying: { bg: "bg-amber-100 dark:bg-amber-900/30", text: "text-amber-800 dark:text-amber-300" },
  expired: { bg: "bg-orange-100 dark:bg-orange-900/30", text: "text-orange-800 dark:text-orange-300" },
};

function ClaimStatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.pending;
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium", style.bg, style.text)}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3 text-center">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function buildColumns(): ColumnDef<ClaimRow>[] {
  return [
    {
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
    },
    {
      accessorKey: "id",
      header: ({ column }) => <SortableHeader column={column}>ID</SortableHeader>,
      size: 60,
    },
    {
      accessorKey: "claimText",
      header: "Claim",
      size: 300,
      cell: ({ getValue }) => {
        const text = getValue<string>();
        return (
          <span className="line-clamp-2 text-sm" title={text}>
            {text.length > 120 ? `${text.slice(0, 120)}...` : text}
          </span>
        );
      },
    },
    {
      accessorKey: "entityId",
      header: "Entity",
      size: 120,
      cell: ({ getValue }) => {
        const val = getValue<string | null>();
        return val ? <span className="text-sm font-mono">{val}</span> : <span className="text-muted-foreground">-</span>;
      },
    },
    {
      accessorKey: "targetTable",
      header: "Table",
      size: 100,
      cell: ({ getValue }) => <span className="text-xs font-mono">{getValue<string>()}</span>,
    },
    {
      accessorKey: "sourceUrl",
      header: "Source",
      size: 180,
      cell: ({ getValue }) => {
        const url = getValue<string>();
        try {
          const hostname = new URL(url).hostname.replace(/^www\./, "");
          return (
            <a href={url} target="_blank" rel="noopener noreferrer"
               className="text-xs text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1">
              {hostname}
              <ExternalLink className="h-3 w-3" />
            </a>
          );
        } catch {
          return <span className="text-xs text-muted-foreground">{url.slice(0, 30)}</span>;
        }
      },
    },
    {
      accessorKey: "status",
      header: ({ column }) => <SortableHeader column={column}>Status</SortableHeader>,
      size: 110,
      cell: ({ getValue }) => <ClaimStatusBadge status={getValue<string>()} />,
    },
    {
      accessorKey: "confidence",
      header: ({ column }) => <SortableHeader column={column}>Conf.</SortableHeader>,
      size: 70,
      cell: ({ getValue }) => {
        const val = getValue<number | null>();
        return val != null ? (
          <span className="text-sm tabular-nums">{(val * 100).toFixed(0)}%</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        );
      },
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => <SortableHeader column={column}>Created</SortableHeader>,
      size: 100,
      cell: ({ getValue }) => {
        const val = getValue<string>();
        if (!val) return <span className="text-muted-foreground">-</span>;
        const date = new Date(val);
        const now = Date.now();
        const diffMs = now - date.getTime();
        const diffH = Math.floor(diffMs / 3_600_000);
        if (diffH < 24) return <span className="text-xs tabular-nums">{diffH}h ago</span>;
        const diffD = Math.floor(diffH / 24);
        if (diffD < 30) return <span className="text-xs tabular-nums">{diffD}d ago</span>;
        return <span className="text-xs tabular-nums">{date.toLocaleDateString()}</span>;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Expanded row detail
// ---------------------------------------------------------------------------

function ExpandedClaimDetail({ claim }: { claim: ClaimRow }) {
  return (
    <div className="px-4 py-3 bg-muted/30 space-y-3 text-sm">
      <div>
        <div className="font-medium text-muted-foreground text-xs mb-1">Full Claim Text</div>
        <div>{claim.claimText}</div>
      </div>

      {claim.proposedValue && (
        <div>
          <div className="font-medium text-muted-foreground text-xs mb-1">Proposed Value</div>
          <div className="font-mono text-xs bg-muted p-2 rounded">{claim.proposedValue}</div>
        </div>
      )}

      {claim.reasoning && (
        <div>
          <div className="font-medium text-muted-foreground text-xs mb-1">Verdict Reasoning</div>
          <div className="text-muted-foreground">{claim.reasoning}</div>
        </div>
      )}

      {claim.extractedValue && (
        <div>
          <div className="font-medium text-muted-foreground text-xs mb-1">Extracted Value</div>
          <div className="font-mono text-xs bg-muted p-2 rounded">{claim.extractedValue}</div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>Batch: <span className="font-mono">{claim.batchId}</span></span>
        {claim.checkerModel && <span>Model: {claim.checkerModel}</span>}
        {claim.targetField && <span>Field: <span className="font-mono">{claim.targetField}</span></span>}
        {claim.submittedBy && <span>Agent: <span className="font-mono">{claim.submittedBy}</span></span>}
        {claim.verifiedAt && <span>Verified: {new Date(claim.verifiedAt).toLocaleString()}</span>}
        {claim.resourceId && <span>Resource: <span className="font-mono">{claim.resourceId}</span></span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter buttons
// ---------------------------------------------------------------------------

const FILTER_STATUSES = ["all", "pending", "verifying", "verified", "contradicted", "unverifiable", "expired"] as const;

function StatusFilters({
  active,
  onChange,
  stats,
}: {
  active: string;
  onChange: (status: string) => void;
  stats: ClaimStats | null;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {FILTER_STATUSES.map((s) => {
        const rawCount = s === "all" ? stats?.total : stats?.[s as keyof ClaimStats];
        const count = typeof rawCount === "number" ? rawCount : null;
        const isActive = active === s;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className={cn(
              "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
              isActive
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted",
            )}
          >
            {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            {count != null && <span className="ml-1 tabular-nums">({count})</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;

export function ClaimsViewer() {
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [stats, setStats] = useState<ClaimStats | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sorting, setSorting] = useState<SortingState>([{ id: "createdAt", desc: true }]);
  const [expanded, setExpanded] = useState<ExpandedState>({});

  // Fetch stats once
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/claims-proxy?type=stats");
        if (res.ok) {
          setStats(await res.json());
        }
      } catch (e) {
        console.warn(`[claims-viewer] Failed to load stats: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, []);

  // Fetch claims
  useEffect(() => {
    void (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        if (statusFilter !== "all") params.set("status", statusFilter);
        const res = await fetch(`/api/claims-proxy?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        setClaims(body.claims ?? []);
        setTotal(body.total ?? 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    })();
  }, [offset, statusFilter]);

  const columns = useMemo(() => buildColumns(), []);

  const table = useReactTable({
    data: claims,
    columns,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: () => true,
    manualPagination: true,
    pageCount: Math.ceil(total / PAGE_SIZE),
  });

  const handleStatusChange = (status: string) => {
    setStatusFilter(status);
    setOffset(0);
  };

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
        Failed to load claims: {error}
      </div>
    );
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-6">
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          <StatCard label="Total" value={stats.total} />
          <StatCard label="Verified" value={stats.verified} />
          <StatCard label="Contradicted" value={stats.contradicted} />
          <StatCard label="Pending" value={stats.pending + stats.verifying} sub={stats.verifying > 0 ? `${stats.verifying} verifying` : undefined} />
          <StatCard label="Unverifiable" value={stats.unverifiable} />
          <StatCard label="Avg Confidence" value={stats.avgConfidence > 0 ? `${(stats.avgConfidence * 100).toFixed(0)}%` : "-"} sub={`${stats.totalBatches} batches`} />
        </div>
      )}

      {/* Filters */}
      <StatusFilters active={statusFilter} onChange={handleStatusChange} stats={stats} />

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading claims...
        </div>
      ) : claims.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No claims found{statusFilter !== "all" ? ` with status "${statusFilter}"` : ""}.
        </div>
      ) : (
        <>
          <DataTable
            table={table}
            renderExpandedRow={(row) => <ExpandedClaimDetail claim={row.original} />}
          />

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={offset === 0}
                  className="p-1.5 rounded border border-border hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="tabular-nums">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={offset + PAGE_SIZE >= total}
                  className="p-1.5 rounded border border-border hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
