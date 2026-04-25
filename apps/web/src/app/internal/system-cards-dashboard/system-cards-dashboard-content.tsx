/**
 * System Cards Dashboard — coverage matrix for model_system_cards (QUA-702).
 *
 * Surfaces:
 *   1. Top-level stats (total cards, # labs, # models, average fill rate)
 *   2. Per-lab × per-field coverage matrix
 *   3. Stale rows (extracted_at older than 30 days)
 *
 * Backed by GET /api/model-system-cards/all + /stats.
 */
import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
  type RpcModelSystemCardsAllResult,
  type RpcModelSystemCardsStatsResult,
  type RpcModelSystemCardRow,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";

// ── Constants ────────────────────────────────────────────────────────────

const STALE_THRESHOLD_DAYS = 30;

/**
 * Fields tracked in the per-lab coverage matrix. Order matters — these are
 * the columns displayed in the matrix table. Booleans answer "is this field
 * populated for this row?".
 */
const COVERAGE_FIELDS: Array<{
  key: string;
  label: string;
  test: (r: RpcModelSystemCardRow) => boolean;
}> = [
  { key: "version", label: "Ver", test: (r) => r.version != null },
  { key: "release_date", label: "Date", test: (r) => r.releaseDate != null },
  { key: "training_cutoff", label: "Cutoff", test: (r) => r.trainingCutoff != null },
  { key: "parameters_total", label: "Params", test: (r) => r.parametersTotal != null },
  {
    key: "context_window",
    label: "Ctx",
    test: (r) => r.contextWindowTokens != null,
  },
  {
    key: "modalities_in",
    label: "Modal",
    test: (r) => Array.isArray(r.modalitiesIn) && r.modalitiesIn.length > 0,
  },
  { key: "safety_tier", label: "Tier", test: (r) => r.safetyTier != null },
  {
    key: "safeguards",
    label: "Safe",
    test: (r) => r.safeguardsSummary != null && r.safeguardsSummary !== "",
  },
  {
    key: "eval_scores",
    label: "Evals",
    test: (r) =>
      Array.isArray(r.evalScoresCited) && r.evalScoresCited.length > 0,
  },
  {
    key: "third_party",
    label: "3P",
    test: (r) => Array.isArray(r.thirdPartyEvals) && r.thirdPartyEvals.length > 0,
  },
];

// ── Types ────────────────────────────────────────────────────────────────

interface DashboardData {
  stats: RpcModelSystemCardsStatsResult;
  cards: RpcModelSystemCardRow[];
}

interface LabCoverage {
  framework: string;
  cardCount: number;
  modelCount: number;
  fieldFills: Map<string, number>; // field key → count of rows with field populated
}

// ── Data Loading ─────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [statsResult, allResult] = await Promise.all([
    fetchDetailed<RpcModelSystemCardsStatsResult>(
      "/api/model-system-cards/stats",
      { revalidate: 60 },
    ),
    fetchDetailed<RpcModelSystemCardsAllResult>(
      "/api/model-system-cards/all?limit=200",
      { revalidate: 60 },
    ),
  ]);

  if (!statsResult.ok) return statsResult;
  if (!allResult.ok) return allResult;

  return {
    ok: true,
    data: { stats: statsResult.data, cards: allResult.data.items },
  };
}

