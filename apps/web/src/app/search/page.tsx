import type { Metadata } from "next";
import { SearchPageClient } from "./search-client";

export const metadata: Metadata = {
  title: "Search | Longterm Wiki",
  description: "Search across wiki pages, grants, funding rounds, benchmarks, and more.",
};

export default function SearchPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-extrabold tracking-tight mb-1">Search</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Search across wiki pages, grants, funding rounds, divisions, benchmarks, and more.
      </p>
      <SearchPageClient />
    </div>
  );
}
