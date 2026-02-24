import { getPageCoverageItems } from "@/data";
import { CoverageTable } from "./coverage-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pages | Longterm Wiki Internal",
  description:
    "Comprehensive admin view of all wiki pages — quality, coverage, citations, risk, and update status.",
};

export default function PageCoveragePage() {
  const items = getPageCoverageItems();

  const withQuality = items.filter((i) => i.quality != null).length;
  const avgQuality =
    withQuality > 0
      ? Math.round(
          items.reduce((sum, i) => sum + (i.quality ?? 0), 0) / withQuality
        )
      : 0;
  const highRisk = items.filter((i) => i.riskLevel === "high").length;

  return (
    <article className="prose max-w-none">
      <h1>Pages</h1>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Admin overview of {items.length} wiki pages. Use{" "}
        <strong>preset buttons</strong> to switch between views (overview,
        coverage, quality, citations, updates) or toggle individual columns.
        Hover column headers for descriptions.
      </p>
      <p className="text-muted-foreground text-xs">
        {withQuality} rated (avg quality {avgQuality}),{" "}
        <span className="text-red-500 font-medium">{highRisk}</span> high
        hallucination risk.
      </p>
      <CoverageTable data={items} />
    </article>
  );
}
