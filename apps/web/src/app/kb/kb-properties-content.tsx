import {
  getKBEntities,
  getKBProperties,
  getKBFacts,
} from "@/data/factbase";
import type { Fact } from "@longterm-wiki/factbase";
import { KBPropertiesTable } from "./kb-properties-table";

export interface PropertyRow {
  id: string;
  name: string;
  description: string;
  dataType: string;
  category: string;
  unit: string;
  temporal: boolean;
  computed: boolean;
  factCount: number;
  entityCount: number;
  appliesTo: string[];
  /** Coverage: entityCount / totalApplicableEntities */
  coverage: number;
}

export function KBPropertiesExplorerContent() {
  const entities = getKBEntities();
  const properties = getKBProperties();

  // Build entity type counts for coverage calculation
  const entityTypeCount = new Map<string, number>();
  for (const entity of entities) {
    entityTypeCount.set(
      entity.type,
      (entityTypeCount.get(entity.type) ?? 0) + 1
    );
  }

  // Compute per-property usage stats (excluding description)
  const propertyFacts = new Map<string, { factCount: number; entityIds: Set<string> }>();
  for (const entity of entities) {
    const facts: Fact[] = getKBFacts(entity.id);
    for (const fact of facts) {
      if (fact.propertyId === "description") continue;
      let entry = propertyFacts.get(fact.propertyId);
      if (!entry) {
        entry = { factCount: 0, entityIds: new Set() };
        propertyFacts.set(fact.propertyId, entry);
      }
      entry.factCount++;
      entry.entityIds.add(entity.id);
    }
  }

  const rows: PropertyRow[] = properties
    .filter((p) => p.id !== "description")
    .map((prop) => {
      const usage = propertyFacts.get(prop.id);
      const factCount = usage?.factCount ?? 0;
      const entityCount = usage?.entityIds.size ?? 0;

      // Calculate coverage based on appliesTo
      let totalApplicable = 0;
      if (prop.appliesTo && prop.appliesTo.length > 0) {
        for (const type of prop.appliesTo) {
          totalApplicable += entityTypeCount.get(type) ?? 0;
        }
      } else {
        totalApplicable = entities.length;
      }
      const coverage =
        totalApplicable > 0
          ? Math.round((entityCount / totalApplicable) * 100)
          : 0;

      return {
        id: prop.id,
        name: prop.name,
        description: prop.description ?? "",
        dataType: prop.dataType,
        category: prop.category ?? "other",
        unit: prop.unit ?? "",
        temporal: prop.temporal ?? false,
        computed: prop.computed ?? false,
        factCount,
        entityCount,
        appliesTo: prop.appliesTo ?? [],
        coverage,
      };
    })
    .sort((a, b) => b.factCount - a.factCount);

  const inUse = rows.filter((r) => r.factCount > 0).length;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed mb-4">
        {rows.length} properties defined ({inUse} in use). Coverage bars show
        what percentage of applicable entities have at least one fact for each
        property.
      </p>
      <KBPropertiesTable data={rows} />
    </>
  );
}
