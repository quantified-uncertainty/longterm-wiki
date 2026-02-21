import fs from "fs";
import path from "path";
import { loadYaml } from "@lib/yaml";
import { CitationAccuracyDashboard } from "./citation-accuracy-dashboard";
import { VERDICT_COLORS } from "./verdict-colors";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Citation Accuracy | Longterm Wiki Internal",
  description:
    "Accuracy verification results for wiki citations: verdicts, flagged claims, and domain analysis.",
};

// Types matching the crux export format
export interface DashboardData {
  exportedAt: string;
  summary: {
    totalCitations: number;
    checkedCitations: number;
    accurateCitations: number;
    inaccurateCitations: number;
    unsupportedCitations: number;
    minorIssueCitations: number;
    uncheckedCitations: number;
    averageScore: number | null;
  };
  verdictDistribution: Record<string, number>;
  difficultyDistribution: Record<string, number>;
  pages: PageSummary[];
  flaggedCitations: FlaggedCitation[];
  domainAnalysis: DomainSummary[];
}

export interface PageSummary {
  pageId: string;
  totalCitations: number;
  checked: number;
  accurate: number;
  inaccurate: number;
  unsupported: number;
  minorIssues: number;
  accuracyRate: number | null;
  avgScore: number | null;
}

export interface FlaggedCitation {
  pageId: string;
  footnote: number;
  claimText: string;
  sourceTitle: string | null;
  url: string | null;
  verdict: string;
  score: number | null;
  issues: string | null;
  difficulty: string | null;
  checkedAt: string | null;
}

export interface DomainSummary {
  domain: string;
  totalCitations: number;
  checked: number;
  accurate: number;
  inaccurate: number;
  unsupported: number;
  inaccuracyRate: number | null;
}

/**
 * Try loading dashboard data from the wiki-server API (PostgreSQL source of truth).
 * Returns null if the server is unavailable or returns no data.
 */
