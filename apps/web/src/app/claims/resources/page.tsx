import type { Metadata } from "next";
import Link from "next/link";
import {
  getAllResources,
  getPagesForResource,
  getResourceCredibility,
  getResourcePublication,
} from "@data";
import { getResourceTypeIcon } from "@/components/wiki/resource-utils";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import { StatCard } from "../components/stat-card";
import { DistributionBar } from "../components/distribution-bar";
import { ResourcesTable } from "./resources-table";

export const metadata: Metadata = {
  title: "Resources — Claims Explorer",
  description:
    "Browse external resources (papers, articles, reports) referenced across the wiki.",
};

export interface PublicResourceRow {
  id: string;
  title: string;
  url: string | undefined;
  type: string;
  publishedDate: string | null;
  publicationName: string | null;
  credibility: number | null;
  citingPageCount: number;
  hasSummary: boolean;
}

export default function ResourcesPage() {
  const resources = getAllResources();

  const rows: PublicResourceRow[] = resources
    .map((r) => {
      const publication = getResourcePublication(r);
      const credibility = getResourceCredibility(r);
      const citingPages = getPagesForResource(r.id);

      return {
        id: r.id,
        title: r.title,
        url: r.url,
        type: r.type,
        publishedDate: r.published_date ?? null,
        publicationName: publication?.name ?? null,
        credibility: credibility ?? null,
        citingPageCount: citingPages.length,
        hasSummary: !!r.summary,
      };
    })
    .sort((a, b) => b.citingPageCount - a.citingPageCount);

  // Stats
  const cited = rows.filter((r) => r.citingPageCount > 0).length;
  const withSummary = rows.filter((r) => r.hasSummary).length;

  // Type distribution
  const byType: Record<string, number> = {};
  for (const r of rows) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">Resources</h1>
        <p className="text-muted-foreground text-sm">
          {resources.length.toLocaleString()} external resources (papers,
          articles, reports) referenced across wiki pages.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Resources" value={resources.length} />
        <StatCard label="Cited by Pages" value={cited} />
        <StatCard label="With Summary" value={withSummary} />
        <StatCard
          label="Resource Types"
          value={Object.keys(byType).length}
        />
      </div>

      {Object.keys(byType).length > 0 && (
        <div className="rounded-lg border p-4 mb-6">
          <h3 className="text-sm font-semibold mb-3">Type Distribution</h3>
          <DistributionBar data={byType} total={resources.length} />
        </div>
      )}

      <ResourcesTable resources={rows} />
    </div>
  );
}