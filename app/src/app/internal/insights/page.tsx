import { getInsights } from "@/data";
import { InsightsTable } from "./insights-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Critical Insights Index | Longterm Wiki Internal",
  description:
    "Prioritized table of all insights extracted from wiki content, sortable by composite score and individual dimensions.",
};

export default function InsightsPage() {
  const insights = getInsights();

  const byType: Record<string, number> = {};
  for (const i of insights) {
    byType[i.type] = (byType[i.type] || 0) + 1;
  }

  return (
    <article className="prose max-w-none">
      <h1>Critical Insights Index</h1>
      <p className="text-muted-foreground">
        All {insights.length} insights extracted from wiki pages, ranked by
        composite score (average of surprising, important, actionable, neglected,
        and compact). Each dimension is rated 1-5 for an AI safety researcher
        audience.
        {Object.keys(byType).length > 0 && (
          <>
            {" "}
            Types:{" "}
            {Object.entries(byType)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => `${type} (${count})`)
              .join(", ")}
            .
          </>
        )}
      </p>
      <InsightsTable data={insights} />
    </article>
  );
}
