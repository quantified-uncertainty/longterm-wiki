import Link from "next/link";
import { fetchDetailed, type RpcEntitySummaryRow } from "@lib/wiki-server";
import { getTypedEntities, getEntityHref } from "@data";

// ── Types ────────────────────────────────────────────────────────────────

export interface WorstEntityRow {
  entityId: string;
  displayName: string;
  href: string | null;
  nonGreenCount: number;
  contradicted: number;
  outdated: number;
  partial: number;
  unverifiable: number;
  unchecked: number;
  totalVerdicts: number;
  totalRecords: number;
}

interface EntityLookupEntry {
  name: string;
  href: string | null;
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────

/**
 * "Non-green" verdicts are everything that isn't `confirmed`: things that
 * are wrong, stale, partially-supported, unverifiable, or never checked.
 * The ticket frames this as "where to run verification next."
 */
export function computeNonGreenCount(row: RpcEntitySummaryRow): number {
  return (
    row.contradicted +
    row.outdated +
    row.partial +
    row.unverifiable +
    row.unchecked
  );
}

/**
 * Rank entities by count of non-green records, drop fully-green ones, and
 * take the top `limit` (default 20). Ties break by total records
 * descending so bigger entities float up over tiny stubs with the same
 * absolute bad count.
 */
export function computeWorstEntities(
  summaries: readonly RpcEntitySummaryRow[],
  entityLookup: ReadonlyMap<string, EntityLookupEntry>,
  limit = 20,
): WorstEntityRow[] {
  const rows: WorstEntityRow[] = [];
  for (const s of summaries) {
    const nonGreen = computeNonGreenCount(s);
    if (nonGreen === 0) continue;
    const info = entityLookup.get(s.entityId);
    rows.push({
      entityId: s.entityId,
      displayName: info?.name ?? s.entityId,
      href: info?.href ?? null,
      nonGreenCount: nonGreen,
      contradicted: s.contradicted,
      outdated: s.outdated,
      partial: s.partial,
      unverifiable: s.unverifiable,
      unchecked: s.unchecked,
      totalVerdicts: s.totalVerdicts,
      totalRecords: s.totalRecords,
    });
  }
  rows.sort((a, b) => {
    if (a.nonGreenCount !== b.nonGreenCount) {
      return b.nonGreenCount - a.nonGreenCount;
    }
    return b.totalRecords - a.totalRecords;
  });
  return rows.slice(0, limit);
}

// ── Data loading (server-only) ───────────────────────────────────────────

async function loadEntitySummaries(): Promise<RpcEntitySummaryRow[]> {
  const result = await fetchDetailed<{ summaries: RpcEntitySummaryRow[] }>(
    "/api/sourcing/entity-summary",
    { revalidate: 300 },
  );
  if (!result.ok) return [];
  return result.data.summaries ?? [];
}

function buildEntityLookup(): Map<string, EntityLookupEntry> {
  const lookup = new Map<string, EntityLookupEntry>();
  const entities = getTypedEntities();
  for (const e of entities) {
    const entry: EntityLookupEntry = {
      name: e.title || e.id,
      href: getEntityHref(e.id, e.entityType) ?? null,
    };
    // entity-summary.entityId may be either a slug or a stableId; index
    // both so the lookup resolves regardless of which form came back.
    lookup.set(e.id, entry);
    if (e.stableId) lookup.set(e.stableId, entry);
  }
  return lookup;
}

// ── Server component ─────────────────────────────────────────────────────

/**
 * Worst-entities leaderboard: top 20 entities by count of non-green
 * (contradicted / outdated / partial / unverifiable / unchecked) records.
 * Feeds prioritization — "where to run verification next."
 */
export async function WorstEntitiesWidget() {
  const summaries = await loadEntitySummaries();
  const lookup = buildEntityLookup();
  const worst = computeWorstEntities(summaries, lookup);

  return (
    <div className="not-prose mb-8">
      <h2 className="text-lg font-semibold mb-1">Worst Entities</h2>
      <p className="text-sm text-muted-foreground mb-3">
        Top 20 entities ranked by count of non-green records (contradicted,
        outdated, partial, unverifiable, or unchecked). Use this list to
        prioritize the next verification run.
      </p>
      {worst.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center border border-border/60 rounded-lg">
          No non-green verdicts found. Either everything is clean or the
          entity-summary endpoint returned no data.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="border-b border-border/60 text-xs text-muted-foreground">
                <th className="text-left py-2 pr-3 font-medium w-8">#</th>
                <th className="text-left py-2 pr-3 font-medium">Entity</th>
                <th className="text-right py-2 pr-3 font-medium">Non-green</th>
                <th className="text-right py-2 pr-3 font-medium">Contra</th>
                <th className="text-right py-2 pr-3 font-medium">Outdated</th>
                <th className="text-right py-2 pr-3 font-medium">Partial</th>
                <th className="text-right py-2 pr-3 font-medium">Unverif</th>
                <th className="text-right py-2 pr-3 font-medium">Unchecked</th>
                <th className="text-right py-2 pr-3 font-medium">Records</th>
              </tr>
            </thead>
            <tbody>
              {worst.map((row, idx) => (
                <tr
                  key={row.entityId}
                  className="border-b border-border/40 last:border-0"
                >
                  <td className="py-2 pr-3 text-muted-foreground">{idx + 1}</td>
                  <td className="py-2 pr-3 font-medium">
                    {row.href ? (
                      <Link
                        href={row.href}
                        className="text-primary hover:underline"
                      >
                        {row.displayName}
                      </Link>
                    ) : (
                      row.displayName
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-semibold">
                    {row.nonGreenCount}
                  </td>
                  <td className="py-2 pr-3 text-right text-red-600">
                    {row.contradicted || ""}
                  </td>
                  <td className="py-2 pr-3 text-right text-amber-600">
                    {row.outdated || ""}
                  </td>
                  <td className="py-2 pr-3 text-right text-amber-500">
                    {row.partial || ""}
                  </td>
                  <td className="py-2 pr-3 text-right text-orange-600">
                    {row.unverifiable || ""}
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    {row.unchecked || ""}
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    {row.totalRecords}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
