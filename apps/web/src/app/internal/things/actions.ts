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

// ── Link resolution ─────────────────────────────────────────────────────

// Entity types with directory pages where sourceId = slug
const ENTITY_DIR_PREFIXES: Record<string, string> = {
  organization: "/organizations",
  person: "/people",
  risk: "/risks",
  benchmark: "/benchmarks",
  "ai-model": "/ai-models",
  policy: "/legislation",
};

// Thing types with dedicated detail pages (sourceId = KB record key)
const THING_DETAIL_ROUTES: Record<string, string> = {
  grant: "/grants",
  resource: "/resources",
  division: "/divisions",
  "funding-program": "/funding-programs",
  "funding-round": "/funding-rounds",
  investment: "/investments",
  benchmark: "/benchmarks",
};

function resolveThingHref(item: ApiThing): string | undefined {
  if (item.thingType === "entity") {
    try {
      let href = getEntityHref(item.sourceId);
      // getEntityHref may fall back to /wiki/E{id} when KB slug lookup fails.
      // For directory types, use the slug directly since sourceId = entity slug.
      if (href?.startsWith("/wiki/") && item.entityType) {
        const prefix = ENTITY_DIR_PREFIXES[item.entityType];
        if (prefix) href = `${prefix}/${item.sourceId}`;
      }
      return href;
    } catch {
      // Entity not in database.json — fall through
    }
    return undefined;
  }

  // Types with dedicated detail pages
  const prefix = THING_DETAIL_ROUTES[item.thingType];
  if (prefix && item.sourceId) {
    return `${prefix}/${encodeURIComponent(item.sourceId)}`;
  }

  // Facts: link to parent entity page (sourceId format: "entityId:factId")
  if (item.thingType === "fact" && item.sourceId.includes(":")) {
    const entityId = decodeURIComponent(item.sourceId.split(":")[0]);
    try {
      return getEntityHref(entityId);
    } catch {
      // Entity not in database.json
    }
  }

  return undefined;
}

// ── Parent resolution ───────────────────────────────────────────────────

async function resolveParents(
  items: ApiThing[],
): Promise<Map<string, { title: string; href?: string }>> {
  const parentIds = new Set<string>();
  for (const item of items) {
    if (item.parentThingId) parentIds.add(item.parentThingId);
  }

  const parentMap = new Map<string, { title: string; href?: string }>();
  if (parentIds.size === 0) return parentMap;

  // Check within the loaded items first
  for (const item of items) {
    if (parentIds.has(item.id)) {
      parentMap.set(item.id, { title: item.title, href: resolveThingHref(item) });
    }
  }

  // Fetch missing parents in parallel (max 10)
  const missing = [...parentIds].filter((id) => !parentMap.has(id)).slice(0, 10);
  if (missing.length > 0) {
    const results = await Promise.all(
      missing.map(async (id) => {
        const parent = await fetchFromWikiServer<ApiThing>(
          `/api/things/${encodeURIComponent(id)}`,
        );
        return { id, parent };
      }),
    );
    for (const { id, parent } of results) {
      if (parent) {
        parentMap.set(id, { title: parent.title, href: resolveThingHref(parent) });
      }
    }
  }

  return parentMap;
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

  const parentMap = await resolveParents(data.things);

  const rows: ThingSearchRow[] = data.things.map((item) => {
    const href = resolveThingHref(item);
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

  const parentMap = await resolveParents(data.results);

  const results: ThingSearchRow[] = data.results.map((item) => {
    const href = resolveThingHref(item);
    const parent = item.parentThingId ? parentMap.get(item.parentThingId) : undefined;
    return { ...item, href, parentTitle: parent?.title, parentHref: parent?.href };
  });

  return { results, total: data.total };
}
