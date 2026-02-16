import { getInterventions, getEntityHref } from "@/data";
import { InterventionsTable, type InterventionRow } from "./interventions-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Interventions Dashboard | Longterm Wiki Internal",
  description:
    "Browse all AI safety interventions with risk coverage, ITN analysis, and funding data.",
};

export default function InterventionsPage() {
  const interventions = getInterventions();

  const categories = new Set(interventions.map((i) => i.category).filter(Boolean));
  const priorities = new Set(interventions.map((i) => i.overallPriority).filter(Boolean));

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

  return (
    <article className="prose max-w-none">
      <h1>Interventions Dashboard</h1>
      <p className="text-muted-foreground">
        All AI safety interventions from{" "}
        <code>data/interventions.yaml</code>.{" "}
        <span className="font-medium text-foreground">
          {interventions.length}
        </span>{" "}
        interventions across{" "}
        <span className="font-medium text-foreground">{categories.size}</span>{" "}
        categories and{" "}
        <span className="font-medium text-foreground">{priorities.size}</span>{" "}
        priority levels.
      </p>
      {interventions.length === 0 ? (
        <p className="text-muted-foreground italic">
          No interventions loaded. Ensure{" "}
          <code>data/interventions.yaml</code> exists and run{" "}
          <code>pnpm build</code>.
        </p>
      ) : (
        <InterventionsTable data={rows} />
      )}
    </article>
  );
}
