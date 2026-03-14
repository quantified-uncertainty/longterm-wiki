import type { Metadata } from "next";
import { getTypedEntities, isRisk } from "@/data";
import { titleCase } from "@/components/wiki/kb/format";
import { ProfileStatCard } from "@/components/directory";
import { RisksTable, type RiskRow } from "./risks-table";
import { getLikelihoodDisplay, getTimeframeDisplay } from "./risk-utils";

export const metadata: Metadata = {
  title: "Risks",
  description:
    "Directory of AI-related risks tracked in the knowledge base, including accident risks, misuse risks, structural risks, and epistemic risks.",
};

export default function RisksPage() {
  const allEntities = getTypedEntities();
  const risks = allEntities.filter(isRisk);

  const rows: RiskRow[] = risks.map((risk) => ({
    id: risk.id,
    name: risk.title,
    numericId: risk.numericId ?? null,
    wikiPageId: risk.numericId ?? null,
    riskCategory: risk.riskCategory ?? null,
    severity: risk.severity ? titleCase(risk.severity) : null,
    likelihood: getLikelihoodDisplay(risk.likelihood),
    timeHorizon: getTimeframeDisplay(risk.timeframe),
  }));

  // Compute summary stats
  const byCategory = {
    accident: rows.filter((r) => r.riskCategory === "accident").length,
    misuse: rows.filter((r) => r.riskCategory === "misuse").length,
    structural: rows.filter((r) => r.riskCategory === "structural").length,
    epistemic: rows.filter((r) => r.riskCategory === "epistemic").length,
  };
  const withSeverity = rows.filter((r) => r.severity != null).length;
  const withLikelihood = rows.filter((r) => r.likelihood != null).length;

  const stats = [
    { label: "Total Risks", value: String(rows.length) },
    { label: "Accident", value: String(byCategory.accident) },
    { label: "Misuse", value: String(byCategory.misuse) },
    { label: "Structural", value: String(byCategory.structural) },
    { label: "Epistemic", value: String(byCategory.epistemic) },
    { label: "With Severity", value: String(withSeverity) },
    { label: "With Likelihood", value: String(withLikelihood) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Risks
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of AI-related risks tracked in the knowledge base,
          including accident risks, misuse risks, structural risks, and
          epistemic risks.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      <RisksTable rows={rows} />
    </div>
  );
}
