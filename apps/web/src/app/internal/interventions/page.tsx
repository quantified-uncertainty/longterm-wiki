import { getInterventions, getEntityHref } from "@/data";
import {
  InterventionsTable,
  type InterventionRow,
  type InterventionSummary,
} from "./interventions-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Interventions Dashboard | Longterm Wiki Internal",
  description:
    "Browse all AI safety interventions with risk coverage, ITN analysis, and funding data.",
};

const RISK_TYPES = ["accident", "misuse", "structural", "epistemic"] as const;

export default function InterventionsPage() {
  const interventions = getInterventions();

  const rows: InterventionRow[] = interventions.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category || "unknown",
    description: item.description || "",
    overallPriority: item.overallPriority || "Medium",
    timelineFit: item.timelineFit || "",
    tractability: item.tractability || "",
    neglectedness: item.neglectedness || "",
    importance: item.importance || "",
    fundingLevel: item.fundingLevel || "",
    fundingShare: item.fundingShare || "",
    recommendedShift: item.recommendedShift || "",
    riskCoverage: {
      accident: item.riskCoverage?.accident || "none",
      misuse: item.riskCoverage?.misuse || "none",
      structural: item.riskCoverage?.structural || "none",
      epistemic: item.riskCoverage?.epistemic || "none",
    },
    primaryMechanism: item.primaryMechanism || "",
    currentState: item.currentState || "",
    wikiPageHref: item.wikiPageId ? getEntityHref(item.wikiPageId) : null,
    relatedInterventions: item.relatedInterventions || [],
    relevantResearch: item.relevantResearch || [],
  }));

  // Compute summary stats
  const byPriority: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let recommendedIncreases = 0;

  for (const row of rows) {
    byPriority[row.overallPriority] = (byPriority[row.overallPriority] || 0) + 1;
    byCategory[row.category] = (byCategory[row.category] || 0) + 1;
    if (row.recommendedShift.toLowerCase().startsWith("increase")) {
      recommendedIncreases++;
    }
  }

  // Count interventions with medium+ coverage per risk type (sorted ascending = weakest first)
  const riskGaps = RISK_TYPES.map((risk) => ({
    risk,
    coverageCount: rows.filter(
      (r) => r.riskCoverage[risk] === "medium" || r.riskCoverage[risk] === "high"
    ).length,
  })).sort((a, b) => a.coverageCount - b.coverageCount);

  const summary: InterventionSummary = {
    total: rows.length,
    byPriority,
    byCategory,
    riskGaps,
    recommendedIncreases,
  };

  return (
    <article className="prose max-w-none">
      <h1>Interventions Dashboard</h1>
      <p className="text-muted-foreground">
        AI safety interventions from <code>data/interventions.yaml</code> with
        risk coverage, ITN analysis, and funding allocation. Click any row to
        expand full details.
      </p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground italic">
          No interventions loaded. Ensure{" "}
          <code>data/interventions.yaml</code> exists and run{" "}
          <code>pnpm build</code>.
        </p>
      ) : (
        <InterventionsTable data={rows} summary={summary} />
      )}
    </article>
  );
}
