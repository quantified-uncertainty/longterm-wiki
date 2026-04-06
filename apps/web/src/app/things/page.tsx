import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { fetchDetailed } from "@/lib/wiki-server";
import { ThingsTable } from "./things-table";

export const metadata: Metadata = {
  title: "Things",
  description: "Browsable index of all things tracked in the knowledge base.",
  robots: { index: false },
};

export const revalidate = 300;

const PAGE_SIZE = 50;

interface ThingRow {
  id: string;
  thingType: string;
  title: string;
  parentThingId: string | null;
  sourceTable: string;
  sourceId: string;
  entityType: string | null;
  description: string | null;
  href: string | null;
  parentTitle: string | null;
  updatedAt: string | null;
}

interface ThingsListResponse {
  results?: ThingRow[];
  things?: ThingRow[];
  total: number;
}

interface ThingsStatsResponse {
  total: number;
  byType: Record<string, number>;
  byEntityType: Record<string, number>;
}

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const val = searchParams[key];
  return typeof val === "string" ? val : undefined;
}

export default async function ThingsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const searchQuery = getParam(sp, "q") ?? "";
  const filterType = getParam(sp, "type") ?? "";
  const pageNum = Math.max(1, parseInt(getParam(sp, "page") ?? "1", 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  // Build list/search URL
  let listUrl: string;
  if (searchQuery) {
    const params = new URLSearchParams({ q: searchQuery, limit: String(PAGE_SIZE), offset: String(offset) });
    if (filterType) params.set("thing_type", filterType);
    listUrl = `/api/things/search?${params.toString()}`;
  } else {
    const params = new URLSearchParams({
      sort: "updated_at",
      order: "desc",
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (filterType) params.set("thing_type", filterType);
    listUrl = `/api/things?${params.toString()}`;
  }

  const [statsResult, listResult] = await Promise.all([
    fetchDetailed<ThingsStatsResponse>("/api/things/stats", { revalidate: 300, timeoutMs: 20_000 }),
    fetchDetailed<ThingsListResponse>(listUrl, { revalidate: 300, timeoutMs: 20_000 }),
  ]);

  if (!listResult.ok) {
    return (
      <div className="max-w-[90rem] mx-auto px-6 py-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-4">Things</h1>
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-600">
          <p className="font-medium mb-1">Unable to load things data</p>
          <p className="text-red-500/80">
            The wiki-server may be temporarily unavailable. Please try again later.
            {!statsResult.ok && " (stats also failed)"}
          </p>
        </div>
      </div>
    );
  }

  // The list endpoint returns { things, total } while the search endpoint
  // returns { results, total }. Normalize to a single shape.
  const listBody = listResult.data;
  const results = listBody.results ?? listBody.things ?? [];
  const total = listBody.total ?? results.length;

  // Stats may fail independently — degrade gracefully.
  // Use the list total as fallback so the header doesn't show "0 items total"
  // while rows are visibly rendered.
  const stats: ThingsStatsResponse = statsResult.ok
    ? statsResult.data
    : { total, byType: {}, byEntityType: {} };
  const totalPages = Math.ceil(total / PAGE_SIZE);

  function buildUrl(overrides: { q?: string; type?: string; page?: number }) {
    const params = new URLSearchParams();
    const q = overrides.q ?? searchQuery;
    const t = overrides.type ?? filterType;
    const p = overrides.page ?? 1;
    if (q) params.set("q", q);
    if (t) params.set("type", t);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/things${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">Things</h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Universal index of all tracked items across the knowledge base.{" "}
          <span className="tabular-nums">{stats.total.toLocaleString()}</span> items total.
        </p>
      </div>

      {/* Client component with search + type filter + table */}
      <ThingsTable
        rows={results}
        total={total}
        stats={stats}
        currentQuery={searchQuery}
        currentType={filterType}
        currentPage={pageNum}
        pageSize={PAGE_SIZE}
      />

      {/* Server-rendered pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-1 mt-4">
          <span className="text-sm text-muted-foreground">
            Showing {offset + 1}&ndash;{Math.min(offset + PAGE_SIZE, total)} of{" "}
            {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            {pageNum > 1 ? (
              <Link
                href={buildUrl({ page: pageNum - 1 })}
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
                href={buildUrl({ page: pageNum + 1 })}
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
    </div>
  );
}
