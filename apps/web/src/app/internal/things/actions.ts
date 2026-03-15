"use server";

import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityHref } from "@data/entity-nav";

export interface ThingSearchRow {
  id: string;
  thingType: string;
  title: string;
  parentThingId: string | null;
  parentTitle?: string;
  parentHref?: string;
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

interface ApiThing {
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
}

interface SearchResponse {
  results: ApiThing[];
  query: string;
  total: number;
  searchMethod: "fts" | "ilike";
}

// Entity types that have directory pages
const DIR_PREFIXES: Record<string, string> = {
  organization: "/organizations",
  person: "/people",
  risk: "/risks",
};

function resolveEntityHref(sourceId: string, entityType: string | null): string {
  let href = getEntityHref(sourceId);
  if (href?.startsWith("/wiki/") && entityType) {
    const prefix = DIR_PREFIXES[entityType];
    if (prefix) href = `${prefix}/${sourceId}`;
  }
  return href;
}

// ── Paginated listing ────────────────────────────────────────────────────

interface ListResponse {
  things: ApiThing[];
  total: number;
  limit: number;
  offset: number;
}

export async function fetchThingsPage(
  page: number,
  pageSize: number,
  thingType?: string,
): Promise<{ rows: ThingSearchRow[]; total: number } | null> {
  const offset = (page - 1) * pageSize;
  const params = new URLSearchParams({
    limit: String(pageSize),
    offset: String(offset),
    sort: "title",
    order: "asc",
  });
  if (thingType) params.set("thing_type", thingType);

  const data = await fetchFromWikiServer<ListResponse>(
    `/api/things?${params.toString()}`,
  );

  if (!data) return null;

  // Resolve parents
  const parentIds = new Set<string>();
  for (const item of data.things) {
    if (item.parentThingId) parentIds.add(item.parentThingId);
  }

  const parentMap = new Map<string, { title: string; href?: string }>();
  // Check within the page first
  for (const item of data.things) {
    if (parentIds.has(item.id)) {
      let href: string | undefined;
      if (item.thingType === "entity") {
        try { href = resolveEntityHref(item.sourceId, item.entityType); } catch { /* */ }
      }
      parentMap.set(item.id, { title: item.title, href });
    }
  }
  // Fetch missing parents (max 10)
  const missing = [...parentIds].filter((id) => !parentMap.has(id));
  for (const id of missing.slice(0, 10)) {
    const parent = await fetchFromWikiServer<ApiThing>(`/api/things/${encodeURIComponent(id)}`);
    if (parent) {
      let href: string | undefined;
      if (parent.thingType === "entity") {
        try { href = resolveEntityHref(parent.sourceId, parent.entityType); } catch { /* */ }
      }
      parentMap.set(id, { title: parent.title, href });
    }
  }

  const rows: ThingSearchRow[] = data.things.map((item) => {
    let href: string | undefined;
    if (item.thingType === "entity") {
      try { href = resolveEntityHref(item.sourceId, item.entityType); } catch { /* */ }
    } else if (item.thingType === "resource" && item.sourceId) {
      href = `/resources/${encodeURIComponent(item.sourceId)}`;
    } else if (item.sourceUrl) {
      href = item.sourceUrl;
    }
    const parent = item.parentThingId ? parentMap.get(item.parentThingId) : undefined;
    return { ...item, href, parentTitle: parent?.title, parentHref: parent?.href };
  });

  return { rows, total: data.total };
}

// ── Search ───────────────────────────────────────────────────────────────

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

  // Collect unique parentThingIds to resolve parent titles
  const parentIds = new Set<string>();
  for (const item of data.results) {
    if (item.parentThingId) parentIds.add(item.parentThingId);
  }

  // Batch-fetch parent things (they're usually entities)
  const parentMap = new Map<string, { title: string; href?: string }>();
  if (parentIds.size > 0) {
    // Parents are often in the search results themselves
    for (const item of data.results) {
      if (parentIds.has(item.id)) {
        let href: string | undefined;
        if (item.thingType === "entity") {
          try { href = resolveEntityHref(item.sourceId, item.entityType); } catch { /* */ }
        }
        parentMap.set(item.id, { title: item.title, href });
      }
    }

    // Fetch remaining parents not in search results
    const missing = [...parentIds].filter((id) => !parentMap.has(id));
    for (const id of missing.slice(0, 10)) {
      const parent = await fetchFromWikiServer<ApiThing>(`/api/things/${encodeURIComponent(id)}`);
      if (parent) {
        let href: string | undefined;
        if (parent.thingType === "entity") {
          try { href = resolveEntityHref(parent.sourceId, parent.entityType); } catch { /* */ }
        }
        parentMap.set(id, { title: parent.title, href });
      }
    }
  }

  // Resolve hrefs and parents
  const results: ThingSearchRow[] = data.results.map((item) => {
    let href: string | undefined;
    if (item.thingType === "entity") {
      try { href = resolveEntityHref(item.sourceId, item.entityType); } catch { /* */ }
    } else if (item.thingType === "resource" && item.sourceId) {
      href = `/resources/${encodeURIComponent(item.sourceId)}`;
    } else if (item.sourceUrl) {
      href = item.sourceUrl;
    }

    const parent = item.parentThingId ? parentMap.get(item.parentThingId) : undefined;

    return {
      ...item,
      href,
      parentTitle: parent?.title,
      parentHref: parent?.href,
    };
  });

  return { results, total: data.total };
}
