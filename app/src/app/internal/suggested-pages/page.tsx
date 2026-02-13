import type { Metadata } from "next";
import { SuggestedPagesTable } from "./suggested-pages-table";
import { suggestions } from "./data";

export const metadata: Metadata = {
  title: "Suggested Pages | Longterm Wiki Internal",
  description:
    "Prioritized list of pages the wiki should add, based on gap analysis.",
};

export default function SuggestedPagesPage() {
  return (
    <article className="prose max-w-none">
      <h1>Suggested Pages</h1>
      <p className="text-muted-foreground">
        {suggestions.length} pages the wiki should add, ranked by priority.
        Priority is based on how often the topic is mentioned across existing
        pages and its importance to AI safety coverage. Sourced from the{" "}
        <a href="/internal/gap-analysis-2026-02">Feb 2026 gap analysis</a>.
      </p>
      <SuggestedPagesTable data={suggestions} />
    </article>
  );
}
