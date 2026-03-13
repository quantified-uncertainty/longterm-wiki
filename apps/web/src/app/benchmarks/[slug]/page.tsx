import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  resolveBenchmarkBySlug,
  getBenchmarkSlugs,
  getBenchmarkResultsFromModels,
} from "../benchmark-utils";

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

export default async function BenchmarkDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveBenchmarkBySlug(slug);
  if (!entity) return notFound();

  const allResults = getBenchmarkResultsFromModels();
  const results = allResults.get(entity.id) ?? [];

  // Sort by score (higher is better by default)
  const sorted = [...results].sort((a, b) =>
    entity.higherIsBetter ? b.score - a.score : a.score - b.score,
  );

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

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1.5 text-xs text-muted-foreground mb-6">
        <Link href="/benchmarks" className="hover:text-foreground transition-colors">
          Benchmarks
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium">{entity.title}</span>
      </nav>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl font-extrabold tracking-tight">
            {entity.title}
          </h1>
          {entity.category && (
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
                CATEGORY_COLORS[entity.category] ?? "bg-gray-100 text-gray-600"
              }`}
            >
              {entity.category.charAt(0).toUpperCase() + entity.category.slice(1)}
            </span>
          )}
        </div>
        {entity.description && (
          <p className="text-muted-foreground text-sm max-w-3xl leading-relaxed">
            {entity.description}
          </p>
        )}
        <div className="flex items-center gap-4 mt-3 text-sm">
          {entity.numericId && (
            <Link
              href={`/wiki/${entity.numericId}`}
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Wiki page &rarr;
            </Link>
          )}
          {entity.website && (
            <a
              href={entity.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Website &rarr;
            </a>
          )}
        </div>
      </div>

      {/* Stat cards */}
      {stats.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4"
            >
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
                {stat.label}
              </div>
              <div className="text-2xl font-bold tabular-nums tracking-tight">
                {stat.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Details */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8 text-sm">
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
            Leaderboard
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {sorted.length} models
            </span>
          </h2>
          <div className="border border-border rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="py-2.5 px-3 text-center w-12">#</th>
                  <th className="py-2.5 px-3 text-left font-medium">Model</th>
                  <th className="py-2.5 px-3 text-left font-medium">Developer</th>
                  <th className="py-2.5 px-3 text-right font-medium">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {sorted.map((row, i) => (
                  <tr
                    key={row.modelId}
                    className={`hover:bg-muted/20 transition-colors ${
                      i < 3 ? "font-medium" : ""
                    }`}
                  >
                    <td className="py-2.5 px-3 text-center text-muted-foreground tabular-nums">
                      {i === 0 ? (
                        <span className="text-amber-500" title="1st place">
                          {"\uD83E\uDD47"}
                        </span>
                      ) : i === 1 ? (
                        <span className="text-gray-400" title="2nd place">
                          {"\uD83E\uDD48"}
                        </span>
                      ) : i === 2 ? (
                        <span className="text-orange-400" title="3rd place">
                          {"\uD83E\uDD49"}
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
                    <td className="py-2.5 px-3 text-right tabular-nums">
                      <span className={i < 3 ? "font-bold" : "font-semibold"}>
                        {formatScore(row.score, row.unit)}
                      </span>
                    </td>
                  </tr>
                ))}
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
  );
}

function formatScore(score: number, unit?: string): string {
  if (unit === "%" || unit === "percentage" || unit === "accuracy") {
    return `${score}%`;
  }
  return String(score);
}
