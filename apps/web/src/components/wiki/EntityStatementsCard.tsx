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
  citations: { id: number }[];
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

  // Group by category for display when 2+ categories present
  const categories = new Map<string, typeof displayed>();
  for (const s of displayed) {
    const cat = s.property?.category ?? "other";
    const list = categories.get(cat) ?? [];
    list.push(s);
    categories.set(cat, list);
  }
  const showCategoryHeaders = categories.size >= 2;

  return (
    <div className="not-prose rounded-lg border border-border/60 bg-muted/10 p-3 my-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">
        Key Statements
      </h3>
      <p className="text-[10px] text-muted-foreground/50 mb-2">
        From statements database
      </p>
      <div className="space-y-1.5">
        {showCategoryHeaders
          ? [...categories.entries()]
              .sort((a, b) => b[1].length - a[1].length)
              .map(([cat, stmts]) => (
                <div key={cat}>
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground/60 font-medium mt-1.5 mb-0.5">
                    {cat}
                  </p>
                  {stmts.map((s) => (
                    <StatementRow key={s.id} statement={s} />
                  ))}
                </div>
              ))
          : displayed.map((s) => <StatementRow key={s.id} statement={s} />)}
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

function StatementRow({ statement: s }: { statement: StatementWithProperty }) {
  const value = formatStatementValue(s, s.property);
  const hasCitations = s.citations.length > 0;

  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground truncate flex items-center gap-1">
        {hasCitations && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"
            title={`${s.citations.length} citation${s.citations.length !== 1 ? "s" : ""}`}
          />
        )}
        {s.property?.label ?? s.propertyId ?? "—"}
      </span>
      <span className="font-semibold tabular-nums shrink-0 flex items-baseline gap-1">
        {value}
        {s.validStart && (
          <span className="text-[10px] text-muted-foreground/60 font-normal">
            ({s.validStart})
          </span>
        )}
      </span>
    </div>
  );
}