async function loadDashboardDataFromApi(): Promise<DashboardData | null> {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) return null;

  try {
    const headers: Record<string, string> = {};
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${serverUrl}/api/citations/accuracy-dashboard`, {
      headers,
      next: { revalidate: 300 }, // Cache for 5 minutes
    });
    if (!res.ok) return null;

    return (await res.json()) as DashboardData;
  } catch {
    return null;
  }
}

/**
 * Load dashboard data from YAML files on disk (fallback for production builds).
 */
function loadDashboardDataFromYaml(): DashboardData | null {
  const baseDir = path.resolve(
    process.cwd(),
    "../../data/citation-accuracy"
  );

  // Try new split format first (summary.yaml + pages/*.yaml)
  const summaryPath = path.join(baseDir, "summary.yaml");
  if (fs.existsSync(summaryPath)) {
    try {
      const raw = fs.readFileSync(summaryPath, "utf-8");
      const summary = loadYaml<Omit<DashboardData, "flaggedCitations">>(raw);

      // Load per-page flagged citations
      const pagesDir = path.join(baseDir, "pages");
      const flaggedCitations: FlaggedCitation[] = [];
      if (fs.existsSync(pagesDir)) {
        for (const file of fs.readdirSync(pagesDir)) {
          if (!file.endsWith(".yaml")) continue;
          try {
            const pageRaw = fs.readFileSync(path.join(pagesDir, file), "utf-8");
            const pageCitations = loadYaml<FlaggedCitation[]>(pageRaw);
            if (Array.isArray(pageCitations)) {
              flaggedCitations.push(...pageCitations);
            }
          } catch { /* skip malformed files */ }
        }
      }
      // Sort by score (worst first), matching the old export order
      flaggedCitations.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

      return { ...summary, flaggedCitations };
    } catch {
      return null;
    }
  }

  // Fall back to old monolithic format
  const oldPath = path.join(baseDir, "dashboard.yaml");
  if (!fs.existsSync(oldPath)) return null;
  try {
    const raw = fs.readFileSync(oldPath, "utf-8");
    return loadYaml<DashboardData>(raw);
  } catch {
    return null;
  }
}

/**
 * Load dashboard data: tries wiki-server API first, falls back to YAML files.
 */
async function loadDashboardData(): Promise<DashboardData | null> {
  // Try API first (real-time data from PostgreSQL)
  const apiData = await loadDashboardDataFromApi();
  if (apiData) return apiData;

  // Fall back to YAML files on disk
  return loadDashboardDataFromYaml();
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

export default async function CitationAccuracyPage() {
  const data = await loadDashboardData();

  if (!data) {
    return (
      <article className="prose max-w-none">
        <h1>Citation Accuracy</h1>
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No accuracy data available</p>
          <p className="text-sm">
            Run the citation accuracy pipeline to generate data:
          </p>
          <ol className="text-sm text-left max-w-md mx-auto mt-4 space-y-2">
            <li>
              <code className="text-xs">
                pnpm crux citations extract-quotes --all
              </code>{" "}
              &mdash; extract supporting quotes from sources
            </li>
            <li>
              <code className="text-xs">
                pnpm crux citations check-accuracy --all
              </code>{" "}
              &mdash; verify claim accuracy against sources
            </li>
            <li>
              <code className="text-xs">
                pnpm crux citations export-dashboard
              </code>{" "}
              &mdash; export data for this dashboard
            </li>
          </ol>
        </div>
      </article>
    );
  }

  const { summary } = data;
  const accuracyPct =
    summary.checkedCitations > 0
      ? Math.round(
          ((summary.accurateCitations + summary.minorIssueCitations) /
            summary.checkedCitations) *
            100
        )
      : null;
  const problemCount =
    summary.inaccurateCitations + summary.unsupportedCitations;

  return (
    <article className="prose max-w-none">
      <h1>Citation Accuracy</h1>
      <p className="text-muted-foreground">
        Accuracy verification results from LLM-powered citation checking.{" "}
        <span className="font-medium text-foreground">
          {summary.checkedCitations}
        </span>{" "}
        of {summary.totalCitations} citations checked
        {accuracyPct !== null && (
          <>
            ,{" "}
            <span
              className={`font-medium ${accuracyPct >= 90 ? "text-emerald-600" : accuracyPct >= 75 ? "text-amber-600" : "text-red-600"}`}
            >
              {accuracyPct}% accurate
            </span>
          </>
        )}
        .
        {problemCount > 0 && (
          <span className="text-red-500 font-medium">
            {" "}
            {problemCount} citations flagged.
          </span>
        )}
      </p>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 not-prose mb-6">
        <StatCard label="Total Citations" value={summary.totalCitations} />
        <StatCard
          label="Checked"
          value={summary.checkedCitations}
          color="text-blue-600"
        />
        <StatCard
          label="Accurate"
          value={summary.accurateCitations}
          color="text-emerald-600"
        />
        <StatCard
          label="Flagged"
          value={problemCount}
          color={problemCount > 0 ? "text-red-600" : ""}
        />
      </div>

      {/* Verdict distribution */}
      {Object.keys(data.verdictDistribution).length > 0 && (
        <div className="not-prose mb-6">
          <h3 className="text-sm font-semibold mb-3">Verdict Distribution</h3>
          <div className="flex gap-2 flex-wrap">
            {Object.entries(data.verdictDistribution)
              .sort(([, a], [, b]) => b - a)
              .map(([verdict, count]) => (
                <VerdictBadge
                  key={verdict}
                  verdict={verdict}
                  count={count}
                />
              ))}
          </div>
        </div>
      )}

      {/* Difficulty distribution */}
      {Object.keys(data.difficultyDistribution).length > 0 && (
        <div className="not-prose mb-6">
          <h3 className="text-sm font-semibold mb-3">
            Verification Difficulty
          </h3>
          <div className="flex gap-2 flex-wrap">
            {Object.entries(data.difficultyDistribution)
              .sort(([, a], [, b]) => b - a)
              .map(([difficulty, count]) => (
                <span
                  key={difficulty}
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-muted text-muted-foreground"
                >
                  {difficulty}
                  <span className="tabular-nums font-semibold">{count}</span>
                </span>
              ))}
          </div>
        </div>
      )}

      {/* Interactive tables */}
      <CitationAccuracyDashboard
        pages={data.pages}
        flaggedCitations={data.flaggedCitations}
        domainAnalysis={data.domainAnalysis}
      />

      <p className="text-xs text-muted-foreground mt-4">
        Data exported{" "}
        {new Date(data.exportedAt).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })}
        . Regenerate with{" "}
        <code className="text-[11px]">pnpm crux citations export-dashboard</code>
      </p>
    </article>
  );
}

function VerdictBadge({
  verdict,
  count,
}: {
  verdict: string;
  count: number;
}) {
  const colorClass = VERDICT_COLORS[verdict] || "bg-muted text-muted-foreground";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${colorClass}`}
    >
      {verdict.replace(/_/g, " ")}
      <span className="tabular-nums font-semibold">{count}</span>
    </span>
  );
}
