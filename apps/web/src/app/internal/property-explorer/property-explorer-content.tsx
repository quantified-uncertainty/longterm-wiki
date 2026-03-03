import Link from "next/link";
import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { PropertyExplorerTable } from "./property-explorer-table";

// ── Types ─────────────────────────────────────────────────────────────────

export interface PropertyRow {
  id: string;
  label: string;
  category: string;
  description: string | null;
  entityTypes: string[];
  valueType: string;
  defaultUnit: string | null;
  stalenessCadence: string | null;
  unitFormatId: string | null;
  statementCount: number;
}

interface StatementRow {
  id: number;
  variety: string;
  subjectEntityId: string;
  propertyId: string | null;
  valueNumeric: number | null;
  valueText: string | null;
  valueDate: string | null;
  valueEntityId: string | null;
  status: string;
}

// ── Data Loading ──────────────────────────────────────────────────────────

interface DashboardData {
  properties: PropertyRow[];
  statements: StatementRow[];
}

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [propertiesResult, statementsResult] = await Promise.all([
    fetchDetailed<{
      properties: PropertyRow[];
    }>("/api/statements/properties", { revalidate: 300 }),
    fetchDetailed<{
      statements: StatementRow[];
      total: number;
    }>("/api/statements?limit=200", { revalidate: 300 }),
  ]);

  if (!propertiesResult.ok) return propertiesResult;
  if (!statementsResult.ok) return statementsResult;

  return {
    ok: true,
    data: {
      properties: propertiesResult.data.properties,
      statements: statementsResult.data.statements,
    },
  };
}

function noLocalFallback(): DashboardData {
  return { properties: [], statements: [] };
}

// ── Content Component ────────────────────────────────────────────────────

export async function PropertyExplorerContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const { properties, statements } = data;

  // Summary stats
  const totalProperties = properties.length;
  const totalStatements = properties.reduce((sum, p) => sum + p.statementCount, 0);

  // Properties by category
  const byCategory = new Map<string, PropertyRow[]>();
  for (const p of properties) {
    const list = byCategory.get(p.category) || [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  // Build entity-to-property map from statements for the "top entities" view
  const entityPropertyMap = new Map<string, Set<string>>();
  for (const s of statements) {
    if (s.propertyId && s.status === "active") {
      const key = s.subjectEntityId;
      if (!entityPropertyMap.has(key)) {
        entityPropertyMap.set(key, new Set());
      }
      entityPropertyMap.get(key)!.add(s.propertyId);
    }
  }
  const uniqueEntities = entityPropertyMap.size;

  // Top entities by number of properties
  const entitiesByPropertyCount = [...entityPropertyMap.entries()]
    .map(([entityId, props]) => ({ entityId, propertyCount: props.size }))
    .sort((a, b) => b.propertyCount - a.propertyCount)
    .slice(0, 10);

  // Sorted categories for display
  const sortedCategories = [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length);

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Browse all properties defined in the Statements system. Properties
        define what structured data can be recorded about entities (e.g.,
        valuation, employee count, founding date).
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4">
        <StatCard label="Properties" value={totalProperties} />
        <StatCard label="Statements" value={totalStatements} color="blue" />
        <StatCard label="Categories" value={byCategory.size} color="amber" />
        <StatCard label="Entities" value={uniqueEntities} color="emerald" />
      </div>

      {/* Category breakdown */}
      <h3 className="text-sm font-semibold mt-6 mb-3">Properties by Category</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-6">
        {sortedCategories.map(([category, props]) => {
          const stmtCount = props.reduce((s, p) => s + p.statementCount, 0);
          return (
            <div
              key={category}
              className="rounded-lg border border-border/60 px-3 py-2"
            >
              <p className="text-xs font-medium capitalize">{category}</p>
              <p className="text-sm font-semibold tabular-nums">
                {props.length} properties
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {stmtCount.toLocaleString("en-US")} statements
              </p>
            </div>
          );
        })}
      </div>

      {/* Top entities by property coverage */}
      {entitiesByPropertyCount.length > 0 && (
        <>
          <h3 className="text-sm font-semibold mt-6 mb-3">
            Top Entities by Property Coverage
          </h3>
          <div className="rounded-lg border border-border/60 overflow-hidden mb-6">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30">
                  <th className="text-left px-3 py-2 font-medium">Entity</th>
                  <th className="text-right px-3 py-2 font-medium">Properties</th>
                </tr>
              </thead>
              <tbody>
                {entitiesByPropertyCount.map((row) => (
                  <tr
                    key={row.entityId}
                    className="border-b border-border/30 last:border-0"
                  >
                    <td className="px-3 py-1.5 font-medium">
                      <Link
                        href={`/wiki/${row.entityId}`}
                        className="text-blue-600 hover:underline"
                      >
                        {row.entityId}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold">
                      {row.propertyCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Property table */}
      {properties.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No properties yet</p>
          <p className="text-sm">
            Properties are defined in the seed data or created via the statements API.
          </p>
        </div>
      ) : (
        <>
          <h3 className="text-sm font-semibold mt-6 mb-3">All Properties</h3>
          <PropertyExplorerTable data={properties} />
        </>
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: "emerald" | "blue" | "amber";
}) {
  const colorClass =
    color === "emerald"
      ? "text-emerald-600"
      : color === "blue"
        ? "text-blue-600"
        : color === "amber"
          ? "text-amber-600"
          : "text-foreground";

  return (
    <div className="rounded-lg border border-border/60 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${colorClass}`}>
        {value.toLocaleString("en-US")}
      </p>
    </div>
  );
}
