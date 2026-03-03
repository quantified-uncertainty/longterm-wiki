import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { numericIdToSlug, slugToNumericId } from "@/lib/mdx";
import { getPageById } from "@/data";
import { fetchDetailed, withApiFallback } from "@lib/wiki-server";
import {
  formatStatementValue,
  getVarietyBadge,
  getStatusBadge,
} from "@lib/statement-display";

interface PageProps {
  params: Promise<{ id: string }>;
}

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

// ISR — these pages fetch live data from wiki-server
export const dynamicParams = true;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const slug = isNumericId(id) ? numericIdToSlug(id.toUpperCase()) : id;
  const page = slug ? getPageById(slug) : null;
  const title = page?.title ?? slug ?? id;
  return {
    title: `${title} Statements | Longterm Wiki`,
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
  property: PropertyInfo | null;
  citations: Citation[];
}

interface ByEntityResult {
  structured: StatementWithDetails[];
  attributed: StatementWithDetails[];
  total: number;
}

export default async function EntityStatementsPage({ params }: PageProps) {
  const { id } = await params;

  let slug: string | null;
  let numericId: string | null;

  if (isNumericId(id)) {
    numericId = id.toUpperCase();
    slug = numericIdToSlug(numericId);
  } else {
    slug = id;
    numericId = slugToNumericId(id);
  }

  if (!slug) notFound();

  const pageData = getPageById(slug);
  const title = pageData?.title ?? slug;

  const { data } = await withApiFallback<ByEntityResult>(
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

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">{title} - Statements</h1>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link
            href={`/wiki/${numericId || slug}`}
            className="text-blue-600 hover:underline"
          >
            &larr; Back to page
          </Link>
          <Link
            href={`/wiki/${numericId || slug}/data`}
            className="text-muted-foreground hover:underline"
          >
            Data page
          </Link>
          <Link
            href={`/wiki/${numericId || slug}/claims`}
            className="text-muted-foreground hover:underline"
          >
            Claims
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total" value={total} />
        <StatCard label="Active Structured" value={activeStructured.length} color="blue" />
        <StatCard label="Active Attributed" value={activeAttributed.length} color="amber" />
        <StatCard
          label="With Citations"
          value={structured.filter((s) => s.citations.length > 0).length + attributed.filter((s) => s.citations.length > 0).length}
          color="emerald"
        />
      </div>

      {total === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No statements yet</p>
          <p className="text-sm">
            Statements are created by migrating YAML facts or via the statements API.
          </p>
        </div>
      ) : (
        <>
          {/* Structured statements by category */}
          {byCategory.size > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold mb-4">Structured Statements</h2>
              {[...byCategory.entries()]
                .sort((a, b) => b[1].length - a[1].length)
                .map(([category, stmts]) => (
                  <PropertyGroup key={category} category={category} statements={stmts} />
                ))}
            </div>
          )}

          {/* Attributed statements */}
          {attributed.length > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold mb-4">Attributed Statements</h2>
              <div className="space-y-2">
                {attributed.map((s) => (
                  <AttributedRow key={s.id} statement={s} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- Sub-components ----

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: "blue" | "amber" | "emerald";
}) {
  const colorClass =
    color === "blue"
      ? "text-blue-600"
      : color === "amber"
        ? "text-amber-600"
        : color === "emerald"
          ? "text-emerald-600"
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

function PropertyGroup({
  category,
  statements,
}: {
  category: string;
  statements: StatementWithDetails[];
}) {
  const active = statements.filter((s) => s.status === "active");
  const superseded = statements.filter((s) => s.status !== "active");

  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold capitalize text-muted-foreground mb-2">
        {category}
        <span className="ml-2 text-xs font-normal">
          ({active.length} active{superseded.length > 0 ? `, ${superseded.length} superseded` : ""})
        </span>
      </h3>
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/30">
              <th className="text-left px-3 py-2 text-xs font-medium">Property</th>
              <th className="text-left px-3 py-2 text-xs font-medium">Value</th>
              <th className="text-left px-3 py-2 text-xs font-medium">Period</th>
              <th className="text-right px-3 py-2 text-xs font-medium">Citations</th>
              <th className="text-left px-3 py-2 text-xs font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {active.map((s) => (
              <StructuredRow key={s.id} statement={s} />
            ))}
            {superseded.map((s) => (
              <StructuredRow key={s.id} statement={s} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StructuredRow({ statement: s }: { statement: StatementWithDetails }) {
  const value = formatStatementValue(s, s.property);
  const statusBadge = getStatusBadge(s.status);

  return (
    <tr className="border-b border-border/30 last:border-0">
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
        {s.validStart ?? "—"}
        {s.validEnd ? ` → ${s.validEnd}` : ""}
      </td>
      <td className="px-3 py-2 text-xs text-right tabular-nums">
        {s.citations.length > 0 ? (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 text-[11px] font-medium">
            {s.citations.length}
          </span>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${statusBadge.className}`}
        >
          {statusBadge.label}
        </span>
      </td>
    </tr>
  );
}

function AttributedRow({ statement: s }: { statement: StatementWithDetails }) {
  const varietyBadge = getVarietyBadge(s.variety);
  const statusBadge = getStatusBadge(s.status);

  return (
    <div className="rounded-lg border border-border/60 p-3">
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
                  {s.attributedTo}
                </Link>
              </span>
            )}
            {s.validStart && <span>{s.validStart}</span>}
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
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
          {s.citations.length > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 text-[11px] font-medium">
              {s.citations.length} cite{s.citations.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
