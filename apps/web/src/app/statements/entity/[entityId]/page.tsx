import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { numericIdToSlug, slugToNumericId } from "@/lib/mdx";
import { getPageById, getEntityById } from "@/data";
import { fetchDetailed, withApiFallback } from "@lib/wiki-server";
import {
  formatStatementValue,
  getVarietyBadge,
  getStatusBadge,
} from "@lib/statement-display";
import { StatCard } from "@components/internal/StatCard";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";

interface PageProps {
  params: Promise<{ entityId: string }>;
}

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

export const dynamicParams = true;

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { entityId } = await params;
  const slug = isNumericId(entityId)
    ? numericIdToSlug(entityId.toUpperCase())
    : entityId;
  const page = slug ? getPageById(slug) : null;
  const title = page?.title ?? slug ?? entityId;
  return {
    title: `${title} — Statements | Longterm Wiki`,
    description: `Structured and attributed statements about ${title}.`,
  };
}

// ---- Types for the API response ----

interface Citation {
  id: number;
  resourceId: string | null;
  url: string | null;
  sourceQuote: string | null;
  locationNote: string | null;
  isPrimary: boolean;
}

interface PropertyInfo {
  id: string;
  label: string;
  category: string;
  valueType: string;
  unitFormatId: string | null;
}

interface StatementWithDetails {
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
  verdict: string | null;
  verdictScore: number | null;
  verdictQuotes: string | null;
  property: PropertyInfo | null;
  citations: Citation[];
}

interface ByEntityResult {
  structured: StatementWithDetails[];
  attributed: StatementWithDetails[];
  total: number;
}

