import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { getAllPages } from "@/data";
import { ReviewsDashboard } from "./reviews-dashboard";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Human Reviews | Longterm Wiki Internal",
  description:
    "Human review tracking — coverage, staleness alerts, and unreviewed high-risk pages.",
};

// ---------------------------------------------------------------------------
// Data types (mirroring crux/lib/review-tracking.ts)
// ---------------------------------------------------------------------------

interface ReviewEntry {
  date: string;
  reviewer: string;
  scope?: string;
  note?: string;
}

export interface ReviewedPageRow {
  pageId: string;
  title: string;
  entityType: string | undefined;
  reviewer: string;
  date: string;
  scope: string | undefined;
  note: string | undefined;
  reviewCount: number;
  daysSinceReview: number;
  stale: boolean;
}

export interface UnreviewedHighRiskRow {
  pageId: string;
  title: string;
  entityType: string | undefined;
  riskLevel: "low" | "medium" | "high";
  riskScore: number;
}

export interface ReviewerStat {
  reviewer: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

const REVIEWS_DIR = path.resolve(process.cwd(), "../../data/reviews");

function loadReviewFiles(): Map<string, ReviewEntry[]> {
  const map = new Map<string, ReviewEntry[]>();
  if (!fs.existsSync(REVIEWS_DIR)) return map;

  try {
    const files = fs.readdirSync(REVIEWS_DIR).filter((f) => f.endsWith(".yaml"));
    for (const file of files) {
      const pageId = file.replace(/\.yaml$/, "");
      try {
        const raw = fs.readFileSync(path.join(REVIEWS_DIR, file), "utf-8");
        const parsed = parseYaml(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          map.set(pageId, parsed as ReviewEntry[]);
        }
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // Reviews dir not readable
  }

  return map;
}

function daysSince(dateStr: string): number {
  const today = new Date();
  const reviewed = new Date(dateStr);
  return Math.floor((today.getTime() - reviewed.getTime()) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Stat card component (server-rendered)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function ReviewsPage() {
  const allPages = getAllPages();
  const reviewFiles = loadReviewFiles();

  // Build reviewed pages table
  const reviewedRows: ReviewedPageRow[] = [];
  for (const [pageId, entries] of reviewFiles) {
    const page = allPages.find((p) => p.id === pageId);
    const last = entries[entries.length - 1];
    const days = daysSince(last.date);
    reviewedRows.push({
      pageId,
      title: page?.title || pageId,
      entityType: page?.entityType,
      reviewer: last.reviewer,
      date: last.date,
      scope: last.scope,
      note: last.note,
      reviewCount: entries.length,
      daysSinceReview: days,
      stale: days > 90,
    });
  }

  // Sort by most recent first
  reviewedRows.sort((a, b) => b.date.localeCompare(a.date));

  // Unreviewed high-risk pages
  const reviewedIds = new Set(reviewFiles.keys());
  const unreviewedHighRisk: UnreviewedHighRiskRow[] = allPages
    .filter(
      (p) =>
        !reviewedIds.has(p.id) &&
        p.hallucinationRisk &&
        (p.hallucinationRisk.level === "high" || p.hallucinationRisk.level === "medium")
    )
    .map((p) => ({
      pageId: p.id,
      title: p.title,
      entityType: p.entityType,
      riskLevel: p.hallucinationRisk!.level,
      riskScore: p.hallucinationRisk!.score,
    }))
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 50); // Show top 50 unreviewed high-risk pages

  // By-reviewer breakdown
  const reviewerMap = new Map<string, number>();
  for (const [, entries] of reviewFiles) {
    for (const e of entries) {
      reviewerMap.set(e.reviewer, (reviewerMap.get(e.reviewer) || 0) + 1);
    }
  }
  const reviewerStats: ReviewerStat[] = [...reviewerMap.entries()]
    .map(([reviewer, count]) => ({ reviewer, count }))
    .sort((a, b) => b.count - a.count);

  // Summary stats
  const totalPages = allPages.length;
  const reviewedCount = reviewedRows.length;
  const staleCount = reviewedRows.filter((r) => r.stale).length;
  const coveragePct =
    totalPages > 0 ? Math.round((reviewedCount / totalPages) * 100) : 0;

  return (
    <article className="prose max-w-none">
      <h1>Human Review Tracking</h1>
      <p className="text-muted-foreground">
        Pages manually reviewed by humans to verify accuracy. Use{" "}
        <code className="text-[11px]">pnpm crux review mark &lt;page-id&gt; --reviewer=&quot;name&quot;</code>{" "}
        to mark a page as reviewed.
      </p>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 not-prose mb-6">
        <StatCard label="Total Pages" value={totalPages} />
        <StatCard
          label="Reviewed"
          value={`${reviewedCount} (${coveragePct}%)`}
          color="text-emerald-600"
        />
        <StatCard
          label="Unreviewed"
          value={totalPages - reviewedCount}
          color={totalPages - reviewedCount > 0 ? "text-amber-600" : ""}
        />
        <StatCard
          label="Stale (>90 days)"
          value={staleCount}
          color={staleCount > 0 ? "text-red-600" : ""}
        />
      </div>

      {/* By-reviewer breakdown */}
      {reviewerStats.length > 0 && (
        <div className="not-prose mb-6">
          <h3 className="text-sm font-semibold mb-3">Reviews by Reviewer</h3>
          <div className="flex gap-2 flex-wrap">
            {reviewerStats.map(({ reviewer, count }) => (
              <span
                key={reviewer}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-muted text-muted-foreground"
              >
                {reviewer}
                <span className="tabular-nums font-semibold">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Interactive tables */}
      <ReviewsDashboard
        reviewedRows={reviewedRows}
        unreviewedHighRisk={unreviewedHighRisk}
      />

      <p className="text-xs text-muted-foreground mt-4">
        Review records stored in{" "}
        <code className="text-[11px]">data/reviews/&lt;page-id&gt;.yaml</code>.
        Staleness threshold: 90 days. Run{" "}
        <code className="text-[11px]">pnpm crux review list</code> for a CLI
        report.
      </p>
    </article>
  );
}
