import {
  getKBEntities,
  getKBProperties,
  getKBFacts,
  getKBItemCounts,
  getKBEntity,
  isFactExpired,
} from "@/data/kb";
import { getEntityHref } from "@/data";
import { formatKBFactValue } from "@/components/wiki/kb/format";

import type { FactRow, PropertyRow, EntityCoverageRow } from "./facts-table";
import { FactsDashboardTable } from "./facts-table";

// ---------------------------------------------------------------------------
// Helper: compute days between date string and today
// ---------------------------------------------------------------------------
function daysSince(dateStr: string): number | null {
  // Pad partial dates: "2024" -> "2024-01-01", "2024-06" -> "2024-06-01"
  const parts = dateStr.split("-");
  const padded =
    parts.length === 1
      ? `${parts[0]}-01-01`
      : parts.length === 2
        ? `${parts[0]}-${parts[1]}-01`
        : dateStr;
  const d = new Date(padded);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Stat card component
// ---------------------------------------------------------------------------
function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-4 shadow-sm">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {detail && (
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main content (server component)
// ---------------------------------------------------------------------------

export function FactsPageContent() {
  const kbEntities = getKBEntities();
  const kbProperties = getKBProperties();

  // Build property lookup
  const propertyMap = new Map(kbProperties.map((p) => [p.id, p]));

  // Compute per-entity stats
  const entitiesWithFacts: {
    entityId: string;
    entityName: string;
    entityType: string;
    facts: ReturnType<typeof getKBFacts>;
  }[] = [];

  for (const entity of kbEntities) {
    const facts = getKBFacts(entity.id);
    // Only include entities that have at least one non-description fact
    if (facts.some((f) => f.propertyId !== "description")) {
      entitiesWithFacts.push({
        entityId: entity.id,
        entityName: entity.name,
        entityType: entity.type,
        facts,
      });
    }
  }

  // Flatten all facts into rows
  const allFactRows: FactRow[] = [];
  let totalFacts = 0;
  let factsWithSource = 0;

  for (const entry of entitiesWithFacts) {
    const href = getEntityHref(entry.entityId);
    for (const fact of entry.facts) {
      // Skip description facts from the count (as specified)
      if (fact.propertyId === "description") continue;
      totalFacts++;
      if (fact.source || fact.sourceResource) factsWithSource++;

      const prop = propertyMap.get(fact.propertyId);
      let displayValue = formatKBFactValue(fact, prop?.unit, prop?.display);

      // Resolve ref/refs entity slugs to display names
      const v = fact.value;
      if (v.type === "ref") {
        const refEntity = getKBEntity(String(v.value));
        if (refEntity) displayValue = refEntity.name;
      } else if (v.type === "refs") {
        displayValue = v.value
          .map((slug) => {
            const refEntity = getKBEntity(slug);
            return refEntity?.name ?? slug;
          })
          .join(", ");
      }

      allFactRows.push({
        entityId: entry.entityId,
        entityName: entry.entityName,
        entityType: entry.entityType,
        entityHref: href,
        propertyId: fact.propertyId,
        propertyName: prop?.name ?? fact.propertyId,
        propertyCategory: prop?.category ?? "unknown",
        displayValue,
        asOf: fact.asOf ?? null,
        hasSource: !!(fact.source || fact.sourceResource),
        staleDays: fact.asOf ? daysSince(fact.asOf) : null,
        isExpired: isFactExpired(fact),
      });
    }
  }

  // Build property index
  const propFactCount = new Map<string, number>();
  const propEntitySet = new Map<string, Set<string>>();

  for (const row of allFactRows) {
    propFactCount.set(row.propertyId, (propFactCount.get(row.propertyId) ?? 0) + 1);
    if (!propEntitySet.has(row.propertyId)) {
      propEntitySet.set(row.propertyId, new Set());
    }
    propEntitySet.get(row.propertyId)!.add(row.entityId);
  }

  // Count applicable entities per property (based on appliesTo)
  const entityTypeCount = new Map<string, number>();
  for (const e of kbEntities) {
    entityTypeCount.set(e.type, (entityTypeCount.get(e.type) ?? 0) + 1);
  }

  const propertyRows: PropertyRow[] = kbProperties
    .filter((p) => !p.computed && p.id !== "description")
    .map((p) => {
      const fc = propFactCount.get(p.id) ?? 0;
      const ec = propEntitySet.get(p.id)?.size ?? 0;
      const applicableCount = p.appliesTo
        ? p.appliesTo.reduce((sum, t) => sum + (entityTypeCount.get(t) ?? 0), 0)
        : kbEntities.length;
      const coveragePct = applicableCount > 0 ? (ec / applicableCount) * 100 : 0;

      return {
        id: p.id,
        name: p.name,
        category: p.category ?? "general",
        dataType: p.dataType,
        factCount: fc,
        entityCount: ec,
        applicableCount,
        coveragePct,
      };
    })
    .sort((a, b) => b.factCount - a.factCount);

  // Build entity coverage rows
  const itemCounts = getKBItemCounts();
  const entityCoverageRows: EntityCoverageRow[] = entitiesWithFacts.map((entry) => {
    const nonDescFacts = entry.facts.filter((f) => f.propertyId !== "description");
    const withSource = nonDescFacts.filter((f) => f.source || f.sourceResource).length;
    const uniqueProps = new Set(nonDescFacts.map((f) => f.propertyId));

    return {
      entityId: entry.entityId,
      entityName: entry.entityName,
      entityType: entry.entityType,
      entityHref: getEntityHref(entry.entityId),
      factCount: nonDescFacts.length,
      itemCount: itemCounts.get(entry.entityId) ?? 0,
      sourceCoveragePct: nonDescFacts.length > 0 ? (withSource / nonDescFacts.length) * 100 : 0,
      propertyCount: uniqueProps.size,
    };
  });

  // Summary stats
  const totalEntities = kbEntities.length;
  const entitiesWithData = entitiesWithFacts.length;
  const sourceCoveragePct = totalFacts > 0 ? Math.round((factsWithSource / totalFacts) * 100) : 0;
  const propertiesDefined = kbProperties.filter((p) => !p.computed).length;
  const propertiesWithData = propEntitySet.size;
  const totalItems = Array.from(itemCounts.values()).reduce((s, c) => s + c, 0);

  return (
    <>
      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 mb-6">
        <StatCard
          label="Entities with KB Data"
          value={entitiesWithData}
          detail={`of ${totalEntities} total`}
        />
        <StatCard
          label="Structured Facts"
          value={totalFacts}
          detail="excluding descriptions"
        />
        <StatCard
          label="Source Coverage"
          value={`${sourceCoveragePct}%`}
          detail={`${factsWithSource} of ${totalFacts} sourced`}
        />
        <StatCard
          label="Item Entries"
          value={totalItems}
          detail={`across ${itemCounts.size} entities`}
        />
        <StatCard
          label="Properties"
          value={propertiesDefined}
          detail={`${propertiesWithData} with data`}
        />
        <StatCard
          label="Avg Facts / Entity"
          value={entitiesWithData > 0 ? Math.round(totalFacts / entitiesWithData) : 0}
          detail={`across ${entitiesWithData} entities`}
        />
      </div>

      {/* Interactive table with tabs */}
      <FactsDashboardTable
        facts={allFactRows}
        properties={propertyRows}
        entityCoverage={entityCoverageRows}
      />
    </>
  );
}

