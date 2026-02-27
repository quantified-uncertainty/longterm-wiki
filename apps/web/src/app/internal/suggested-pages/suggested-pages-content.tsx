import { SuggestedPagesTable } from "./suggested-pages-table";
import { suggestions } from "./data";

export function SuggestedPagesContent() {
  return (
    <>
      <p className="text-muted-foreground">
        {suggestions.length} pages the wiki should add, ranked by priority.
        Priority is based on how often the topic is mentioned across existing
        pages and its importance to AI safety coverage. Sourced from the{" "}
        <a href="/wiki/E762">Feb 2026 gap analysis</a>.
      </p>
      <SuggestedPagesTable data={suggestions} />
    </>
  );
}
