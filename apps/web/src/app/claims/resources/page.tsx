import type { Metadata } from "next";
import {
  getAllResources,
  getPagesForResource,
  getResourceCredibility,
  getResourcePublication,
} from "@/data";
import { StatCard } from "../components/stat-card";
import { ResourcesTable } from "./resources-table";
import type { ResourceRow } from "./resources-table";

export const metadata: Metadata = {
  title: "Resources — Claims Explorer | Longterm Wiki",
  description:
    "Browse external resources (papers, articles, reports) referenced across wiki pages.",
};

export default function ResourcesPage() {
  const resources = getAllResources();

  const rows: ResourceRow[] = resources.map((r) => {
    const publication = getResourcePublication(r);
    const credibility = getResourceCredibility(r);
    const citingPages = getPagesForResource(r.id);

    return {
      id: r.id,
      title: r.title,
      url: r.url,
      type: r.type,
      publicationName: publication?.name ?? null,
      credibility: credibility ?? null,
      citingPageCount: citingPages.length,
      publishedDate: r.published_date ?? null,
      hasSummary: !!r.summary,
    };
  });

  const cited = rows.filter((r) => r.citingPageCount > 0).length;
  const withSummary = rows.filter((r) => r.hasSummary).length;
  const withCredibility = rows.filter((r) => r.credibility != null).length;

  // Type distribution for the compact breakdown
  const typeCounts = new Map<string, number>();
  for (const r of rows) {
    typeCounts.set(r.type, (typeCounts.get(r.type) || 0) + 1);
  }
  const typeEntries = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Resources</h1>
      <p className="text-muted-foreground mb-6">
        {resources.length.toLocaleString()} external resources (papers,
        articles, reports) referenced across wiki pages.
      </p>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Resources" value={resources.length} />
        <StatCard label="Cited by Pages" value={cited} />
        <StatCard label="With Summary" value={withSummary} />
        <StatCard label="With Credibility" value={withCredibility} />
      </div>

      {/* Type breakdown — compact horizontal summary */}
      <div className="rounded-lg border p-4 mb-6">
        <h3 className="text-sm font-semibold mb-3">Type Distribution</h3>
        <div className="space-y-2">
          {/* Segmented bar with labels for segments > 4% */}
          <div className="flex h-6 rounded overflow-hidden text-[10px] font-medium">
            {typeEntries.map(([type, count]) => {
              const pct = (count / resources.length) * 100;
              return (
                <div
                  key={type}
                  className={`flex items-center justify-center transition-all ${TYPE_BAR_COLORS[type] ?? "bg-gray-300 text-gray-700"}`}
                  style={{ width: `${pct}%` }}
                  title={`${type}: ${count.toLocaleString()} (${pct.toFixed(1)}%)`}
                >
                  {pct > 6 && (
                    <span className="truncate px-1 capitalize">
                      {type} {count.toLocaleString()}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {/* Legend for smaller segments */}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {typeEntries.map(([type, count]) => (
              <span
                key={type}
                className="text-xs text-muted-foreground flex items-center gap-1.5"
              >
                <span
                  className={`inline-block w-2.5 h-2.5 rounded-sm ${TYPE_BAR_COLORS[type] ?? "bg-gray-300"}`}
                />
                <span className="capitalize">{type}</span>
                <span className="tabular-nums">
                  ({count.toLocaleString()})
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <ResourcesTable resources={rows} />
    </div>
  );
}

/** Colors for the segmented type bar — need both bg and text for label readability */
const TYPE_BAR_COLORS: Record<string, string> = {
  web: "bg-slate-400 text-white",
  blog: "bg-purple-400 text-white",
  paper: "bg-blue-400 text-white",
  government: "bg-indigo-400 text-white",
  reference: "bg-cyan-400 text-white",
  talk: "bg-orange-400 text-white",
  report: "bg-teal-400 text-white",
  podcast: "bg-pink-400 text-white",
  book: "bg-amber-400 text-white",
};
