import { Suspense } from "react";
import { getExploreItems } from "@/data";
import { ExploreGrid } from "@/components/explore/ExploreGrid";

export default function WikiIndex() {
  const items = getExploreItems();

  return (
    <div className="pt-4 pb-8">
      <Suspense fallback={<div className="max-w-7xl mx-auto px-6 text-muted-foreground">Loading...</div>}>
        <ExploreGrid items={items} />
      </Suspense>
    </div>
  );
}
