import type { Metadata } from "next";
import { DataSourcesContent } from "./data-sources-content";

export const metadata: Metadata = {
  title: "Data Sources",
  description:
    "Structured data sources for grants, personnel, and investments — tracked with versioned snapshots and freshness monitoring.",
  robots: { index: false },
};

export default function DataSourcesPage() {
  return (
    <article className="container mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Data Sources</h1>
      <DataSourcesContent />
    </article>
  );
}
