/**
 * Market Data section for organization profile pages.
 *
 * Fetches secondary market prices and prediction market questions from the
 * wiki-server and displays them in the "Market Data" tab on org pages.
 */
import {
  fetchFromWikiServer,
  type RpcSecondaryMarketLatestResult,
  type RpcSecondaryMarketTimeseriesResult,
  type RpcPredictionQuestionsByEntityResult,
  type RpcPredictionQuestion,
} from "@/lib/wiki-server";
import { formatCompactCurrency } from "@/lib/format-compact";
import { getRecordVerdict } from "@data/tablebase";
import { getSourceCheckHref } from "@/app/source-checks/source-checks-shared";
import { SourceCheckDot } from "@/components/verification/SourceCheckDot";
import { recordVerdictToStatus } from "@/components/verification/source-check-status";
import { SectionHeader } from "./org-shared";

// ── Data Fetching ────────────────────────────────────────────────────

interface MarketData {
  secondaryLatest: RpcSecondaryMarketLatestResult | null;
  secondaryTimeseries: RpcSecondaryMarketTimeseriesResult | null;
  predictionQuestions: RpcPredictionQuestionsByEntityResult | null;
}

export async function fetchMarketData(entityId: string): Promise<MarketData> {
  const [secondaryLatest, secondaryTimeseries, predictionQuestions] =
    await Promise.all([
      fetchFromWikiServer<RpcSecondaryMarketLatestResult>(
        `/api/secondary-market-prices/latest/${encodeURIComponent(entityId)}`,
        { revalidate: 300, timeoutMs: 10_000 }
      ),
      fetchFromWikiServer<RpcSecondaryMarketTimeseriesResult>(
        `/api/secondary-market-prices/timeseries/${encodeURIComponent(entityId)}`,
        { revalidate: 300, timeoutMs: 10_000 }
      ),
      fetchFromWikiServer<RpcPredictionQuestionsByEntityResult>(
        `/api/prediction-markets/questions/by-entity/${encodeURIComponent(entityId)}?limit=100`,
        { revalidate: 300, timeoutMs: 10_000 }
      ),
    ]);

  return { secondaryLatest, secondaryTimeseries, predictionQuestions };
}

export function hasMarketData(data: MarketData): boolean {
  const hasSecondary =
    (data.secondaryLatest?.prices?.length ?? 0) > 0;
  const hasPrediction =
    (data.predictionQuestions?.questions?.length ?? 0) > 0;
  return hasSecondary || hasPrediction;
}

export function getMarketDataCount(data: MarketData): number {
  return (
    (data.secondaryLatest?.prices?.length ?? 0) +
    (data.predictionQuestions?.questions?.length ?? 0)
  );
}

// ── Section Component ────────────────────────────────────────────────

export function MarketDataSection({ data }: { data: MarketData }) {
  const hasSecondary =
    (data.secondaryLatest?.prices?.length ?? 0) > 0;
  const hasPrediction =
    (data.predictionQuestions?.questions?.length ?? 0) > 0;

  return (
    <div className="space-y-8">
      {hasSecondary && (
        <SecondaryMarketSection
          latest={data.secondaryLatest!}
          timeseries={data.secondaryTimeseries}
        />
      )}
      {hasPrediction && (
        <PredictionMarketSection
          questions={data.predictionQuestions!.questions}
        />
      )}
      {!hasSecondary && !hasPrediction && (
        <p className="text-sm text-muted-foreground">
          No market data available for this entity.
        </p>
      )}
    </div>
  );
}

// ── Secondary Market Subsection ──────────────────────────────────────

