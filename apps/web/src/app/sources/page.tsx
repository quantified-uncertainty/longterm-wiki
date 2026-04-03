import type { Metadata } from "next";
import { SourcesOverviewContent } from "@/app/sources/sources-overview-content";

export const metadata: Metadata = {
  title: "Sources",
  description:
    "Citation infrastructure for the AI safety wiki — resources, publications, source checks, and data sources.",
};

export default function SourcesPage() {
  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight mb-4">Sources</h1>
      <SourcesOverviewContent />
    </div>
  );
}
