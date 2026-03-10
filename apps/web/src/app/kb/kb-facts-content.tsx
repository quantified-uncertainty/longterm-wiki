import {
  getKBEntities,
  getKBProperties,
  getKBFacts,
} from "@/data/kb";
import type { Fact, Property, Entity } from "@longterm-wiki/kb";
import { formatKBFactValue, formatKBDate } from "@/components/wiki/kb/format";
import { KBFactsTable } from "./kb-facts-table";

export interface FactRow {
  factId: string;
  entityId: string;
  entityName: string;
  entityType: string;
  propertyId: string;
  propertyName: string;
  category: string;
  displayValue: string;
  rawRefValues: string[] | null;
  asOf: string;
  source: string;
  hasSource: boolean;
}

function resolveRefDisplayNames(
  fact: Fact,
  entitiesById: Map<string, Entity>,
): string[] | null {
  const v = fact.value;
  if (v.type === "ref") {
    const entity = entitiesById.get(v.value);
    return [entity ? entity.name : v.value];
  }
  if (v.type === "refs") {
    return v.value.map((refId: string) => {
      const entity = entitiesById.get(refId);
      return entity ? entity.name : refId;
    });
  }
  return null;
}

export function KBFactsExplorerContent() {
  const entities = getKBEntities();
  const properties = getKBProperties();

  const entitiesById = new Map(entities.map((e) => [e.id, e]));
  const propertiesById = new Map(properties.map((p) => [p.id, p]));

  const rows: FactRow[] = [];

  for (const entity of entities) {
    const facts = getKBFacts(entity.id);

    for (const fact of facts) {
      if (fact.propertyId === "description") continue;

      const property = propertiesById.get(fact.propertyId);

      const displayValue = formatKBFactValue(
        fact,
        property?.unit,
        property?.display,
      );

      const refNames = resolveRefDisplayNames(fact, entitiesById);

      rows.push({
        factId: fact.id,
        entityId: entity.id,
        entityName: entity.name,
        entityType: entity.type,
        propertyId: fact.propertyId,
        propertyName: property?.name ?? fact.propertyId,
        category: property?.category ?? "other",
        displayValue: refNames ? refNames.join(", ") : displayValue,
        rawRefValues: refNames,
        asOf: formatKBDate(fact.asOf),
        source: fact.source ?? "",
        hasSource: !!fact.source,
      });
    }
  }

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed mb-4">
        All {rows.length} structured facts across {entities.length} entities,
        excluding description-only entries. Use filters to narrow by entity type,
        property category, or search text.
      </p>
      <KBFactsTable data={rows} />
    </>
  );
}