function SecondaryMarketSection({
  latest,
  timeseries,
}: {
  latest: RpcSecondaryMarketLatestResult;
  timeseries: RpcSecondaryMarketTimeseriesResult | null;
}) {
  const { summary, prices } = latest;

  return (
    <section>
      <SectionHeader
        title="Secondary Market Valuations"
        count={prices.length}
      />

      {/* Summary cards */}
      {summary && summary.medianValuation != null && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <MiniStat
            label="Median Valuation"
            value={formatCompactCurrency(summary.medianValuation)}
          />
          <MiniStat
            label="Range"
            value={`${formatCompactCurrency(summary.minValuation ?? 0)} – ${formatCompactCurrency(summary.maxValuation ?? 0)}`}
          />
          <MiniStat
            label="Platforms"
            value={String(summary.platformCount)}
          />
          {summary.dispersionPercent != null && (
            <MiniStat
              label="Dispersion"
              value={`${summary.dispersionPercent}%`}
            />
          )}
        </div>
      )}

      {/* Prices table */}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Platform</th>
              <th className="text-left py-2 px-3 font-medium">Date</th>
              <th className="text-right py-2 px-3 font-medium">Valuation</th>
              <th className="text-left py-2 px-3 font-medium">Type</th>
              <th className="text-left py-2 px-3 font-medium">Source</th>
              <th className="py-2 px-1 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {prices.map((p) => {
              const verdict = getRecordVerdict("secondary-market-price", String(p.id))?.verdict;
              return (
                <tr
                  key={p.id}
                  className="hover:bg-muted/20 transition-colors"
                >
                  <td className="py-2 px-3 capitalize font-medium">
                    {p.platform}
                  </td>
                  <td className="py-2 px-3 text-muted-foreground">
                    {p.date}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {p.impliedValuation != null
                      ? formatCompactCurrency(p.impliedValuation)
                      : "–"}
                  </td>
                  <td className="py-2 px-3">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {p.priceType}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    {p.source && (
                      <a
                        href={p.source}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline"
                      >
                        link
                      </a>
                    )}
                  </td>
                  <td className="py-2 px-1">
                    <SourceCheckDot
                      status={recordVerdictToStatus(verdict)}
                      originalVerdict={verdict}
                      size="md"
                      href={getSourceCheckHref("secondary-market-price", String(p.id))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Timeseries summary */}
      {timeseries && timeseries.points.length > 1 && (
        <p className="text-xs text-muted-foreground mt-2">
          {timeseries.points.length} data points from{" "}
          {timeseries.points[0].date} to{" "}
          {timeseries.points[timeseries.points.length - 1].date}
        </p>
      )}
    </section>
  );
}

// ── Prediction Market Subsection ─────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  metaculus: "Metaculus",
  polymarket: "Polymarket",
  manifold: "Manifold",
};

