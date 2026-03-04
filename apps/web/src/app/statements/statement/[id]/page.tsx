import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { fetchDetailed, withApiFallback } from "@lib/wiki-server";
import {
  formatStatementValue,
  getVarietyBadge,
  getStatusBadge,
} from "@lib/statement-display";
import { getEntityById } from "@data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export const dynamicParams = true;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Statement #${id} | Longterm Wiki`,
    description: `Detailed view of statement #${id}.`,
  };
}

// ---- Types ----

interface Citation {
  id: number;
  resourceId: string | null;
  url: string | null;
  sourceQuote: string | null;
  locationNote: string | null;
  isPrimary: boolean;
}

interface StatementDetail {
  id: number;
  variety: string;
  statementText: string | null;
  status: string;
  archiveReason: string | null;
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
  temporalGranularity: string | null;
  attributedTo: string | null;
  verdict: string | null;
  verdictScore: number | null;
  verdictQuotes: string | null;
  verdictModel: string | null;
  verifiedAt: string | null;
  claimCategory: string | null;
  sourceFactKey: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string | null;
  citationCount: number;
}

interface PropertyInfo {
  id: string;
  label: string;
  category: string;
  description: string | null;
  valueType: string;
  unitFormatId: string | null;
}

// ---- Verdict badge ----

const VERDICT_CONFIG: Record<
  string,
  { className: string; label: string }
