import { Suspense } from "react";
import { getExploreItems } from "@/data";
import type { ExploreItem } from "@/data";
import { ExploreGrid } from "@/components/explore/ExploreGrid";
import { fetchFromWikiServer } from "@/lib/wiki-server";

interface ExploreResponse {
  items: ExploreItem[];
  total: number;
  limit: number;
  offset: number;
  facets: {
    clusters: Record<string, number>;
    categories: Record<string, number>;
    entityTypes: Record<string, number>;
    riskCategories: Record<string, number>;
  };
}

export default async function WikiIndex() {
  // Try fetching first page from wiki-server for a smaller initial payload
  const serverData = await fetchFromWikiServer<ExploreResponse>(
    "/api/explore?limit=50&offset=0&sort=recommended",
    { revalidate: 300 }
  );

  if (serverData) {
    // Server mode: pass initial page + facets, and all items for fallback
    const allItems = getExploreItems();
    return (
      <div className="pt-4 pb-8">
        <Suspense fallback={<div className="max-w-7xl mx-auto px-6 text-muted-foreground">Loading...</div>}>
          <ExploreGrid
            initialItems={serverData.items}
            initialTotal={serverData.total}
            initialFacets={serverData.facets}
            allItems={allItems}
          />
        </Suspense>
      </div>
    );
  }

  // Fallback: load all items locally (original behavior)
  const items = getExploreItems();
  return (
    <div className="pt-4 pb-8">
      <Suspense fallback={<div className="max-w-7xl mx-auto px-6 text-muted-foreground">Loading...</div>}>
        <ExploreGrid
          initialItems={items}
          initialTotal={null}
          initialFacets={null}
        />
      </Suspense>
    </div>
  );
}
