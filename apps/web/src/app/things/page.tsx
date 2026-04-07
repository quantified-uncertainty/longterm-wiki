import type { Metadata } from "next";
import { fetchDetailed } from "@/lib/wiki-server";
import { ProfileStatCard } from "@/components/directory/ProfileStatCard";
import { ThingsTable } from "./things-table";
import { formatType } from "./types";
import type { ThingRow, ThingsStatsResponse } from "./types";

export const metadata: Metadata = {
  title: "Things",
  description: "Browsable index of all things tracked in the knowledge base.",
  robots: { index: false },
};

export const revalidate = 300;

const PAGE_SIZE = 50;

interface ThingsListResponse {
  results?: ThingRow[];
  things?: ThingRow[];
  total: number;
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

/** Valid sort fields supported by the wiki-server API. */
const VALID_SORT_FIELDS = new Set(["title", "updated_at", "created_at", "thing_type"]);

export default async function ThingsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const searchQuery = getParam(sp, "q") ?? "";
  const filterType = getParam(sp, "type") ?? "";

  // Parse page (useDirectoryUrl stores as 1-indexed in URL)
  const pageNum = Math.max(1, parseInt(getParam(sp, "page") ?? "1", 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  // Parse sort (useDirectoryUrl stores as "field:dir")
  const sortParam = getParam(sp, "sort") ?? "updated_at:desc";
  const [rawSortField, rawSortDir] = sortParam.split(":");
  const sortField = VALID_SORT_FIELDS.has(rawSortField) ? rawSortField : "updated_at";
  const sortDir = rawSortDir === "asc" ? "asc" : "desc";

  // Build list/search URL
  let listUrl: string;
  if (searchQuery) {
    const params = new URLSearchParams({ q: searchQuery, limit: String(PAGE_SIZE), offset: String(offset) });
    if (filterType) params.set("thing_type", filterType);
    listUrl = `/api/things/search?${params.toString()}`;
  } else {
    const params = new URLSearchParams({
      sort: sortField,
      order: sortDir,
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

  const listBody = listResult.data;
  const results = listBody.results ?? listBody.things ?? [];
  const total = listBody.total ?? results.length;

  const stats: ThingsStatsResponse = statsResult.ok
    ? statsResult.data
    : { total, byType: {}, byEntityType: {} };
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Top types for stat cards (top 3 by count)
  const topTypes = Object.entries(stats.byType)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">Things</h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Universal index of all tracked items across the knowledge base.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <ProfileStatCard
          label="Total Things"
          value={stats.total.toLocaleString()}
        />
        {topTypes.map(([type, count]) => (
          <ProfileStatCard
            key={type}
            label={formatType(type)}
            value={count.toLocaleString()}
            href={`/things?type=${encodeURIComponent(type)}`}
          />
        ))}
      </div>

      {/* Client component with search + filters + sortable table + pagination */}
      <ThingsTable
        rows={results}
        total={total}
        totalPages={totalPages}
        stats={stats}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}
