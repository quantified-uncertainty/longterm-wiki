import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchPageClient, type BrowseData } from "./search-client";
import { getExploreItems } from "@data/explore";

export const metadata: Metadata = {
  title: "Search | Longterm Wiki",
  description: "Search across wiki pages, entities, grants, resources, and more.",
};

/** Directory types that have dedicated browse pages. */
const DIRECTORY_TYPES: Record<string, { href: string; label: string }> = {
  organization: { href: "/organizations", label: "Organizations" },
  person: { href: "/people", label: "People" },
  policy: { href: "/legislation", label: "Legislation" },
  "ai-model": { href: "/ai-models", label: "AI Models" },
  project: { href: "/projects", label: "Projects" },
  approach: { href: "/approaches", label: "Approaches" },
  event: { href: "/events", label: "Events" },
  benchmark: { href: "/benchmarks", label: "Benchmarks" },
  "research-area": { href: "/research-areas", label: "Research Areas" },
};

function buildBrowseData(): BrowseData {
  const items = getExploreItems();

  // Count entities by type (only types with directory pages)
  const typeCounts: Record<string, number> = {};
  for (const item of items) {
    if (DIRECTORY_TYPES[item.type]) {
      typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
    }
  }

  const directories = Object.entries(DIRECTORY_TYPES)
    .filter(([type]) => (typeCounts[type] ?? 0) > 0)
    .map(([type, meta]) => ({
      type,
      label: meta.label,
      href: meta.href,
      count: typeCounts[type] ?? 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Top entities by readerImportance (exclude internal)
  const featured = items
    .filter((item) =>
      item.type !== "internal" &&
      item.readerImportance != null &&
      item.readerImportance > 0 &&
      item.wikiId
    )
    .sort((a, b) => (b.readerImportance ?? 0) - (a.readerImportance ?? 0))
    .slice(0, 12)
    .map((item) => ({
      id: item.id,
      wikiId: item.wikiId,
      title: item.title,
      type: item.type,
      description: item.description,
      readerImportance: item.readerImportance,
      href: item.href ?? (DIRECTORY_TYPES[item.type]
        ? `${DIRECTORY_TYPES[item.type].href}/${item.id}`
        : `/wiki/${item.wikiId}`),
    }));

  // Recently updated articles
  const recent = items
    .filter((item) =>
      item.type !== "internal" &&
      item.lastUpdated &&
      item.wikiId
    )
    .sort((a, b) => (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? ""))
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      wikiId: item.wikiId,
      title: item.title,
      type: item.type,
      lastUpdated: item.lastUpdated,
      href: item.href ?? (DIRECTORY_TYPES[item.type]
        ? `${DIRECTORY_TYPES[item.type].href}/${item.id}`
        : `/wiki/${item.wikiId}`),
    }));

  return { directories, featured, recent, totalPages: items.length };
}

export default function SearchPage() {
  const browseData = buildBrowseData();

  return (
    <Suspense fallback={<SearchSkeleton />}>
      <SearchPageClient browseData={browseData} />
    </Suspense>
  );
}

function SearchSkeleton() {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-12 pb-8">
      <div className="h-12 rounded-xl bg-muted/30 animate-pulse" />
    </div>
  );
}
