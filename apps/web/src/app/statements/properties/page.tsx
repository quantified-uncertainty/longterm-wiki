import type { Metadata } from "next";
import Link from "next/link";
import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { StatCard } from "@components/internal/StatCard";
import { getEntityById } from "@data";
import { PropertiesTable } from "@/app/statements/properties/properties-table";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Property Explorer | Longterm Wiki",
  description:
    "Browse all properties defined in the Statements system — the controlled vocabulary of structured data.",
};

// ---- Types ----

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
  subjectEntityId: string;
  propertyId: string | null;
  status: string;
}

interface DashboardData {
  properties: PropertyRow[];
  statements: StatementRow[];
}

/**
 * Paginate through all statements (API max page size 500).
 */
async function fetchAllStatementsForProperties(): Promise<
  FetchResult<{ statements: StatementRow[]; total: number }>
> {
  const PAGE_SIZE = 500;
  const first = await fetchDetailed<{ statements: StatementRow[]; total: number }>(
    `/api/statements?limit=${PAGE_SIZE}&offset=0`,
    { revalidate: 300 }
  );
  if (!first.ok) return first;

  const all: StatementRow[] = [...first.data.statements];
  const total = first.data.total;

  // Fetch remaining pages in parallel
  const remaining: Promise<FetchResult<{ statements: StatementRow[]; total: number }>>[] = [];
  for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) {
    remaining.push(
      fetchDetailed<{ statements: StatementRow[]; total: number }>(
        `/api/statements?limit=${PAGE_SIZE}&offset=${offset}`,
        { revalidate: 300 }
      )
    );
  }

  const pages = await Promise.all(remaining);
  for (const page of pages) {
    if (page.ok) all.push(...page.data.statements);
  }

  return { ok: true, data: { statements: all, total } };
}

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [propertiesResult, statementsResult] = await Promise.all([
    fetchDetailed<{ properties: PropertyRow[] }>(
      "/api/statements/properties",
      { revalidate: 300 }
    ),
    fetchAllStatementsForProperties(),
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

// ---- Category colors ----

const CATEGORY_COLORS: Record<string, string> = {
  financial: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  organizational: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  safety: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  performance: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  milestone: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  relation: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

export default async function PropertiesPage() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const { properties: allProperties, statements } = data;

  // Filter out properties with no statements
  const properties = allProperties.filter((p) => p.statementCount > 0);

  // Summary stats
  const totalProperties = properties.length;
  const totalStatements = properties.reduce(
    (sum, p) => sum + p.statementCount,
    0
  );

  // Category breakdown
  const byCategory = new Map<string, PropertyRow[]>();
  for (const p of properties) {
    const list = byCategory.get(p.category) || [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  // Entity-to-property map
  const entityPropertyMap = new Map<string, Set<string>>();
  for (const s of statements) {
    if (s.propertyId && s.status === "active") {
      if (!entityPropertyMap.has(s.subjectEntityId)) {
        entityPropertyMap.set(s.subjectEntityId, new Set());
      }
      entityPropertyMap.get(s.subjectEntityId)!.add(s.propertyId);
    }
  }

  const topEntities = [...entityPropertyMap.entries()]
    .map(([entityId, props]) => ({
      entityId,
      title: getEntityById(entityId)?.title ?? entityId,
      propertyCount: props.size,
    }))
    .sort((a, b) => b.propertyCount - a.propertyCount)
    .slice(0, 10);

  const sortedCategories = [...byCategory.entries()].sort(
    (a, b) => b[1].length - a[1].length
  );

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Property Explorer</h1>
      <p className="text-muted-foreground mb-6 text-sm leading-relaxed">
        Browse all properties defined in the Statements system. Properties
        define what structured data can be recorded about entities (e.g.,
        valuation, employee count, founding date).
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <StatCard label="Properties" value={totalProperties} />
        <StatCard label="Statements" value={totalStatements} color="blue" />
        <StatCard
          label="Categories"
          value={byCategory.size}
          color="amber"
        />
        <StatCard
          label="Entities"
          value={entityPropertyMap.size}
          color="emerald"
        />
      </div>

      {/* Category breakdown */}
      <div className="rounded-lg border p-4 mb-6">
        <h3 className="text-sm font-semibold mb-3">Properties by Category</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {sortedCategories.map(([category, props]) => {
            const stmtCount = props.reduce(
              (s, p) => s + p.statementCount,
              0
            );
            return (
              <Link
                key={category}
                href={`/statements/browse?category=${category}`}
                className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 hover:bg-muted/50 transition-colors no-underline"
              >
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium capitalize ${CATEGORY_COLORS[category] ?? "bg-gray-100 text-gray-800"}`}
                >
                  {category}
                </span>
                <div className="text-right text-xs text-muted-foreground">
                  <span className="font-medium text-foreground tabular-nums">
                    {props.length}
                  </span>{" "}
                  props,{" "}
                  <span className="tabular-nums">{stmtCount}</span> stmts
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Top entities */}
      {topEntities.length > 0 && (
        <div className="rounded-lg border p-4 mb-6">
          <h3 className="text-sm font-semibold mb-3">
            Top Entities by Property Coverage
          </h3>
          <div className="space-y-1.5">
            {topEntities.map((entity) => (
              <div
                key={entity.entityId}
                className="flex items-center gap-3"
              >
                <Link
                  href={`/statements/entity/${entity.entityId}`}
                  className="text-sm text-blue-600 hover:underline w-40 truncate"
                >
                  {entity.title}
                </Link>
                <div className="flex-1 flex items-center gap-2">
                  <div className="flex-1 h-3 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
                    <div
                      className="h-full bg-blue-400 dark:bg-blue-600 rounded-l"
                      style={{
                        width: `${topEntities[0].propertyCount > 0 ? (entity.propertyCount / topEntities[0].propertyCount) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs tabular-nums w-6 text-right text-muted-foreground">
                    {entity.propertyCount}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Properties table */}
      {properties.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No properties yet</p>
          <p className="text-sm">
            Properties are seeded from fact-measures.yaml.
          </p>
        </div>
      ) : (
        <>
          <h3 className="text-sm font-semibold mb-3">All Properties</h3>
          <PropertiesTable data={properties} />
        </>
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </div>
  );
}
