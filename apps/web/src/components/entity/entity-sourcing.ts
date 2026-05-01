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
 * Picks the most actionable verdict (lowest `SOURCE_CHECK_VERDICT_PRIORITY`)
 * from a non-empty list. Used by both rollup helpers below.
 */
function pickHighestPriorityVerdict(verdicts: readonly string[]): string | null {
  let best: string | null = null;
  let bestPriority = Infinity;
  for (const v of verdicts) {
    const p = SOURCE_CHECK_VERDICT_PRIORITY[v] ?? 99;
    if (p < bestPriority) {
      bestPriority = p;
      best = v;
    }
  }
  return best;
}

const SUMMARY_VERDICT_KEYS = [
  "contradicted",
  "outdated",
  "partial",
  "unverifiable",
  "confirmed",
  "unchecked",
] as const;

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
  const present = SUMMARY_VERDICT_KEYS.filter((k) => summary[k] > 0);
  return pickHighestPriorityVerdict(present);
}

/**
 * Reduces a per-record verdict list (one row per field) to a single rollup
 * verdict, using the same priority order as `rollupVerdictFromSummary`.
 * Used by record-level inspector pages (e.g. `/things/[id]`) that fetch the
 * `/api/sourcing/verdicts/<recordType>/<recordId>` endpoint directly instead
 * of going through `entity-summary`.
 */
export function rollupVerdictFromVerdictList(
  verdicts: ReadonlyArray<{ verdict: string }>,
): string | null {
  if (verdicts.length === 0) return null;
  return pickHighestPriorityVerdict(verdicts.map((v) => v.verdict));
}
