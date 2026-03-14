import type { Metadata } from "next";
import { getTypedEntities, isPolicy } from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { LegislationTable, type LegislationRow } from "./legislation-table";
import { normalizeStatus } from "./legislation-constants";
import { deriveStatus, getPolicyScope } from "./legislation-utils";

export const metadata: Metadata = {
  title: "Legislation",
  description:
    "Directory of AI-related legislation, policies, and regulatory frameworks tracked in the knowledge base.",
};

export default function LegislationPage() {
  const allEntities = getTypedEntities();
  const policies = allEntities.filter(isPolicy);

  const rows: LegislationRow[] = policies.map((entity) => {
    const effectiveStatus = deriveStatus(entity);
    const scope = getPolicyScope(entity);

    return {
      id: entity.id,
      title: entity.title,
      numericId: entity.numericId ?? null,
      introduced: entity.introduced ?? null,
      policyStatus: effectiveStatus,
      statusKey: normalizeStatus(effectiveStatus),
      author: entity.author ?? null,
      scope,
      description: entity.description ?? null,
      tags: entity.tags,
      sourceCount: entity.sources.length,
    };
  });

  // Stats
  const totalPolicies = rows.length;
  const withStatus = rows.filter((r) => r.statusKey != null).length;
  const enacted = rows.filter((r) =>
    r.statusKey === "enacted" || r.statusKey === "in-effect",
  ).length;
  const vetoed = rows.filter((r) => r.statusKey === "vetoed").length;

  const stats = [
    { label: "Policies", value: String(totalPolicies) },
    { label: "With Status", value: String(withStatus) },
    { label: "Enacted / In Effect", value: String(enacted) },
    { label: "Vetoed", value: String(vetoed) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Legislation
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          AI-related legislation, policies, and regulatory frameworks. Includes
          national and international laws, executive orders, and proposed bills.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      <LegislationTable rows={rows} />
    </div>
  );
}