function PredictionMarketSection({
  questions,
}: {
  questions: RpcPredictionQuestion[];
}) {
  const active = questions.filter((q) => !q.isResolved);
  const resolved = questions.filter((q) => q.isResolved);

  return (
    <section>
      <SectionHeader
        title="Prediction Markets"
        count={questions.length}
      />

      {active.length > 0 && (
        <div className="border border-border/60 rounded-xl overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                <th className="text-left py-2 px-3 font-medium">
                  Question
                </th>
                <th className="text-center py-2 px-3 font-medium w-24">
                  Probability
                </th>
                <th className="text-left py-2 px-3 font-medium w-24">
                  Platform
                </th>
                <th className="text-left py-2 px-3 font-medium w-24">
                  Category
                </th>
                <th className="text-left py-2 px-3 font-medium w-28">
                  Resolves
                </th>
                <th className="py-2 px-1 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {active.map((q) => (
                <QuestionRow key={q.id} question={q} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {resolved.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mt-6 mb-2">
            Resolved ({resolved.length})
          </h3>
          <div className="border border-border/60 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="text-left py-2 px-3 font-medium">
                    Question
                  </th>
                  <th className="text-center py-2 px-3 font-medium w-24">
                    Resolution
                  </th>
                  <th className="text-left py-2 px-3 font-medium w-24">
                    Platform
                  </th>
                  <th className="py-2 px-1 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {resolved.map((q) => {
                  const verdict = getRecordVerdict("prediction-question", String(q.id))?.verdict;
                  return (
                  <tr
                    key={q.id}
                    className="hover:bg-muted/20 transition-colors opacity-60"
                  >
                    <td className="py-2 px-3">
                      {q.questionUrl ? (
                        <a
                          href={q.questionUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-primary transition-colors"
                        >
                          {q.questionText}
                        </a>
                      ) : (
                        q.questionText
                      )}
                    </td>
                    <td className="py-2 px-3 text-center">
                      {q.resolutionValue != null
                        ? q.resolutionValue === 1
                          ? "Yes"
                          : q.resolutionValue === 0
                            ? "No"
                            : String(q.resolutionValue)
                        : "–"}
                    </td>
                    <td className="py-2 px-3">
                      {PLATFORM_LABELS[q.platform] ?? q.platform}
                    </td>
                    <td className="py-2 px-1">
                      <SourceCheckDot
                        status={recordVerdictToStatus(verdict)}
                        originalVerdict={verdict}
                        size="md"
                        href={getSourceCheckHref("prediction-question", String(q.id))}
                      />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function QuestionRow({ question: q }: { question: RpcPredictionQuestion }) {
  const prob = q.currentProbability;
  const verdict = getRecordVerdict("prediction-question", String(q.id))?.verdict;

  return (
    <tr className="hover:bg-muted/20 transition-colors">
      <td className="py-2.5 px-3">
        {q.questionUrl ? (
          <a
            href={q.questionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground hover:text-primary transition-colors"
          >
            {q.questionText}
          </a>
        ) : (
          q.questionText
        )}
      </td>
      <td className="py-2.5 px-3 text-center">
        {prob != null ? (
          <ProbabilityBadge probability={prob} />
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </td>
      <td className="py-2.5 px-3">
        <span className="text-xs">
          {PLATFORM_LABELS[q.platform] ?? q.platform}
        </span>
      </td>
      <td className="py-2.5 px-3">
        {q.category && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground capitalize">
            {q.category}
          </span>
        )}
      </td>
      <td className="py-2.5 px-3 text-xs text-muted-foreground">
        {q.resolutionDate ?? "–"}
      </td>
      <td className="py-2.5 px-1">
        <SourceCheckDot
          status={recordVerdictToStatus(verdict)}
          originalVerdict={verdict}
          size="md"
          href={getSourceCheckHref("prediction-question", String(q.id))}
        />
      </td>
    </tr>
  );
}

// ── Shared Components ────────────────────────────────────────────────

function ProbabilityBadge({ probability }: { probability: number }) {
  const pct = Math.round(probability * 100);
  // Color gradient: red (<30%) → yellow (30-70%) → green (>70%)
  const bgColor =
    pct < 30
      ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
      : pct > 70
        ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
        : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300";

  return (
    <span
      className={`inline-block text-xs font-semibold tabular-nums px-2 py-0.5 rounded-full ${bgColor}`}
    >
      {pct}%
    </span>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <p className="text-sm font-semibold mt-0.5">{value}</p>
    </div>
  );
}

// ── Overview Highlights ──────────────────────────────────────────────
// Compact widget for the Overview tab showing top prediction market questions.

/** Pick the most interesting questions to highlight on the Overview tab. */
function pickHighlights(
  questions: RpcPredictionQuestion[],
  maxCount = 6
): RpcPredictionQuestion[] {
  const active = questions.filter((q) => !q.isResolved && q.currentProbability != null);
  // Prioritize: high-category questions first, then by how "interesting" the probability is
  // (closer to 50% = more uncertain = more interesting)
  const scored = active.map((q) => {
    const p = q.currentProbability!;
    const interestingness = 1 - Math.abs(p - 0.5) * 2; // 0 at extremes, 1 at 50%
    const categoryBoost =
      q.category === "valuation" || q.category === "ipo" || q.category === "safety"
        ? 0.3
        : 0;
    return { q, score: interestingness + categoryBoost };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount).map((s) => s.q);
}

/**
 * Compact prediction market highlights for the Overview tab.
 * Shows top questions as a small table without full chrome.
 */
export function MarketHighlights({ data }: { data: MarketData }) {
  const questions = data.predictionQuestions?.questions ?? [];
  const active = questions.filter((q) => !q.isResolved);
  if (active.length === 0) return null;

  const highlights = pickHighlights(active);

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-sm font-bold tracking-tight">Prediction Markets</h3>
        <span className="text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
          {active.length} active
        </span>
      </div>
      <div className="grid gap-2">
        {highlights.map((q) => (
          <div
            key={q.id}
            className="flex items-center gap-3 py-1.5 px-2 rounded-lg border border-border/40 bg-card/50 hover:bg-muted/30 transition-colors"
          >
            <div className="flex-shrink-0 w-14 text-center">
              {q.currentProbability != null ? (
                <ProbabilityBadge probability={q.currentProbability} />
              ) : (
                <span className="text-xs text-muted-foreground">–</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              {q.questionUrl ? (
                <a
                  href={q.questionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs leading-snug text-foreground hover:text-primary transition-colors line-clamp-2"
                >
                  {q.questionText}
                </a>
              ) : (
                <span className="text-xs leading-snug line-clamp-2">
                  {q.questionText}
                </span>
              )}
            </div>
            <div className="flex-shrink-0 text-[10px] text-muted-foreground">
              {PLATFORM_LABELS[q.platform] ?? q.platform}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
