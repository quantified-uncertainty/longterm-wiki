import { getPageCoverageItems } from "@/data";
import { CoverageTable } from "./coverage-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page Coverage | Longterm Wiki Internal",
  description:
    "All wiki pages ranked by structural coverage — boolean completeness items and numeric metrics.",
};

export default function PageCoveragePage() {
  const items = getPageCoverageItems();

  const greenCount = items.filter(
    (i) => i.score / i.total >= 0.75
  ).length;
  const amberCount = items.filter(
    (i) => i.score / i.total >= 0.5 && i.score / i.total < 0.75
  ).length;
  const redCount = items.filter((i) => i.score / i.total < 0.5).length;

  return (
    <article className="prose max-w-none">
      <h1>Page Coverage</h1>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Structural completeness scores for {items.length} pages. Each page is
        scored on <strong>13 items</strong>: 5 boolean checks (LLM summary,
        structured summary, update schedule, entity, edit history) and 8 numeric
        metrics (tables, diagrams, internal links, external links, footnotes,
        references, quotes, accuracy). Colored dots indicate status:{" "}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />{" "}
          green (meets target)
        </span>
        ,{" "}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />{" "}
          amber (partially met)
        </span>
        ,{" "}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-red-400/60" />{" "}
          red (missing)
        </span>
        . Hover column headers for details. Default sort: worst coverage first.
      </p>
      <p className="text-muted-foreground text-xs">
        <span className="text-emerald-500 font-medium">{greenCount}</span>{" "}
        green (&ge;75%),{" "}
        <span className="text-amber-500 font-medium">{amberCount}</span> amber
        (50–74%),{" "}
        <span className="text-red-500 font-medium">{redCount}</span> red
        (&lt;50%).
      </p>
      <CoverageTable data={items} />
    </article>
  );
}