function emptyFallback(): DashboardData {
  return {
    stats: {
      total: 0,
      models: 0,
      withSafetyTier: 0,
      withComputeFlops: 0,
      withParameters: 0,
    },
    cards: [],
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────

function buildLabCoverage(cards: RpcModelSystemCardRow[]): LabCoverage[] {
  const groups = new Map<string, RpcModelSystemCardRow[]>();
  for (const c of cards) {
    const key = c.safetyFramework ?? "(unspecified)";
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }

  const out: LabCoverage[] = [];
  for (const [framework, rows] of groups) {
    const modelIds = new Set<string>();
    const fieldFills = new Map<string, number>();
    for (const f of COVERAGE_FIELDS) fieldFills.set(f.key, 0);

    for (const r of rows) {
      modelIds.add(r.aiModelId);
      for (const f of COVERAGE_FIELDS) {
        if (f.test(r)) fieldFills.set(f.key, (fieldFills.get(f.key) ?? 0) + 1);
      }
    }
    out.push({
      framework,
      cardCount: rows.length,
      modelCount: modelIds.size,
      fieldFills,
    });
  }

  out.sort((a, b) => b.cardCount - a.cardCount);
  return out;
}

function findStaleCards(
  cards: RpcModelSystemCardRow[],
  thresholdDays: number,
): RpcModelSystemCardRow[] {
  const cutoff = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  return cards.filter((c) => {
    if (!c.extractedAt) return false;
    const t = new Date(c.extractedAt).getTime();
    return Number.isFinite(t) && t < cutoff;
  });
}

function fillRateClass(rate: number): string {
  if (rate >= 0.8) return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (rate >= 0.5) return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  if (rate > 0) return "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300";
  return "bg-muted/40 text-muted-foreground/50";
}

function ageInDays(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

// ── Content Component ────────────────────────────────────────────────────


/**
 * Safely extract hostname; returns the raw URL if URL parsing fails. Defends
 * the dashboard render against malformed sourceUrl values from extraction.
 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function SystemCardsDashboardContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyFallback,
  );

  const { stats, cards } = data;
  const labs = buildLabCoverage(cards);
  const staleCards = findStaleCards(cards, STALE_THRESHOLD_DAYS);

  // Compute over the loaded sample (`cards.length`), not stats.total — labs is
  // built from the fetched page (?limit=200), so the numerator only covers loaded
  // cards. Using stats.total would bias the fill rate low once cards > 200.
  const totalFieldsPossible = cards.length * COVERAGE_FIELDS.length;
  const totalFieldsFilled = labs.reduce(
    (sum, lab) =>
      sum +
      Array.from(lab.fieldFills.values()).reduce((a, b) => a + b, 0),
    0,
  );
  const overallFillRate =
    totalFieldsPossible > 0 ? totalFieldsFilled / totalFieldsPossible : 0;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Coverage of structured fields extracted from flagship AI model / system
        cards (QUA-690). Backed by{" "}
        <code className="text-xs">model_system_cards</code>; populated via{" "}
        <code className="text-xs">crux tb system-cards extract</code>.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 my-6">
        <StatCard label="Total Cards" value={stats.total.toString()} />
        <StatCard label="Models Covered" value={stats.models.toString()} />
        <StatCard label="Frameworks" value={labs.length.toString()} />
        <StatCard
          label="Avg Fill Rate"
          value={`${Math.round(overallFillRate * 100)}%`}
        />
        <StatCard label="Stale (>30d)" value={staleCards.length.toString()} />
      </div>

      {/* Per-lab × per-field matrix */}
      {labs.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">Coverage by Framework</h2>
          <p className="text-xs text-muted-foreground mb-3">
            Each cell shows the fraction of cards in that framework that have
            the field populated. Green ≥80%, amber ≥50%, orange &gt;0, grey 0.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr className="text-xs text-muted-foreground">
                  <th className="py-2 px-3 text-left font-medium sticky left-0 bg-muted/30">
                    Framework
                  </th>
                  <th className="py-2 px-3 text-right font-medium">Cards</th>
                  <th className="py-2 px-3 text-right font-medium">Models</th>
                  {COVERAGE_FIELDS.map((f) => (
                    <th
                      key={f.key}
                      className="py-2 px-2 text-center font-medium"
                      title={f.key}
                    >
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {labs.map((lab) => (
                  <tr key={lab.framework} className="hover:bg-muted/20">
                    <td className="py-2 px-3 font-medium sticky left-0 bg-background">
                      {lab.framework}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {lab.cardCount}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                      {lab.modelCount}
                    </td>
                    {COVERAGE_FIELDS.map((f) => {
                      const fills = lab.fieldFills.get(f.key) ?? 0;
                      const rate = lab.cardCount > 0 ? fills / lab.cardCount : 0;
                      return (
                        <td
                          key={f.key}
                          className={`py-1.5 px-2 text-center text-xs tabular-nums ${fillRateClass(rate)}`}
                          title={`${fills} / ${lab.cardCount}`}
                        >
                          {Math.round(rate * 100)}%
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Stale rows */}
      {staleCards.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">
            Stale Cards
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              (extracted &gt; {STALE_THRESHOLD_DAYS} days ago)
            </span>
          </h2>
          <div className="rounded-lg border border-border/60 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr className="text-xs text-muted-foreground">
                  <th className="py-2 px-3 text-left font-medium">Model</th>
                  <th className="py-2 px-3 text-left font-medium">Version</th>
                  <th className="py-2 px-3 text-right font-medium">
                    Age (days)
                  </th>
                  <th className="py-2 px-3 text-left font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {staleCards.slice(0, 50).map((c) => (
                  <tr key={c.id} className="hover:bg-muted/20">
                    <td className="py-2 px-3">
                      {c.aiModel?.title ?? c.aiModelDisplayName ?? c.aiModelId}
                    </td>
                    <td className="py-2 px-3 text-muted-foreground">
                      {c.version ?? (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                      {ageInDays(c.extractedAt) ?? "—"}
                    </td>
                    <td className="py-2 px-3">
                      {c.sourceUrl ? (
                        <a
                          href={c.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline truncate max-w-xs inline-block"
                          title={c.sourceUrl}
                        >
                          {safeHostname(c.sourceUrl)}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {staleCards.length > 50 && (
              <div className="px-3 py-2 text-xs text-muted-foreground text-center bg-muted/20">
                Showing 50 of {staleCards.length} stale cards
              </div>
            )}
          </div>
        </div>
      )}

      {stats.total === 0 && (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground my-6">
          <p className="text-lg font-medium mb-2">No system cards extracted yet</p>
          <p className="text-sm">
            Run{" "}
            <code className="text-xs">
              crux tb system-cards extract &lt;url&gt; --ai-model=&lt;sid&gt; --apply
            </code>{" "}
            to populate this table.
          </p>
        </div>
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}

// ── Helper Components ────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
