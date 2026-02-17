import { Suspense } from "react";
import { getExploreItems } from "@/data";
import { ExploreGrid } from "@/components/explore/ExploreGrid";

export default function WikiIndex() {
  const items = getExploreItems();

  return (
    <div className="py-8">
      <div className="max-w-7xl mx-auto px-6">
        <h1 className="text-3xl font-bold mb-2">Explore</h1>
        <p className="text-muted-foreground mb-8">
          Browse all entities in the AI safety knowledge base.
        </p>
      </div>
      <Suspense fallback={<div className="max-w-7xl mx-auto px-6 text-muted-foreground">Loading...</div>}>
        <ExploreGrid items={items} />
      </Suspense>
    </div>
  );
}
