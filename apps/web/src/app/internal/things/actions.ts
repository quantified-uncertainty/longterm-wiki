"use server";

import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityHref } from "@data/entity-nav";

export interface ThingSearchRow {
  id: string;
  thingType: string;
  title: string;
  parentThingId: string | null;
  sourceTable: string;
  sourceId: string;
  entityType: string | null;
  description: string | null;
  sourceUrl: string | null;
  numericId: string | null;
  verdict: string | null;
  verdictConfidence: number | null;
  href?: string;
}

interface SearchResponse {
  results: ThingSearchRow[];
  query: string;
  total: number;
  searchMethod: "fts" | "ilike";
}

export async function searchThings(
  query: string,
  thingType?: string,
): Promise<{ results: ThingSearchRow[]; total: number } | null> {
  if (!query || query.length < 2) return null;

  const params = new URLSearchParams({ q: query, limit: "50" });
  if (thingType) params.set("thing_type", thingType);

  const data = await fetchFromWikiServer<SearchResponse>(
    `/api/things/search?${params.toString()}`,
  );

  if (!data) return null;

  // Resolve hrefs server-side (getEntityHref needs database.json)
  const results = data.results.map((item) => {
    let href: string | undefined;
    if (item.thingType === "entity") {
      try { href = getEntityHref(item.sourceId); } catch { /* not in db */ }
    } else if (item.thingType === "resource" && item.sourceId) {
      href = `/resources/${encodeURIComponent(item.sourceId)}`;
    } else if (item.sourceUrl) {
      href = item.sourceUrl;
    }
    return { ...item, href };
  });

  return { results, total: data.total };
}
