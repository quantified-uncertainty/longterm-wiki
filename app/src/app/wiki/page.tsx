import { Suspense } from "react";
import { getExploreItems } from "@/data";
import { ExploreGrid } from "@/components/explore/ExploreGrid";

export default function WikiIndex() {
  const items = getExploreItems();

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <h1 className="text-3xl font-bold mb-2">Explore</h1>
      <p className="text-muted-foreground mb-8">
        Browse all entities in the AI safety knowledge base.
      </p>
      <Suspense fallback={<div className="text-muted-foreground">Loading...</div>}>
        <ExploreGrid items={items} />
      </Suspense>
    </div>
  );
}
