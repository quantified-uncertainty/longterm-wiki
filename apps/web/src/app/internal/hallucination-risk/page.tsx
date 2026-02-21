import { getAllPages } from "@/data";
import { HallucinationRiskDashboard } from "./hallucination-risk-dashboard";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hallucination Risk | Longterm Wiki Internal",
  description:
    "Hallucination risk scores for wiki pages — distribution, top risk factors, and per-page details.",
};

export interface RiskPageData {
  id: string;
  title: string;
  entityType: string | undefined;
  quality: number | null;
  wordCount: number | undefined;
  level: "low" | "medium" | "high";
  score: number;
  factors: string[];
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color || ""}`}>
        {value}
      </div>
    </div>
  );
}

export default function HallucinationRiskPage() {
  const pages = getAllPages();

  const riskPages: RiskPageData[] = pages
    .filter((p) => p.hallucinationRisk)
    .map((p) => ({
      id: p.id,
      title: p.title,
      entityType: p.entityType,
      quality: p.quality ?? null,
      wordCount: p.metrics?.wordCount,
      level: p.hallucinationRisk!.level,
      score: p.hallucinationRisk!.score,
      factors: p.hallucinationRisk!.factors,
    }));

  const highCount = riskPages.filter((p) => p.level === "high").length;
  const mediumCount = riskPages.filter((p) => p.level === "medium").length;
  const lowCount = riskPages.filter((p) => p.level === "low").length;
  const avgScore =
    riskPages.length > 0
      ? Math.round(
          riskPages.reduce((sum, p) => sum + p.score, 0) / riskPages.length
        )
      : 0;

  // Factor frequency across all pages
  const factorCounts: Record<string, number> = {};
  for (const p of riskPages) {
    for (const f of p.factors) {
      factorCounts[f] = (factorCounts[f] || 0) + 1;
    }
  }
  const topFactors = Object.entries(factorCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  return (
    <article className="prose max-w-none">
      <h1>Hallucination Risk</h1>
      <p className="text-muted-foreground">
        Risk scores computed from citation density, entity type, quality,
        content integrity, and other signals.{" "}
        <span className="font-medium text-foreground">
          {riskPages.length}
        </span>{" "}
        pages assessed.
        {highCount > 0 && (
          <span className="text-red-500 font-medium">
            {" "}
            {highCount} high-risk pages.
          </span>
        )}
      </p>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 not-prose mb-6">
        <StatCard label="Total Assessed" value={riskPages.length} />
        <StatCard
          label="High Risk"
          value={highCount}
          color={highCount > 0 ? "text-red-600" : ""}
        />
        <StatCard
          label="Medium Risk"
          value={mediumCount}
          color="text-amber-600"
        />
        <StatCard label="Low Risk" value={lowCount} color="text-emerald-600" />
        <StatCard label="Avg Score" value={avgScore} />
      </div>

      {/* Top risk factors */}
      {topFactors.length > 0 && (
        <div className="not-prose mb-6">
          <h3 className="text-sm font-semibold mb-3">
            Most Common Risk Factors
          </h3>
          <div className="flex gap-2 flex-wrap">
            {topFactors.map(([factor, count]) => (
              <span
                key={factor}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-muted text-muted-foreground"
              >
                {factor}
                <span className="tabular-nums font-semibold">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Level distribution bar */}
      {riskPages.length > 0 && (
        <div className="not-prose mb-6">
          <h3 className="text-sm font-semibold mb-2">Risk Distribution</h3>
          <div className="flex rounded-full overflow-hidden h-4">
            {highCount > 0 && (
              <div
                className="bg-red-500"
                style={{
                  width: `${(highCount / riskPages.length) * 100}%`,
                }}
                title={`High: ${highCount}`}
              />
            )}
            {mediumCount > 0 && (
              <div
                className="bg-amber-500"
                style={{
                  width: `${(mediumCount / riskPages.length) * 100}%`,
                }}
                title={`Medium: ${mediumCount}`}
              />
            )}
            {lowCount > 0 && (
              <div
                className="bg-emerald-500"
                style={{
                  width: `${(lowCount / riskPages.length) * 100}%`,
                }}
                title={`Low: ${lowCount}`}
              />
            )}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>
              High: {Math.round((highCount / riskPages.length) * 100)}%
            </span>
            <span>
              Medium: {Math.round((mediumCount / riskPages.length) * 100)}%
            </span>
            <span>
              Low: {Math.round((lowCount / riskPages.length) * 100)}%
            </span>
          </div>
        </div>
      )}

      {/* Interactive table */}
      <HallucinationRiskDashboard data={riskPages} />

      <p className="text-xs text-muted-foreground mt-4">
        Scores computed at build time by the canonical scorer (
        <code className="text-[11px]">crux/lib/hallucination-risk.ts</code>).
        Historical trends stored in PostgreSQL when wiki server is configured.
        Run{" "}
        <code className="text-[11px]">
          pnpm crux validate hallucination-risk
        </code>{" "}
        for a CLI report.
      </p>
    </article>
  );
}
