import {
  getKBEntities,
  getKBProperties,
  getKBFacts,
  getKBItems,
} from "@/data/kb";
import type { Fact, Entity } from "@longterm-wiki/kb";
import { KBEntitiesTable } from "./kb-entities-table";

export interface EntityRow {
  entityId: string;
  entityName: string;
  entityType: string;
  factCount: number;
  propertyCount: number;
  itemCount: number;
  sourceCoverage: number;
  properties: string[];
}

export function KBEntityCoverageContent() {
  const entities = getKBEntities();
  const properties = getKBProperties();
  const propertiesById = new Map(properties.map((p) => [p.id, p]));

  const rows: EntityRow[] = [];

  for (const entity of entities) {
    const facts: Fact[] = getKBFacts(entity.id);
    const structuredFacts = facts.filter((f) => f.propertyId !== "description");

    if (structuredFacts.length === 0) continue;

    const propertyIds = new Set(structuredFacts.map((f) => f.propertyId));
    const factsWithSource = structuredFacts.filter(
      (f) => f.source || f.sourceResource
    ).length;
    const sourceCoverage =
      structuredFacts.length > 0
        ? Math.round((factsWithSource / structuredFacts.length) * 100)
        : 0;

    // Count items across all collections
    let itemCount = 0;
    // We can't enumerate collections without the schema, so check common ones
    const commonCollections = [
      "funding-rounds",
      "key-people",
      "products",
      "model-releases",
      "board-members",
      "strategic-partnerships",
      "safety-milestones",
      "research-areas",
    ];
    for (const collection of commonCollections) {
      itemCount += getKBItems(entity.id, collection).length;
    }

    const propertyNames = [...propertyIds]
      .map((pid) => propertiesById.get(pid)?.name ?? pid)
      .sort();

    rows.push({
      entityId: entity.id,
      entityName: entity.name,
      entityType: entity.type,
      factCount: structuredFacts.length,
      propertyCount: propertyIds.size,
      itemCount,
      sourceCoverage,
      properties: propertyNames,
    });
  }

  rows.sort((a, b) => b.factCount - a.factCount);

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed mb-4">
        {rows.length} entities with structured KB data (excluding
        description-only entries). Sorted by fact count.
      </p>
      <KBEntitiesTable data={rows} />
    </>
  );
}
