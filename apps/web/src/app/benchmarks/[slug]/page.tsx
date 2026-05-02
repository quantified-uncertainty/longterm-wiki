import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  resolveBenchmarkBySlug,
  getBenchmarkSlugs,
  getBenchmarkResultsFromModels,
  formatTestedBy,
  formatEvaluationDate,
} from "../benchmark-utils";
import { resolveSlugAlias } from "@/data/factbase";
import { ProfileStatCard } from "@/components/directory";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import {
  fetchEntitySourcingSummary,
  rollupVerdictFromSummary,
} from "@/components/entity/entity-sourcing";
import {
  computeBenchmarkCoverage,
  getBenchmarkSignals,
} from "@/components/coverage/coverage-score";

export function generateStaticParams() {
  return getBenchmarkSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolveBenchmarkBySlug(slug);
  return {
    title: entity ? `${entity.title} | AI Benchmarks` : "Benchmark Not Found",
    description: entity?.description ?? undefined,
  };
}

const CATEGORY_COLORS: Record<string, string> = {
  coding: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  reasoning: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  math: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  knowledge: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  multimodal: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
  safety: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  agentic: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  general: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
};

const DEVELOPER_COLORS: Record<string, string> = {
  anthropic: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  openai: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  deepmind: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "meta-ai": "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  "mistral-ai": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  xai: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  deepseek: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

const DEVELOPER_BAR_COLORS: Record<string, string> = {
  anthropic: "bg-amber-400/40 dark:bg-amber-500/30",
  openai: "bg-green-400/40 dark:bg-green-500/30",
  deepmind: "bg-blue-400/40 dark:bg-blue-500/30",
  "meta-ai": "bg-indigo-400/40 dark:bg-indigo-500/30",
  "mistral-ai": "bg-orange-400/40 dark:bg-orange-500/30",
  xai: "bg-slate-400/40 dark:bg-slate-500/30",
  deepseek: "bg-cyan-400/40 dark:bg-cyan-500/30",
};

export default async function BenchmarkDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveBenchmarkBySlug(slug);
  if (!entity) {
    const canonical = resolveSlugAlias(slug);
    if (canonical) permanentRedirect(`/benchmarks/${canonical}`);
    return notFound();
  }

  const allResults = getBenchmarkResultsFromModels();
  const results = allResults.get(entity.id) ?? [];

  // Sort by score (higher is better by default)
  const sorted = [...results].sort((a, b) =>
    entity.higherIsBetter ? b.score - a.score : a.score - b.score,
  );

  // Skip the provenance columns entirely when no row has populated provenance —
  // every wide screen is needed for the score bars, and 2 perpetually-empty
  // columns just add visual noise. Re-enabled per-row as ingesters start
  // supplying real data. Today (2026-05-02) every prod row has tested_by=unknown
  // and the PG→leaderboard merge silently drops every PG-sourced row anyway
  // (QUA-1061), so this branch is dormant until both land.
  const hasProvenance = sorted.some(
    (r) =>
      (r.testedBy && r.testedBy !== "unknown") ||
      r.testedByOrgId ||
      r.evaluationDate ||
      r.methodologyNotes,
  );

  // Compute score range for bar widths.
  // For percentage-like benchmarks (accuracy, percentage, pass_at_1), scores are 0-100
  // and relative comparison between dataset min/max works well.
  // For Elo/points benchmarks (e.g., Codeforces Rating 0-3500, Chatbot Arena Elo),
  // anchor bars at 0 so bar width reflects absolute score magnitude — otherwise a
  // score of 1759 out of 3500 could render at ~15% width instead of ~50%.
  const allScores = sorted.map((r) => r.score);
  const isAbsoluteScale =
    entity.scoringMethod === "elo" || entity.scoringMethod === "points";
  const minScore = isAbsoluteScale
    ? 0
    : allScores.length > 0
      ? Math.min(...allScores)
      : 0;
  const maxScore = allScores.length > 0 ? Math.max(...allScores) : 1;

  // Compute stats
  const modelCount = sorted.length;
  const bestScore = sorted.length > 0 ? sorted[0].score : null;
  const scores = sorted.map((r) => r.score);
  const medianScore =
    scores.length > 0
      ? scores.length % 2 === 0
        ? (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
        : scores[Math.floor(scores.length / 2)]
      : null;

  const stats = [
    { label: "Models Tested", value: String(modelCount) },
    ...(bestScore !== null
      ? [
          {
            label: entity.higherIsBetter ? "Best Score" : "Lowest Score",
            value: formatScore(bestScore, sorted[0]?.unit),
          },
        ]
      : []),
    ...(medianScore !== null
      ? [{ label: "Median Score", value: formatScore(medianScore, sorted[0]?.unit) }]
      : []),
  ];

  // Sourcing rollup verdict
  const sourcingSummary = await fetchEntitySourcingSummary([
    entity.id,
    entity.stableId ?? "",
    slug,
  ]);
  const rollupVerdict = rollupVerdictFromSummary(sourcingSummary);

  const coverageInput = {
    category: entity.category,
    scoringMethod: entity.scoringMethod,
    introducedDate: entity.introducedDate,
    maintainer: entity.maintainer,
    description: entity.description,
    modelsCount: modelCount,
    wikiId: entity.wikiId,
  };
  const coverageScore = computeBenchmarkCoverage(coverageInput);
  const coverageSignals = getBenchmarkSignals(coverageInput);

  const titlePills = entity.category ? (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
        CATEGORY_COLORS[entity.category] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {entity.category.charAt(0).toUpperCase() + entity.category.slice(1)}
    </span>
  ) : null;

  const headerLinks = [
    ...(entity.wikiId
      ? [{ label: "Wiki page", href: `/wiki/${entity.wikiId}` }]
      : []),
    ...(entity.website
      ? [{ label: "Website", href: entity.website, external: true }]
      : []),
    { label: "Data", href: `/benchmarks/${slug}/data` },
  ];

  const statCards = stats.length > 0 && (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {stats.map((stat) => (
        <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
      ))}
    </div>
  );

  return (
    <EntityProfileShell
      breadcrumbs={[
        { label: "Benchmarks", href: "/benchmarks" },
        { label: entity.title },
      ]}
      entityId={entity.id}
      title={entity.title}
      titlePills={titlePills}
      coverage={{ score: coverageScore, signals: coverageSignals }}
      verdict={rollupVerdict}
      subtitle={entity.description || undefined}
      headerLinks={headerLinks}
      statCards={statCards}
    >
      <div className="space-y-8">
        {/* Details */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          {entity.scoringMethod && (
            <div className="px-4 py-3 rounded-lg border border-border/60 bg-card">
              <span className="text-muted-foreground">Scoring: </span>
              <span className="font-medium">{entity.scoringMethod}</span>
            </div>
          )}
          {entity.introducedDate && (
            <div className="px-4 py-3 rounded-lg border border-border/60 bg-card">
              <span className="text-muted-foreground">Introduced: </span>
              <span className="font-medium">{entity.introducedDate}</span>
            </div>
          )}
          {entity.maintainer && (
            <div className="px-4 py-3 rounded-lg border border-border/60 bg-card">
              <span className="text-muted-foreground">Maintainer: </span>
              <span className="font-medium">{entity.maintainer}</span>
            </div>
          )}
        </div>

        {/* Leaderboard */}
        {sorted.length > 0 ? (
          <section>
            <h2 className="text-lg font-bold tracking-tight mb-4">
              Leaderboard{" "}
              <span className="text-sm font-normal text-muted-foreground">
                ({sorted.length} {sorted.length === 1 ? "model" : "models"})
              </span>
            </h2>
            <div className="border border-border rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                    <th className="py-2.5 px-3 text-center w-12">#</th>
                    <th className="py-2.5 px-3 text-left font-medium">Model</th>
                    <th className="py-2.5 px-3 text-left font-medium">Developer</th>
                    <th
                      className={`py-2.5 px-3 text-left font-medium ${
                        hasProvenance ? "w-[28%]" : "w-[40%]"
                      }`}
                    >
                      Score
                    </th>
                    {hasProvenance && (
                      <>
                        <th className="py-2.5 px-3 text-left font-medium">
                          Tested by
                        </th>
                        <th className="py-2.5 px-3 text-left font-medium whitespace-nowrap">
                          Eval date
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {sorted.map((row, i) => {
                    // Bar width: normalize score relative to range, with min bar at 15%
                    // For lower-is-better benchmarks, invert so lower scores get wider bars
                    const rawNormalized =
                      maxScore > minScore
                        ? (row.score - minScore) / (maxScore - minScore)
                        : 0.5;
                    const adjusted = entity.higherIsBetter ? rawNormalized : 1 - rawNormalized;
                    const barPct = 15 + adjusted * 85;
                    const barColor =
                      DEVELOPER_BAR_COLORS[row.developer ?? ""] ??
                      "bg-primary/20 dark:bg-primary/15";

                    return (
                      <tr
                        key={row.modelId}
                        className={`hover:bg-muted/20 transition-colors ${
                          i < 3 ? "font-medium" : ""
                        }`}
                      >
                        <td className="py-2.5 px-3 text-center text-muted-foreground tabular-nums">
                          {i === 0 ? (
                            <span className="text-amber-500" title="1st place">
                              {"🥇"}
                            </span>
                          ) : i === 1 ? (
                            <span className="text-gray-400" title="2nd place">
                              {"🥈"}
                            </span>
                          ) : i === 2 ? (
                            <span className="text-orange-400" title="3rd place">
                              {"🥉"}
                            </span>
                          ) : (
                            i + 1
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          <Link
                            href={`/ai-models/${row.modelId}`}
                            className="hover:text-primary transition-colors"
                          >
                            {row.modelTitle}
                          </Link>
                        </td>
                        <td className="py-2.5 px-3">
                          {row.developer && row.developerName && (
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                DEVELOPER_COLORS[row.developer] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                              }`}
                            >
                              {row.developerName}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 relative h-5 rounded-md bg-muted/30 overflow-hidden">
                              <div
                                className={`absolute inset-y-0 left-0 rounded-md ${barColor} transition-all`}
                                style={{ width: `${barPct}%` }}
                              />
                              <span
                                className={`absolute inset-y-0 flex items-center px-2 text-xs tabular-nums ${
                                  i < 3 ? "font-bold" : "font-semibold"
                                }`}
                              >
                                {formatScore(row.score, row.unit)}
                              </span>
                            </div>
                          </div>
                        </td>
                        {hasProvenance && (
                          <>
                            <td className="py-2.5 px-3">
                              <TestedByCell
                                testedBy={row.testedBy ?? null}
                                testedByOrgId={row.testedByOrgId ?? null}
                                testedByOrgName={row.testedByOrgName ?? null}
                                methodologyNotes={row.methodologyNotes ?? null}
                              />
                            </td>
                            <td className="py-2.5 px-3 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                              {formatEvaluationDate(row.evaluationDate)}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <div className="text-center py-12 text-muted-foreground border border-border/60 rounded-xl bg-card">
            No model scores recorded for this benchmark yet.
          </div>
        )}
      </div>
    </EntityProfileShell>
  );
}

function formatScore(score: number, unit?: string): string {
  // Round to 2 decimal places to avoid IEEE 754 floating-point artifacts
  // (e.g., 89.30000000000001 → 89.3)
  const rounded = Number(score.toFixed(2));
  if (unit === "%" || unit === "percentage" || unit === "accuracy") {
    return `${parseFloat(score.toFixed(2))}%`;
  }
  return String(rounded);
}

function TestedByCell({
  testedBy,
  testedByOrgId,
  testedByOrgName,
  methodologyNotes,
}: {
  testedBy: string | null;
  testedByOrgId: string | null;
  testedByOrgName: string | null;
  methodologyNotes: string | null;
}) {
  // "unknown" / null collapse to em-dash so the column visually opts out
  // for rows that don't have provenance, even when the table is showing it
  // for siblings that do.
  const showChip = testedBy && testedBy !== "unknown";
  const label = showChip
    ? testedByOrgName ?? formatTestedBy(testedBy)
    : null;

  return (
    <div className="flex items-center gap-1.5">
      {label ? (
        testedByOrgId ? (
          <Link
            href={`/organizations/${testedByOrgId}`}
            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            title={`Tested by ${label}`}
          >
            {label}
          </Link>
        ) : (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            title={`Tested by ${label}`}
          >
            {label}
          </span>
        )
      ) : (
        <span className="text-xs text-muted-foreground/60">—</span>
      )}
      {methodologyNotes && (
        <details className="relative inline-block">
          <summary
            className="cursor-pointer list-none text-muted-foreground hover:text-foreground transition-colors text-xs select-none"
            title="Show methodology notes"
            aria-label="Show methodology notes"
          >
            ⓘ
          </summary>
          <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded-md border border-border bg-card p-3 text-xs text-card-foreground shadow-md">
            <div className="font-semibold mb-1 text-muted-foreground">
              Methodology
            </div>
            <p className="whitespace-pre-wrap break-words">{methodologyNotes}</p>
          </div>
        </details>
      )}
    </div>
  );
}
