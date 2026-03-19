import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchPageClient } from "./search-client";

export const metadata: Metadata = {
  title: "Search | Longterm Wiki",
  description: "Search across wiki pages, grants, funding rounds, benchmarks, and more.",
};

export default function SearchPage() {
  return (
    <Suspense fallback={<SearchSkeleton />}>
      <SearchPageClient />
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
