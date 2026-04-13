import { cache } from "react";
import { fetchFromWikiServer, type RpcEntitySummaryRow, type RpcEntitySummaryResult } from "@/lib/wiki-server";
import { SOURCE_CHECK_VERDICT_PRIORITY } from "@/components/shared/verdict-styles";

const SUMMARY_REVALIDATE_SECONDS = 300;

/**
 * Fetches the full `/api/sourcing/entity-summary` response once per request.
 *
 * Wrapped in React's per-request `cache()` so concurrent entity-profile page
 * renders in the same build/ISR pass share one network fetch instead of
 * each triggering their own (the upstream endpoint returns ALL entity
 * summaries, so per-page scatter-fetching is wasteful).
 *
 * Next.js ISR also caches the underlying `fetch()` across requests for
 * `SUMMARY_REVALIDATE_SECONDS` (5 minutes), so successive builds also share
 * the result at the HTTP layer. Returns null when the wiki-server is
 * unreachable (fetchFromWikiServer catches network/HTTP errors internally).
 */
const fetchSourcingSummaryList = cache(
  async (): Promise<RpcEntitySummaryResult | null> =>
    fetchFromWikiServer<RpcEntitySummaryResult>(
      "/api/sourcing/entity-summary",
      { revalidate: SUMMARY_REVALIDATE_SECONDS, timeoutMs: 10_000 },
    ),
);

/**
 * Looks up the sourcing summary row for a single entity.
 *
 * The upstream row's `entityId` may be either a slug or a stableId depending
 * on how each verdict was recorded. Pass any known identifiers for the entity
 * (slug, stableId, numericId) and the helper will match on any.
 */
export async function fetchEntitySourcingSummary(
  candidateIds: string | readonly string[],
): Promise<RpcEntitySummaryRow | null> {
  const ids = Array.isArray(candidateIds) ? candidateIds : [candidateIds];
  const filtered = ids.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (filtered.length === 0) return null;
  const result = await fetchSourcingSummaryList();
  if (!result) return null;
  const idSet = new Set(filtered);
  return result.summaries.find((row) => idSet.has(row.entityId)) ?? null;
}

/**
 * Reduces a per-entity verdict count row to a single rollup verdict, preferring
 * the most actionable verdict present (contradicted > outdated > partial > ...).
 * Returns null when no verdicts are recorded.
 */
export function rollupVerdictFromSummary(
  summary: Pick<
    RpcEntitySummaryRow,
    "confirmed" | "contradicted" | "outdated" | "partial" | "unverifiable" | "unchecked"
  > | null | undefined,
): string | null {
  if (!summary) return null;
  const counts: Array<[string, number]> = [
    ["contradicted", summary.contradicted],
    ["outdated", summary.outdated],
    ["partial", summary.partial],
    ["unverifiable", summary.unverifiable],
    ["confirmed", summary.confirmed],
    ["unchecked", summary.unchecked],
  ];
  const present = counts.filter(([, n]) => n > 0);
  if (present.length === 0) return null;
  present.sort(
    ([a], [b]) =>
      (SOURCE_CHECK_VERDICT_PRIORITY[a] ?? 99) -
      (SOURCE_CHECK_VERDICT_PRIORITY[b] ?? 99),
  );
  return present[0][0];
}
