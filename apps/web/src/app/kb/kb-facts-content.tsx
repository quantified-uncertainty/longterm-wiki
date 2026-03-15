import {
  getKBEntities,
  getKBProperties,
  getKBFacts,
} from "@/data/factbase";
import type { Fact, Property, Entity } from "@longterm-wiki/factbase";
import { formatKBFactValue, formatKBDate } from "@/components/wiki/factbase/format";
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
  valueType: string;
  notes: string;
  sourceQuote: string;
  validEnd: string;
  isCurrent: boolean;
  derivedFrom: string;
  currency: string;
  usdEquivalent: number | null;
  unit: string;
  temporal: boolean;
  /** Months since asOf date (for sorting). -1 = unknown, negative = future. */
  freshnessMonths: number;
  /** Human-readable freshness label */
  freshnessLabel: string;
  /** Filled optional metadata fields out of 4 (source, asOf, notes, sourceQuote) */
  completenessScore: number;
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

/** Returns { months, label } — months is raw count for sorting, label is display string.
 *  Computed at build time so freshness reflects the build date, not viewer's clock. */
function computeFreshness(asOf: string | undefined): {
  months: number;
  label: string;
} {
  if (!asOf) return { months: -1, label: "Unknown" };
  const now = new Date();
  const parts = asOf.split("-").map(Number);
  const date = new Date(parts[0], (parts[1] ?? 1) - 1, parts[2] ?? 1);
  const months = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24 * 30.44),
  );
  if (months < 0) return { months, label: "Future" };
  if (months < 1) return { months: 0, label: "< 1 month" };
  if (months < 12) return { months, label: `${months}mo` };
  const years = Math.floor(months / 12);
  const rem = months % 12;
  const label = rem > 0 ? `${years}y ${rem}mo` : `${years}y`;
  return { months, label };
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

      const completeness = [
        fact.source,
        fact.asOf,
        fact.notes,
        fact.sourceQuote,
      ].filter(Boolean).length;

      const freshness = computeFreshness(fact.asOf);

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
        valueType: fact.value.type,
        notes: fact.notes ?? "",
        sourceQuote: fact.sourceQuote ?? "",
        validEnd: formatKBDate(fact.validEnd),
        isCurrent: !fact.validEnd,
        derivedFrom: fact.derivedFrom ?? "",
        currency: fact.currency ?? "",
        usdEquivalent: fact.usdEquivalent ?? null,
        unit: property?.unit ?? "",
        temporal: property?.temporal ?? false,
        freshnessMonths: freshness.months,
        freshnessLabel: freshness.label,
        completenessScore: completeness,
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
