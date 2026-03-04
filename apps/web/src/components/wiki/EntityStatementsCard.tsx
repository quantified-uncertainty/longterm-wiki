import Link from "next/link";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { formatStatementValue } from "@lib/statement-display";
import { slugToNumericId } from "@/lib/mdx";
import type { ByEntityResult, StatementWithDetails } from "@lib/statement-types";

/**
 * Score a statement for ranking — higher = more useful to show.
 */
function rankScore(s: StatementWithDetails): number {
  let score = 0;
  if (s.citations.length > 0) score += 40;
  if (s.verdict && s.verdict !== "not_verifiable") score += 30;
  if (s.validStart || s.validEnd) score += 20;
  if (s.verdictScore != null) score += 10;
  // Prefer numeric values over text (more structured = more useful in summary)
  if (s.valueNumeric != null) score += 15;
  // Tiebreak: higher ID = more recent
  score += s.id / 1_000_000;
  return score;
}

/**
 * Deduplicate by property label — keep the best one per property.
 */
function pickBestPerProperty(statements: StatementWithDetails[]): StatementWithDetails[] {
  const groups = new Map<string, StatementWithDetails[]>();
  for (const s of statements) {
    const label = s.property?.label ?? s.propertyId ?? "—";
    const list = groups.get(label) ?? [];
    list.push(s);
    groups.set(label, list);
  }

  const result: StatementWithDetails[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => rankScore(b) - rankScore(a));
    result.push(group[0]);
  }
  return result;
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

  // Active structured statements with a property
  const withProperty = result.structured.filter(
    (s) => s.status === "active" && s.property && s.propertyId
  );

  // Require at least SOME signal: a source, a real verdict, or a date
  const quality = withProperty.filter(
    (s) => s.citations.length > 0 || (s.verdict && s.verdict !== "not_verifiable") || s.validStart || s.validEnd
  );

  // Deduplicate — one best row per property label
  const deduped = pickBestPerProperty(quality);

  if (deduped.length === 0) return null;

  // Take top 8 by rank score
  const displayed = deduped
    .sort((a, b) => rankScore(b) - rankScore(a))
    .slice(0, 8);

  const numericId = slugToNumericId(entityId);
  const pageRef = numericId ?? entityId;

  return (
    <div className="not-prose rounded-lg border border-border/60 bg-muted/10 p-3 my-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">
        Key Statements
      </h3>
      <p className="text-[10px] text-muted-foreground/50 mb-2">
        From statements database
      </p>
      <div className="space-y-0.5">
        {displayed.map((s) => (
          <StatementRow key={s.id} statement={s} />
        ))}
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

function StatementRow({ statement: s }: { statement: StatementWithDetails }) {
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