export default async function EntityStatementsPage({ params }: PageProps) {
  const { entityId } = await params;

  let slug: string | null;
  let numericId: string | null;

  if (isNumericId(entityId)) {
    numericId = entityId.toUpperCase();
    slug = numericIdToSlug(numericId);
  } else {
    slug = entityId;
    numericId = slugToNumericId(entityId);
  }

  if (!slug) notFound();

  const pageData = getPageById(slug);
  const entity = getEntityById(slug);
  const title = pageData?.title ?? entity?.title ?? slug;

  const { data, source, apiError } = await withApiFallback<ByEntityResult>(
    () =>
      fetchDetailed<ByEntityResult>(
        `/api/statements/by-entity?entityId=${encodeURIComponent(slug!)}`,
        { revalidate: 300 }
      ),
    () => ({ structured: [], attributed: [], total: 0 })
  );

  const { structured, attributed, total } = data;

  // Group structured statements by property category
  const byCategory = new Map<string, StatementWithDetails[]>();
  for (const s of structured) {
    const cat = s.property?.category ?? "uncategorized";
    const list = byCategory.get(cat) ?? [];
    list.push(s);
    byCategory.set(cat, list);
  }

  const activeStructured = structured.filter((s) => s.status === "active");
  const activeAttributed = attributed.filter((s) => s.status === "active");
  const withCitations =
    structured.filter((s) => s.citations.length > 0).length +
    attributed.filter((s) => s.citations.length > 0).length;

  // Summary strip: key current values
  const summaryValues = activeStructured
    .filter((s) => s.validEnd == null && s.property)
    .slice(0, 5)
    .map((s) => ({
      id: s.id,
      label: s.property!.label,
      value: formatStatementValue(s, s.property),
    }));

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">{title} — Statements</h1>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link
            href={`/wiki/${numericId || slug}`}
            className="text-blue-600 hover:underline"
          >
            &larr; Wiki page
          </Link>
          <Link
            href={`/claims/entity/${slug}`}
            className="text-muted-foreground hover:underline"
          >
            Claims view
          </Link>
          <Link
            href={`/statements/browse?entity=${slug}`}
            className="text-muted-foreground hover:underline"
          >
            Browse filtered
          </Link>
        </div>
      </div>

      {/* Summary strip */}
      {summaryValues.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-6">
          {summaryValues.map((sv) => (
            <div
              key={sv.id}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-muted/50 text-sm"
            >
              <span className="text-muted-foreground">{sv.label}:</span>
              <span className="font-semibold tabular-nums">{sv.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total" value={total} />
        <StatCard
          label="Active Structured"
          value={activeStructured.length}
          color="blue"
        />
        <StatCard
          label="Active Attributed"
          value={activeAttributed.length}
          color="amber"
        />
        <StatCard
          label="With Citations"
          value={withCitations}
          color="emerald"
        />
      </div>

      {total === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No statements yet</p>
          <p className="text-sm">
            Statements are created by migrating YAML facts or via the statements
            API.
          </p>
        </div>
      ) : (
        <>
          {/* Structured statements by category */}
          {byCategory.size > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold mb-1">
                Structured Statements
              </h2>
              <p className="text-xs text-muted-foreground mb-4">
                Structured statements record specific data points with typed
                values, dates, and units. See the{" "}
                <Link
                  href="/statements/properties"
                  className="text-blue-600 hover:underline"
                >
                  Property Explorer
                </Link>{" "}
                for all available properties.
              </p>
              {[...byCategory.entries()]
                .sort((a, b) => b[1].length - a[1].length)
                .map(([category, stmts]) => (
                  <PropertyGroup
                    key={category}
                    category={category}
                    statements={stmts}
                  />
                ))}
            </div>
          )}

          {/* Attributed statements */}
          {attributed.length > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold mb-1">
                Attributed Statements
              </h2>
              <p className="text-xs text-muted-foreground mb-4">
                Attributed statements capture notable claims attributed to
                specific people or organizations.
              </p>
              <div className="space-y-2">
                {attributed.map((s) => (
                  <AttributedRow key={s.id} statement={s} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </div>
  );
}

// ---- Helpers ----

function formatPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return "—";
  if (start && !end) return `since ${start}`;
  if (!start && end) return `until ${end}`;
  return `${start} → ${end}`;
}

// ---- Sub-components ----

const CATEGORY_COLORS: Record<string, string> = {
  financial: "text-green-700 dark:text-green-400",
  organizational: "text-blue-700 dark:text-blue-400",
  safety: "text-red-700 dark:text-red-400",
  performance: "text-purple-700 dark:text-purple-400",
  milestone: "text-amber-700 dark:text-amber-400",
  relation: "text-teal-700 dark:text-teal-400",
};

function PropertyGroup({
  category,
  statements,
}: {
  category: string;
  statements: StatementWithDetails[];
}) {
  const active = statements.filter((s) => s.status === "active");
  const inactive = statements.filter((s) => s.status !== "active");

  return (
    <div className="mb-4">
      <h3
        className={`text-sm font-semibold capitalize mb-2 ${CATEGORY_COLORS[category] ?? "text-muted-foreground"}`}
      >
        {category}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          ({active.length} active
          {inactive.length > 0 ? `, ${inactive.length} inactive` : ""})
        </span>
      </h3>
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/30">
              <th className="text-left px-3 py-2 text-xs font-medium">
                Property
              </th>
              <th className="text-left px-3 py-2 text-xs font-medium">
                Value
              </th>
              <th className="text-left px-3 py-2 text-xs font-medium">
                Period
              </th>
              <th className="text-right px-3 py-2 text-xs font-medium">
                Citations
              </th>
              <th className="text-left px-3 py-2 text-xs font-medium">
                Status
              </th>
              <th className="text-left px-3 py-2 text-xs font-medium w-6"></th>
            </tr>
          </thead>
          <tbody>
            {active.map((s) => (
              <StructuredRow key={s.id} statement={s} />
            ))}
            {inactive.map((s) => (
              <StructuredRow key={s.id} statement={s} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StructuredRow({
  statement: s,
}: {
  statement: StatementWithDetails;
}) {
  const value = formatStatementValue(s, s.property);
  const statusBadge = getStatusBadge(s.status);
  const isSuperseded = s.status !== "active";

  return (
    <tr
      className={`border-b border-border/30 last:border-0 ${isSuperseded ? "opacity-60" : ""}`}
    >
      <td className="px-3 py-2 text-xs font-medium">
        {s.property?.label ?? s.propertyId ?? "—"}
      </td>
      <td className="px-3 py-2 text-xs font-semibold tabular-nums">
        {s.valueEntityId ? (
          <Link
            href={`/wiki/${s.valueEntityId}`}
            className="text-blue-600 hover:underline"
          >
            {value}
          </Link>
        ) : (
          value
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {formatPeriod(s.validStart, s.validEnd)}
      </td>
      <td className="px-3 py-2 text-xs text-right">
        {s.citations.length > 0 ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
            {s.citations.length}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${statusBadge.className}`}
        >
          {statusBadge.label}
        </span>
      </td>
      <td className="px-3 py-2">
        <Link
          href={`/statements/statement/${s.id}`}
          className="text-blue-600 hover:underline text-xs"
          title="View details"
        >
          →
        </Link>
      </td>
    </tr>
  );
}

function AttributedRow({
  statement: s,
}: {
  statement: StatementWithDetails;
}) {
  const varietyBadge = getVarietyBadge(s.variety);
  const statusBadge = getStatusBadge(s.status);
  const isSuperseded = s.status !== "active";

  return (
    <div
      className={`rounded-lg border border-border/60 p-3 ${isSuperseded ? "opacity-60" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {s.statementText && (
            <p className="text-sm italic text-muted-foreground line-clamp-3">
              &ldquo;{s.statementText}&rdquo;
            </p>
          )}
          <div className="flex flex-wrap gap-2 mt-2 text-xs text-muted-foreground">
            {s.attributedTo && (
              <span>
                Attributed to{" "}
                <Link
                  href={`/wiki/${s.attributedTo}`}
                  className="text-blue-600 hover:underline"
                >
                  {getEntityById(s.attributedTo)?.title ?? s.attributedTo}
                </Link>
              </span>
            )}
            {s.validStart && <span>{s.validStart}</span>}
            {s.citations.length > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                {s.citations.length} citation
                {s.citations.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0 items-center">
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${varietyBadge.className}`}
          >
            {varietyBadge.label}
          </span>
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${statusBadge.className}`}
          >
            {statusBadge.label}
          </span>
          <Link
            href={`/statements/statement/${s.id}`}
            className="text-blue-600 hover:underline text-xs ml-1"
            title="View details"
          >
            →
          </Link>
        </div>
      </div>
    </div>
  );
}
