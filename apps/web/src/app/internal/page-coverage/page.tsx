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
      <p className="text-muted-foreground">
        Structural completeness scores for {items.length} pages.{" "}
        Each page is scored on 13 items (5 boolean + 8 numeric).{" "}
        <span className="text-emerald-500 font-medium">{greenCount}</span> green
        (&ge;75%),{" "}
        <span className="text-amber-500 font-medium">{amberCount}</span> amber
        (50–74%),{" "}
        <span className="text-red-500 font-medium">{redCount}</span> red
        (&lt;50%). Default sort: worst coverage first.
      </p>
      <CoverageTable data={items} />
    </article>
  );
}
