import type { Metadata } from "next";
import { getKBEntities, getKBLatest, getKBEntitySlug } from "@/data/kb";
import { getTypedEntityById, isRisk } from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { formatKBFactValue } from "@/components/wiki/kb/format";
import { RisksTable, type RiskRow } from "./risks-table";
import type { Fact } from "@longterm-wiki/kb";

export const metadata: Metadata = {
  title: "Risks",
  description:
    "Directory of AI-related risks tracked in the knowledge base, including accident risks, misuse risks, structural risks, and epistemic risks.",
};

/** Extract a text value from a KB fact for display. */
function textValue(fact: Fact | undefined): string | null {
  if (!fact) return null;
  return formatKBFactValue(fact);
}

export default function RisksPage() {
  const allEntities = getKBEntities();
  const risks = allEntities.filter((e) => e.type === "risk");

  const rows: RiskRow[] = risks.map((entity) => {
    const typedEntity = getTypedEntityById(entity.id);
    const riskCategory =
      typedEntity && isRisk(typedEntity) ? (typedEntity.riskCategory ?? null) : null;

    const severityFact = getKBLatest(entity.id, "severity-level");
    const likelihoodFact = getKBLatest(entity.id, "likelihood-estimate");
    const timeHorizonFact = getKBLatest(entity.id, "time-horizon");
    const evidenceFact = getKBLatest(entity.id, "evidence-strength");
    const consensusFact = getKBLatest(entity.id, "expert-consensus-level");

    return {
      id: entity.id,
      slug: getKBEntitySlug(entity.id) ?? null,
      name: entity.name,
      numericId: entity.numericId ?? null,
      wikiPageId: entity.wikiPageId ?? entity.numericId ?? null,
      riskCategory,
      severity: textValue(severityFact),
      likelihood: textValue(likelihoodFact),
      timeHorizon: textValue(timeHorizonFact),
      evidenceStrength: textValue(evidenceFact),
      expertConsensus: textValue(consensusFact),
    };
  });

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
    { label: "With Severity Data", value: String(withSeverity) },
    { label: "With Likelihood Data", value: String(withLikelihood) },
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
