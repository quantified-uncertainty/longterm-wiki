import type { Metadata } from "next";
import { getTypedEntities, isPolicy } from "@/data";
import { LegislationTable, type LegislationRow } from "./legislation-table";
import { normalizeStatus } from "./legislation-constants";
import { getCustomField, getPolicyWikiHref } from "./legislation-utils";

export const metadata: Metadata = {
  title: "Legislation",
  description:
    "Directory of AI-related legislation, policies, and regulatory frameworks tracked in the knowledge base.",
};

export default function LegislationPage() {
  const allEntities = getTypedEntities();
  const policies = allEntities.filter(isPolicy);

  const rows: LegislationRow[] = policies.map((entity) => {
    // Extract status from typed field or customFields
    const rawStatus =
      entity.policyStatus ??
      getCustomField(entity, "Status") ??
      getCustomField(entity, "Vetoed")
        ? "Vetoed"
        : getCustomField(entity, "Enacted")
          ? "Enacted"
          : null;

    // Extract author from typed field or customFields
    const author =
      entity.author ?? getCustomField(entity, "Author") ?? null;

    // Extract introduced date
    const introduced =
      entity.introduced ?? getCustomField(entity, "Introduced") ?? null;

    // Infer scope from tags or typed field
    const scope =
      entity.scope ?? inferScope(entity.tags, entity.id) ?? null;

    // Infer status from customFields if not set
    let effectiveStatus = rawStatus;
    if (!effectiveStatus) {
      if (getCustomField(entity, "Vetoed")) effectiveStatus = "Vetoed";
      else if (getCustomField(entity, "Enacted")) effectiveStatus = "Enacted";
      else if (getCustomField(entity, "Signed")) effectiveStatus = "Enacted";
      else if (
        getCustomField(entity, "In Force") ||
        getCustomField(entity, "Effective")
      )
        effectiveStatus = "In Effect";
    }

    return {
      id: entity.id,
      title: entity.title,
      numericId: entity.numericId ?? null,
      introduced,
      policyStatus: effectiveStatus,
      statusKey: normalizeStatus(effectiveStatus),
      author,
      scope,
      description: entity.description ?? null,
      tags: entity.tags,
      sourceCount: entity.sources.length,
      relatedCount: entity.relatedEntries.length,
      hasWikiPage: !!entity.numericId,
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
          <div
            key={stat.label}
            className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4"
          >
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
              {stat.label}
            </div>
            <div className="text-2xl font-bold tabular-nums tracking-tight">
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <LegislationTable rows={rows} />
    </div>
  );
}

/** Infer scope from entity tags or ID. */
function inferScope(tags: string[], id: string): string | null {
  if (tags.includes("state-policy") || id.startsWith("california-") || id.startsWith("colorado-") || id.startsWith("new-york-")) return "State";
  if (tags.includes("federal") || id.startsWith("us-")) return "Federal";
  if (tags.includes("international") || id.startsWith("eu-") || id.includes("international")) return "International";
  if (id.startsWith("canada-") || id.startsWith("china-") || id.startsWith("uk-")) return "National";
  return null;
}