> = {
  verified: {
    label: "Verified",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  },
  disputed: {
    label: "Disputed",
    className:
      "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  },
  unsupported: {
    label: "Unsupported",
    className:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  },
  unverified: {
    label: "Unverified",
    className:
      "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400",
  },
};

export default async function StatementDetailPage({ params }: PageProps) {
  const { id } = await params;
  const numericId = parseInt(id, 10);
  if (isNaN(numericId)) notFound();

  // Fetch the statement directly by ID
  const { data: detail } = await withApiFallback(
    () =>
      fetchDetailed<{
        statement: StatementDetail;
        citations: Citation[];
        property: PropertyInfo | null;
      }>(`/api/statements/${numericId}`, { revalidate: 300 }),
    () => null
  );

  if (!detail) notFound();

  const statement = detail.statement;
  const citations = detail.citations;
  const propertyInfo = detail.property;

  // Fetch related statements (same entity + property) via the by-entity endpoint
  const { data: entityData } = await withApiFallback(
    () =>
      fetchDetailed<{
        structured: (StatementDetail & { citations: Citation[]; property: PropertyInfo | null })[];
        attributed: (StatementDetail & { citations: Citation[]; property: PropertyInfo | null })[];
        total: number;
      }>(
        `/api/statements/by-entity?entityId=${encodeURIComponent(statement.subjectEntityId)}`,
        { revalidate: 300 }
      ),
    () => ({ structured: [], attributed: [], total: 0 })
  );

  const allEntityStatements = [...entityData.structured, ...entityData.attributed];

  const entityName =
    getEntityById(statement.subjectEntityId)?.title ??
    statement.subjectEntityId;
  const varietyBadge = getVarietyBadge(statement.variety);
  const statusBadge = getStatusBadge(statement.status);
  const value = formatStatementValue(
    statement,
    propertyInfo
      ? { unitFormatId: propertyInfo.unitFormatId, valueType: propertyInfo.valueType }
      : null
  );

  // Related statements: same entity + property, different ID
  const relatedStatements = allEntityStatements
    .filter(
      (s) =>
        s.id !== numericId &&
        s.propertyId === statement.propertyId &&
        statement.propertyId != null
    )
    .slice(0, 10);

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href="/statements" className="hover:underline">
            Statements
          </Link>
          <span>/</span>
          <Link
            href={`/statements/entity/${statement.subjectEntityId}`}
            className="hover:underline"
          >
            {entityName}
          </Link>
          <span>/</span>
          <span>#{statement.id}</span>
        </div>
        <h1 className="text-2xl font-bold mb-3">
          {statement.variety === "structured"
            ? `${entityName}: ${propertyInfo?.label ?? statement.propertyId ?? "Unknown Property"}`
            : `Attributed Statement #${statement.id}`}
        </h1>
        <div className="flex flex-wrap gap-2">
          <span
            className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${varietyBadge.className}`}
          >
            {varietyBadge.label}
          </span>
          <span
            className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${statusBadge.className}`}
          >
            {statusBadge.label}
          </span>
          {statement.verdict && (
            <span
              className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${VERDICT_CONFIG[statement.verdict]?.className ?? "bg-gray-100 text-gray-800"}`}
            >
              {VERDICT_CONFIG[statement.verdict]?.label ?? statement.verdict}
            </span>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="space-y-6">
        {/* Value (structured) */}
        {statement.variety === "structured" && (
          <Section title="Value">
            <div className="text-2xl font-bold tabular-nums">
              {statement.valueEntityId ? (
                <Link
                  href={`/wiki/${statement.valueEntityId}`}
                  className="text-blue-600 hover:underline"
                >
                  {value}
                </Link>
              ) : (
                value
              )}
            </div>
            {statement.qualifierKey && (
              <div className="text-sm text-muted-foreground mt-1">
                Qualifier: {statement.qualifierKey}
              </div>
            )}
          </Section>
        )}

        {/* Statement text (attributed) */}
        {statement.statementText && (
          <Section title="Statement">
            <blockquote className="border-l-2 border-amber-300 pl-4 py-2 italic text-muted-foreground">
              &ldquo;{statement.statementText}&rdquo;
            </blockquote>
            {statement.attributedTo && (
              <div className="mt-2 text-sm">
                Attributed to{" "}
                <Link
                  href={`/wiki/${statement.attributedTo}`}
                  className="text-blue-600 hover:underline"
                >
                  {getEntityById(statement.attributedTo)?.title ??
                    statement.attributedTo}
                </Link>
              </div>
            )}
          </Section>
        )}

        {/* Subject entity */}
        <Section title="Subject Entity">
          <Link
            href={`/statements/entity/${statement.subjectEntityId}`}
            className="text-blue-600 hover:underline"
          >
            {entityName}
          </Link>
        </Section>

        {/* Property */}
        {propertyInfo && (
          <Section title="Property">
            <div className="space-y-1">
              <div>
                <span className="font-medium">{propertyInfo.label}</span>
                <span className="text-muted-foreground ml-2 capitalize text-sm">
                  ({propertyInfo.category})
                </span>
              </div>
              {propertyInfo.description && (
                <p className="text-sm text-muted-foreground">
                  {propertyInfo.description}
                </p>
              )}
              <div className="text-xs text-muted-foreground">
                Value type: {propertyInfo.valueType}
                {propertyInfo.unitFormatId && (
                  <span className="ml-2">
                    Format: {propertyInfo.unitFormatId}
                  </span>
                )}
              </div>
            </div>
          </Section>
        )}

        {/* Temporal */}
        {(statement.validStart || statement.validEnd) && (
          <Section title="Temporal Scope">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Valid from: </span>
                <span>{statement.validStart ?? "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Valid until: </span>
                <span>{statement.validEnd ?? "ongoing"}</span>
              </div>
              {statement.temporalGranularity && (
                <div>
                  <span className="text-muted-foreground">Granularity: </span>
                  <span>{statement.temporalGranularity}</span>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Verdict */}
        {statement.verdict && (
          <Section title="Verdict">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${VERDICT_CONFIG[statement.verdict]?.className ?? "bg-gray-100 text-gray-800"}`}
                >
                  {VERDICT_CONFIG[statement.verdict]?.label ??
                    statement.verdict}
                </span>
                {statement.verdictScore != null && (
                  <span className="text-sm">
                    Score:{" "}
                    <span className="font-semibold">
                      {Math.round(statement.verdictScore * 100)}%
                    </span>
                  </span>
                )}
              </div>
              {statement.verdictQuotes && (
                <blockquote className="border-l-2 border-green-300 pl-3 py-1 text-sm text-muted-foreground">
                  {statement.verdictQuotes}
                </blockquote>
              )}
              {statement.verdictModel && (
                <div className="text-xs text-muted-foreground">
                  Model: {statement.verdictModel}
                </div>
              )}
              {statement.verifiedAt && (
                <div className="text-xs text-muted-foreground">
                  Verified: {statement.verifiedAt}
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Citations */}
        {citations.length > 0 && (
          <Section title={`Citations (${citations.length})`}>
            <div className="space-y-3">
              {citations.map((cit) => (
                <div
                  key={cit.id}
                  className="rounded-md border border-border/60 p-3"
                >
                  <div className="flex items-center gap-2 mb-1">
                    {cit.isPrimary && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        Primary
                      </span>
                    )}
                    {cit.resourceId && (
                      <span className="text-xs font-mono text-muted-foreground">
                        {cit.resourceId}
                      </span>
                    )}
                  </div>
                  {cit.url && (
                    <a
                      href={cit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-blue-600 hover:underline break-all"
                    >
                      {cit.url}
                    </a>
                  )}
                  {cit.sourceQuote && (
                    <blockquote className="mt-2 border-l-2 border-border pl-3 text-sm text-muted-foreground italic">
                      &ldquo;{cit.sourceQuote}&rdquo;
                    </blockquote>
                  )}
                  {cit.locationNote && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Location: {cit.locationNote}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Archive reason */}
        {statement.archiveReason && (
          <Section title="Archive Reason">
            <p className="text-sm text-muted-foreground italic">
              {statement.archiveReason}
            </p>
          </Section>
        )}

        {/* Lineage */}
        {statement.sourceFactKey && (
          <Section title="Lineage">
            <div className="text-sm">
              <span className="text-muted-foreground">Source fact key: </span>
              <span className="font-mono text-xs">
                {statement.sourceFactKey}
              </span>
            </div>
          </Section>
        )}

        {/* Note */}
        {statement.note && (
          <Section title="Note">
            <p className="text-sm text-muted-foreground italic">
              {statement.note}
            </p>
          </Section>
        )}

        {/* Related statements (same property) */}
        {relatedStatements.length > 0 && (
          <Section
            title={`Related Statements (${relatedStatements.length})`}
          >
            <p className="text-xs text-muted-foreground mb-2">
              Other statements for {entityName} with the same property.
            </p>
            <div className="rounded-lg border border-border/60 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/30">
                    <th className="text-left px-3 py-2 text-xs font-medium">
                      Value
                    </th>
                    <th className="text-left px-3 py-2 text-xs font-medium">
                      Period
                    </th>
                    <th className="text-left px-3 py-2 text-xs font-medium">
                      Status
                    </th>
                    <th className="text-left px-3 py-2 text-xs font-medium w-6">
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {relatedStatements.map((rs) => {
                    const rsValue = formatStatementValue(rs, rs.property);
                    const rsBadge = getStatusBadge(rs.status);
                    return (
                      <tr
                        key={rs.id}
                        className="border-b border-border/30 last:border-0"
                      >
                        <td className="px-3 py-2 text-xs font-semibold tabular-nums">
                          {rsValue}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {rs.validStart ?? "—"}
                          {rs.validEnd ? ` → ${rs.validEnd}` : ""}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${rsBadge.className}`}
                          >
                            {rsBadge.label}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <Link
                            href={`/statements/statement/${rs.id}`}
                            className="text-blue-600 hover:underline text-xs"
                          >
                            →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Metadata */}
        <Section title="Metadata">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs text-muted-foreground">
            <div>ID: {statement.id}</div>
            <div>Created: {statement.createdAt}</div>
            {statement.updatedAt && <div>Updated: {statement.updatedAt}</div>}
            {statement.claimCategory && (
              <div>Category: {statement.claimCategory}</div>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}

// ---- Section wrapper ----

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <h2 className="text-sm font-semibold mb-2 text-muted-foreground">
        {title}
      </h2>
      {children}
    </div>
  );
}
