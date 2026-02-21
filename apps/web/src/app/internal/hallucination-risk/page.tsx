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

// ── API types ────────────────────────────────────────────────────────────────

interface ApiRiskPage {
  pageId: string;
  score: number;
  level: "low" | "medium" | "high";
  factors: string[] | null;
  integrityIssues: string[] | null;
  computedAt: string;
}

// ── Data loading ─────────────────────────────────────────────────────────────

/**
 * Load hallucination risk data from the wiki-server API.
 * Paginates through all results since the API has a max page size of 200.
 * Returns null if the server is unavailable.
 */
async function loadRiskDataFromApi(): Promise<RiskPageData[] | null> {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) return null;

  try {
    const headers: Record<string, string> = {};
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    // Paginate to fetch all risk scores (guard against infinite loop)
    const allApiPages: ApiRiskPage[] = [];
    let offset = 0;
    const pageSize = 200;
    const maxPages = 20; // Safety limit: 20 × 200 = 4000 pages max

    for (let page = 0; page < maxPages; page++) {
      const res = await fetch(
        `${serverUrl}/api/hallucination-risk/latest?limit=${pageSize}&offset=${offset}`,
        { headers, next: { revalidate: 300 } }
      );
      if (!res.ok) return null;

      const data = (await res.json()) as { pages: ApiRiskPage[] };
      allApiPages.push(...data.pages);

      if (data.pages.length < pageSize) break;
      offset += pageSize;
    }

    if (allApiPages.length === 0) return null;

    // Build page metadata lookup from local database.json
    const pages = getAllPages();
    const pageMap = new Map(
      pages.map((p) => [
        p.id,
        {
          title: p.title,
          entityType: p.entityType,
          quality: p.quality ?? null,
          wordCount: p.metrics?.wordCount,
        },
      ])
    );

    return allApiPages.map((r) => {
      const meta = pageMap.get(r.pageId);
      return {
        id: r.pageId,
        title: meta?.title || r.pageId,
        entityType: meta?.entityType,
        quality: meta?.quality ?? null,
        wordCount: meta?.wordCount,
        level: r.level,
        score: r.score,
        factors: r.factors || [],
      };
    });
  } catch {
    return null;
  }
}

/**
 * Load hallucination risk data from local database.json (fallback).
 */
function loadRiskDataFromDatabase(): RiskPageData[] {
  const pages = getAllPages();
  return pages
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

export default async function HallucinationRiskPage() {
  // Try wiki-server API first, fall back to database.json
  const apiData = await loadRiskDataFromApi();
  const riskPages = apiData ?? loadRiskDataFromDatabase();
  const dataSource = apiData ? "wiki-server" : "local fallback";

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
        Data source: {dataSource}.{" "}
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
