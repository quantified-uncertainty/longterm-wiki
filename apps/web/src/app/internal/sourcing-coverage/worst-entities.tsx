import Link from "next/link";
import { fetchDetailed, type RpcEntitySummaryRow } from "@lib/wiki-server";
import {
  getTypedEntityById,
  getTypedEntityByStableId,
  getEntityHref,
} from "@data";

// ── Types ────────────────────────────────────────────────────────────────

export interface WorstEntityRow {
  entityId: string;
  displayName: string;
  href: string;
  nonGreenCount: number;
  contradicted: number;
  outdated: number;
  partial: number;
  unverifiable: number;
  unchecked: number;
  totalVerdicts: number;
  totalRecords: number;
}

export interface EntityResolver {
  (entityId: string): { name: string; href: string };
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
  resolve: EntityResolver,
  limit = 20,
): WorstEntityRow[] {
  const rows: WorstEntityRow[] = [];
  for (const s of summaries) {
    const nonGreen = computeNonGreenCount(s);
    if (nonGreen === 0) continue;
    const { name, href } = resolve(s.entityId);
    rows.push({
      entityId: s.entityId,
      displayName: name,
      href,
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

type SummariesState =
  | { status: "ok"; summaries: RpcEntitySummaryRow[] }
  | { status: "error"; message: string };

function formatApiErrorMessage(
  error: { type: string; message?: string; status?: number; statusText?: string },
): string {
  if (error.type === "not-configured") return "wiki-server not configured";
  if (error.type === "connection-error")
    return `connection error: ${error.message ?? "unknown"}`;
  if (error.type === "server-error")
    return `server ${error.status ?? "?"} ${error.statusText ?? ""}`.trim();
  return "unknown error";
}

async function loadEntitySummaries(): Promise<SummariesState> {
  const result = await fetchDetailed<{ summaries: RpcEntitySummaryRow[] }>(
    "/api/sourcing/entity-summary",
    // Fresh priorities matter — operators re-check this dashboard right
    // after running a verification batch.
    { revalidate: 60 },
  );
  if (!result.ok) {
    return { status: "error", message: formatApiErrorMessage(result.error) };
  }
  return { status: "ok", summaries: result.data.summaries ?? [] };
}

/**
 * Resolve an entity-summary `entityId` (slug, sid_ prefixed, or bare 10-char)
 * to a display name + href using the canonical lookup helpers. Falls back
 * to the raw ID if nothing matches, so we never break the UI on an
 * unexpected ID shape.
 */
export function resolveEntityDisplay(entityId: string): {
  name: string;
  href: string;
} {
  const entity =
    getTypedEntityByStableId(entityId) ?? getTypedEntityById(entityId);
  const name = entity?.title || entityId;
  // getEntityHref handles slug / sid_* / bare 10-char / wikiId uniformly.
  const href = getEntityHref(entityId);
  return { name, href };
}

// ── Server component ─────────────────────────────────────────────────────

/**
 * Worst-entities leaderboard: top 20 entities by count of non-green
 * (contradicted / outdated / partial / unverifiable / unchecked) records.
 * Feeds prioritization — "where to run verification next."
 */
export async function WorstEntitiesWidget() {
  const state = await loadEntitySummaries();

  return (
    <div className="not-prose mb-8">
      <h2 className="text-lg font-semibold mb-1">Worst Entities</h2>
      <p className="text-sm text-muted-foreground mb-3">
        Top 20 entities ranked by count of non-green records (contradicted,
        outdated, partial, unverifiable, or unchecked). Use this list to
        prioritize the next verification run.
      </p>
      <WorstEntitiesBody state={state} />
    </div>
  );
}

function WorstEntitiesBody({ state }: { state: SummariesState }) {
  if (state.status === "error") {
    return (
      <p className="text-sm text-amber-600 py-6 text-center border border-amber-500/40 rounded-lg">
        Could not load entity-summary from wiki-server:{" "}
        <code className="text-[11px]">{state.message}</code>. Leaderboard
        unavailable until the endpoint recovers.
      </p>
    );
  }

  const worst = computeWorstEntities(state.summaries, resolveEntityDisplay);

  if (worst.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center border border-border/60 rounded-lg">
        No non-green verdicts found across {state.summaries.length} entities.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <caption className="sr-only">
          Top 20 entities ranked by count of non-green verdicts
        </caption>
        <thead>
          <tr className="border-b border-border/60 text-xs text-muted-foreground">
            <th scope="col" className="text-left py-2 pr-3 font-medium w-8">
              #
            </th>
            <th scope="col" className="text-left py-2 pr-3 font-medium">
              Entity
            </th>
            <th scope="col" className="text-right py-2 pr-3 font-medium">
              Non-green
            </th>
            <th scope="col" className="text-right py-2 pr-3 font-medium">
              Contra
            </th>
            <th scope="col" className="text-right py-2 pr-3 font-medium">
              Outdated
            </th>
            <th scope="col" className="text-right py-2 pr-3 font-medium">
              Partial
            </th>
            <th scope="col" className="text-right py-2 pr-3 font-medium">
              Unverif
            </th>
            <th scope="col" className="text-right py-2 pr-3 font-medium">
              Unchecked
            </th>
            <th scope="col" className="text-right py-2 pr-3 font-medium">
              Records
            </th>
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
                <Link href={row.href} className="text-primary hover:underline">
                  {row.displayName}
                </Link>
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
  );
}
