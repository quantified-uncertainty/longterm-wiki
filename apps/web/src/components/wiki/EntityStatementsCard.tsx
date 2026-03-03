import Link from "next/link";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { formatStatementValue } from "@lib/statement-display";
import { slugToNumericId } from "@/lib/mdx";

interface PropertyInfo {
  id: string;
  label: string;
  category: string;
  valueType: string;
  unitFormatId: string | null;
}

interface StatementWithProperty {
  id: number;
  variety: string;
  status: string;
  propertyId: string | null;
  qualifierKey: string | null;
  valueNumeric: number | null;
  valueText: string | null;
  valueDate: string | null;
  valueEntityId: string | null;
  valueSeries: Record<string, unknown> | null;
  validStart: string | null;
  validEnd: string | null;
  property: PropertyInfo | null;
  citations: unknown[];
}

interface ByEntityResult {
  structured: StatementWithProperty[];
  attributed: StatementWithProperty[];
  total: number;
}

/**
 * Compact sidebar card showing key structured statements for an entity.
 * Rendered as a server component — fetches from wiki-server via ISR.
 */
export async function EntityStatementsCard({
  entityId,
}: {
  entityId: string;
}) {
  const result = await fetchFromWikiServer<ByEntityResult>(
    `/api/statements/by-entity?entityId=${encodeURIComponent(entityId)}`,
    { revalidate: 300 }
  );

  if (!result || result.total === 0) return null;

  // Show only active structured statements with current values
  const current = result.structured.filter(
    (s) => s.status === "active" && !s.validEnd
  );

  if (current.length === 0) return null;

  // Take top 8 statements, sorted by property category then label
  const displayed = current
    .sort((a, b) => {
      const catA = a.property?.category ?? "";
      const catB = b.property?.category ?? "";
      if (catA !== catB) return catA.localeCompare(catB);
      return (a.property?.label ?? "").localeCompare(b.property?.label ?? "");
    })
    .slice(0, 8);

  const numericId = slugToNumericId(entityId);
  const pageRef = numericId ?? entityId;

  return (
    <div className="not-prose rounded-lg border border-border/60 bg-muted/10 p-3 my-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Key Statements
      </h3>
      <div className="space-y-1.5">
        {displayed.map((s) => {
          const value = formatStatementValue(s, s.property);
          return (
            <div key={s.id} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground truncate">
                {s.property?.label ?? s.propertyId ?? "—"}
              </span>
              <span className="font-semibold tabular-nums shrink-0">
                {value}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 pt-2 border-t border-border/40">
        <Link
          href={`/wiki/${pageRef}/statements`}
          className="text-xs text-blue-600 hover:underline"
        >
          View all {result.total} statements &rarr;
        </Link>
      </div>
    </div>
  );
}
