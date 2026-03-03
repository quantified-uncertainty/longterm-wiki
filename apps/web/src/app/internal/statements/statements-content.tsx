import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { StatementsTable } from "./statements-table";

// ── Types ─────────────────────────────────────────────────────────────────

interface Citation {
  id: number;
  resourceId: string | null;
  url: string | null;
  sourceQuote: string | null;
  locationNote: string | null;
  isPrimary: boolean;
}

export interface StatementRow {
  id: number;
  variety: string;
  statementText: string | null;
  status: string;
  subjectEntityId: string;
  propertyId: string | null;
  qualifierKey: string | null;
  valueNumeric: number | null;
  valueUnit: string | null;
  valueText: string | null;
  valueEntityId: string | null;
  valueDate: string | null;
  valueSeries: Record<string, unknown> | null;
  validStart: string | null;
  validEnd: string | null;
  attributedTo: string | null;
  sourceFactKey: string | null;
  note: string | null;
  createdAt: string;
  citations: Citation[];
}

export interface PropertyRow {
  id: string;
  label: string;
  category: string;
  description: string | null;
  valueType: string;
  unitFormatId: string | null;
  statementCount: number;
}

interface StatsResponse {
  total: number;
  byVariety: Record<string, number>;
  byStatus: Record<string, number>;
  propertiesCount: number;
}

// ── Data Loading ──────────────────────────────────────────────────────────

interface DashboardData {
  statements: StatementRow[];
  properties: PropertyRow[];
  stats: StatsResponse;
}

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  // Fetch stats, all statements (paginated), and properties in parallel
  const [statsResult, statementsResult, propertiesResult] = await Promise.all([
    fetchDetailed<StatsResponse>("/api/statements/stats", {
      revalidate: 300,
    }),
    fetchDetailed<{
      statements: StatementRow[];
      total: number;
    }>("/api/statements?limit=200", { revalidate: 300 }),
    fetchDetailed<{
      properties: PropertyRow[];
    }>("/api/statements/properties", { revalidate: 300 }),
  ]);

  if (!statsResult.ok) return statsResult;
  if (!statementsResult.ok) return statementsResult;
  if (!propertiesResult.ok) return propertiesResult;

  // Statements from the list endpoint don't have citations — fetch them via by-entity for each unique entity
  // For the dashboard, we skip per-row citations and just show counts
  // To get citation counts, we'll need a second pass. For now, map with empty citations.
  const stmts: StatementRow[] = statementsResult.data.statements.map((s) => ({
    ...s,
    citations: (s as StatementRow).citations ?? [],
  }));

  return {
    ok: true,
    data: {
      statements: stmts,
      properties: propertiesResult.data.properties,
      stats: statsResult.data,
    },
  };
}

function noLocalFallback(): DashboardData {
  return { statements: [], properties: [], stats: { total: 0, byVariety: {}, byStatus: {}, propertiesCount: 0 } };
}

// ── Content Component ────────────────────────────────────────────────────

export async function StatementsContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const { statements, properties, stats } = data;

  const structured = stats.byVariety["structured"] ?? 0;
  const attributed = stats.byVariety["attributed"] ?? 0;
  const active = stats.byStatus["active"] ?? 0;
  const uniqueEntities = new Set(statements.map((s) => s.subjectEntityId)).size;

  // Property category breakdown
  const byCategory = new Map<string, number>();
  for (const p of properties) {
    byCategory.set(
      p.category,
      (byCategory.get(p.category) ?? 0) + p.statementCount
    );
  }

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Overview of the Statements system. Statements are structured facts and
        attributed claims about entities, backed by citations to source
        resources.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4">
        <StatCard label="Total" value={stats.total} />
        <StatCard label="Active" value={active} color="emerald" />
        <StatCard label="Structured" value={structured} color="blue" />
        <StatCard label="Attributed" value={attributed} color="amber" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatCard label="Properties" value={stats.propertiesCount} />
        <StatCard label="Entities" value={uniqueEntities} />
        {[...byCategory.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([cat, cnt]) => (
            <StatCard key={cat} label={cat} value={cnt} />
          ))}
      </div>

      {statements.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No statements yet</p>
          <p className="text-sm">
            Statements are created via the YAML fact migration or the POST
            /api/statements endpoint.
          </p>
        </div>
      ) : (
        <StatementsTable data={statements} properties={properties} />
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
