import { Suspense } from "react";
import { getExploreItems } from "@/data";
import { ExploreGrid } from "@/components/explore/ExploreGrid";

/**
 * Fetch initial explore data from wiki-server during SSR.
 * Returns null on any failure — the client will use local fallback mode.
 */
async function fetchExploreSSR(search: string) {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) return null;

  try {
    const params = new URLSearchParams({
      limit: "50",
      offset: "0",
      sort: "recommended",
      search,
    });
    const headers: Record<string, string> = {};
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(`${serverUrl}/api/explore?${params}`, {
      headers,
      signal: AbortSignal.timeout(3000),
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function WikiIndex({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tag = typeof params.tag === "string" ? params.tag : "";

  // If there's a search tag, try server-side search for proper FTS ranking.
  // Otherwise, use local data (no server call needed for unfiltered view).
  const serverData = tag ? await fetchExploreSSR(tag) : null;

  const items = getExploreItems();

  return (
    <div className="pt-4 pb-8">
      <h1 className="sr-only">Longterm Wiki</h1>
      <Suspense fallback={<div className="max-w-7xl mx-auto px-6 text-muted-foreground">Loading...</div>}>
        <ExploreGrid
          initialItems={serverData?.items ?? items}
          initialTotal={serverData?.total ?? null}
          initialFacets={serverData?.facets ?? null}
          allItems={items}
        />
      </Suspense>
    </div>
  );
}
