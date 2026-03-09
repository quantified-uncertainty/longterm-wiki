import { getKBProperties, getKBAllFactsByProperty, getKBEntities } from "@/data/kb";
import { PropertyExplorerTable } from "./property-explorer-table";
import type { PropertyRow } from "./property-explorer-table";

export function PropertyExplorerContent() {
  const properties = getKBProperties();
  const entities = getKBEntities();

  // Build entity type index: entityId → type
  const entityTypeMap = new Map(entities.map((e) => [e.id, e.type]));

  // Build rows for each property
  const rows: PropertyRow[] = properties.map((prop) => {
    // Get all facts for this property across all entities (including expired for completeness)
    const allFacts = getKBAllFactsByProperty(prop.id, undefined, {
      includeExpired: true,
    });

    let totalFactCount = 0;
    const entityIds: string[] = [];
    const entityData: PropertyRow["entityData"] = [];

    for (const [entityId, facts] of allFacts) {
      entityIds.push(entityId);
      totalFactCount += facts.length;
      const latest = facts[0]; // Already sorted most-recent-first
      entityData.push({
        entityId,
        entityName:
          entities.find((e) => e.id === entityId)?.name ?? entityId,
        latestValue: formatValue(latest.value),
        asOf: latest.asOf ?? null,
        source: latest.source ?? null,
        allValuesCount: facts.length,
      });
    }

    // Sort entity data by recency (most recent first)
    entityData.sort((a, b) => {
      if (!a.asOf && !b.asOf) return 0;
      if (!a.asOf) return 1;
      if (!b.asOf) return -1;
      return b.asOf.localeCompare(a.asOf);
    });

    // Compute coverage: what % of applicable entities have at least one fact
    const applicableCount = prop.appliesTo
      ? entities.filter((e) => prop.appliesTo!.includes(e.type)).length
      : entities.length;
    const coverage =
      applicableCount > 0 ? entityIds.length / applicableCount : 0;

    return {
      id: prop.id,
      name: prop.name,
      description: prop.description ?? "",
      category: prop.category ?? "uncategorized",
      dataType: prop.dataType,
      unit: prop.unit ?? null,
      temporal: prop.temporal ?? false,
      computed: prop.computed ?? false,
      factCount: totalFactCount,
      entityCount: entityIds.length,
      applicableCount,
      coverage,
      appliesTo: prop.appliesTo ?? [],
      entityData,
    };
  });

  // Summary stats
  const totalProperties = properties.length;
  const propertiesWithData = rows.filter((r) => r.factCount > 0).length;
  const propertiesWithoutData = totalProperties - propertiesWithData;

  // By category
  const byCategory = new Map<string, number>();
  for (const r of rows) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
  }

  // By dataType
  const byDataType = new Map<string, number>();
  for (const r of rows) {
    byDataType.set(r.dataType, (byDataType.get(r.dataType) ?? 0) + 1);
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
            Properties
          </p>
          <p className="text-2xl font-bold tabular-nums">{totalProperties}</p>
          <p className="text-xs text-muted-foreground mt-1">
            <span className="text-emerald-600 font-medium">
              {propertiesWithData}
            </span>{" "}
            with data,{" "}
            <span className="text-amber-600 font-medium">
              {propertiesWithoutData}
            </span>{" "}
            empty
          </p>
        </div>

        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
            By Category
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
            {[...byCategory.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([cat, count]) => (
                <span key={cat} className="text-xs">
                  <span className="text-muted-foreground">{cat}:</span>{" "}
                  <span className="font-medium tabular-nums">{count}</span>
                </span>
              ))}
          </div>
        </div>

        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
            By Data Type
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
            {[...byDataType.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([dt, count]) => (
                <span key={dt} className="text-xs">
                  <span className="text-muted-foreground">{dt}:</span>{" "}
                  <span className="font-medium tabular-nums">{count}</span>
                </span>
              ))}
          </div>
        </div>
      </div>

      <PropertyExplorerTable data={rows} />
    </>
  );
}

/** Format a FactValue for display as a simple string. */
function formatValue(value: {
  type: string;
  value?: unknown;
  low?: number;
  high?: number;
}): string {
  switch (value.type) {
    case "number":
      return typeof value.value === "number"
        ? value.value.toLocaleString()
        : String(value.value);
    case "text":
    case "date":
      return String(value.value ?? "");
    case "boolean":
      return value.value ? "Yes" : "No";
    case "ref":
      return String(value.value ?? "");
    case "refs":
      return Array.isArray(value.value)
        ? (value.value as string[]).join(", ")
        : String(value.value ?? "");
    case "range":
      return `${value.low?.toLocaleString()} - ${value.high?.toLocaleString()}`;
    case "min":
      return `>= ${typeof value.value === "number" ? value.value.toLocaleString() : String(value.value)}`;
    case "json":
      return JSON.stringify(value.value);
    default:
      return String(value.value ?? "");
  }
}
