"use client";

import { GITHUB_REPO_URL } from "@lib/site-config";
import { classifyPR, type PullData, type PRStats, type KanbanColumn } from "./pr-dashboard-shared";

// ── Column Config ───────────────────────────────────────────────────────

const COLUMN_CONFIG: Array<{
  key: KanbanColumn;
  title: string;
  emptyText: string;
  headerColor: string;
}> = [
  {
    key: "draft",
    title: "Draft",
    emptyText: "No draft PRs",
    headerColor: "text-muted-foreground",
  },
  {
    key: "ci-issues",
    title: "CI Running / Failing",
    emptyText: "All CI checks passing",
    headerColor: "text-yellow-600",
  },
  {
    key: "needs-review",
    title: "Needs Review",
    emptyText: "No PRs awaiting review",
    headerColor: "text-blue-600",
  },
  {
    key: "approved",
    title: "Approved",
    emptyText: "No approved PRs",
    headerColor: "text-green-600",
  },
];

// ── CI Status Badge ────────────────────────────────────────────────────
// TODO: extract CiStatusBadge, MergeStatusBadge, and their style objects
// to shared pr-badges.tsx (also used by system-health/open-prs-table.tsx)

const CI_STYLES: Record<string, { cls: string; label: string }> = {
  success: { cls: "bg-green-500/15 text-green-600", label: "passing" },
  failure: { cls: "bg-red-500/15 text-red-500", label: "failing" },
  pending: { cls: "bg-yellow-500/15 text-yellow-600", label: "building" },
  error: { cls: "bg-red-500/15 text-red-500", label: "error" },
  unknown: { cls: "bg-muted text-muted-foreground", label: "unknown" },
};

function CiStatusBadge({ status }: { status: string }) {
  const style = CI_STYLES[status] ?? CI_STYLES.unknown;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.cls}`}
    >
      {style.label}
    </span>
  );
}

// ── Merge Status Badge ─────────────────────────────────────────────────

const MERGE_STYLES: Record<string, { cls: string; label: string }> = {
  mergeable: { cls: "bg-green-500/15 text-green-600", label: "clean" },
  conflicting: { cls: "bg-red-500/15 text-red-500", label: "conflicts" },
  unknown: { cls: "bg-muted text-muted-foreground", label: "pending" },
};

function MergeStatusBadge({ status }: { status: string }) {
  const style = MERGE_STYLES[status] ?? MERGE_STYLES.unknown;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.cls}`}
    >
      {style.label}
    </span>
  );
}

// ── Label Pill ─────────────────────────────────────────────────────────

function LabelPill({ name }: { name: string }) {
  const isBlock = name.startsWith("block:");
  const isWarning =
    name.startsWith("needs:") || name.startsWith("waiting:");
  const cls = isBlock
    ? "bg-red-500/15 text-red-600"
    : isWarning
      ? "bg-orange-500/15 text-orange-600"
      : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {name}
    </span>
  );
}

// ── Relative Time ──────────────────────────────────────────────────────

function relativeTime(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const hoursAgo = Math.round((now - then) / 3600000);

  if (hoursAgo < 1) return "<1h ago";
  if (hoursAgo < 24) return `${hoursAgo}h ago`;
  return `${Math.round(hoursAgo / 24)}d ago`;
}

// ── PR Card ────────────────────────────────────────────────────────────

function PRCard({ pr }: { pr: PullData }) {
  // Filter labels that are purely workflow/stage markers from display
  const displayLabels = pr.labels.filter(
    (l) =>
      l !== "stage:approved" &&
      l !== "ready-to-merge" &&
      l !== "claude-working" &&
      l !== "filed-by-agent"
  );

  return (
    <div className="rounded-lg border border-border/60 bg-background p-3 shadow-sm">
      {/* Header: PR number + author */}
      <div className="flex items-center justify-between mb-1">
        <a
          href={`${GITHUB_REPO_URL}/pull/${pr.number}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline tabular-nums font-medium"
        >
          #{pr.number}
        </a>
        <span className="text-[11px] text-muted-foreground">{pr.author}</span>
      </div>

      {/* Title */}
      <a
        href={`${GITHUB_REPO_URL}/pull/${pr.number}`}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-sm leading-snug mb-2 truncate hover:underline"
        title={pr.title}
      >
        {pr.title}
      </a>

      {/* Badges row */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <CiStatusBadge status={pr.ciStatus} />
        <MergeStatusBadge status={pr.mergeable} />
        {pr.unresolvedThreads > 0 && (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-purple-500/15 text-purple-600">
            {pr.unresolvedThreads} thread{pr.unresolvedThreads !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Labels */}
      {displayLabels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {displayLabels.map((label) => (
            <LabelPill key={label} name={label} />
          ))}
        </div>
      )}

      {/* Footer: size + age */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          <span className="text-green-600">+{pr.additions}</span>
          {" / "}
          <span className="text-red-500">-{pr.deletions}</span>
        </span>
        <span className="tabular-nums" suppressHydrationWarning>
          {relativeTime(pr.createdAt)}
        </span>
      </div>
    </div>
  );
}

// ── Column ─────────────────────────────────────────────────────────────

function KanbanColumnComponent({
  title,
  headerColor,
  emptyText,
  pulls,
}: {
  title: string;
  headerColor: string;
  emptyText: string;
  pulls: PullData[];
}) {
  return (
    <div className="flex flex-col min-w-[260px]">
      {/* Column header */}
      <div className="flex items-center gap-2 mb-3">
        <h3 className={`text-sm font-semibold ${headerColor}`}>{title}</h3>
        <span className="inline-flex items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground min-w-[20px]">
          {pulls.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-2">
        {pulls.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          pulls.map((pr) => <PRCard key={pr.number} pr={pr} />)
        )}
      </div>
    </div>
  );
}

// ── Stats Bar ──────────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: PRStats }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground mb-6">
      <span>
        Open PRs:{" "}
        <span className="font-semibold text-foreground">{stats.total}</span>
      </span>
      <span>
        Draft:{" "}
        <span className="font-semibold text-foreground">{stats.draft}</span>
      </span>
      <span>
        CI Failing:{" "}
        <span
          className={`font-semibold ${stats.ciFailing > 0 ? "text-red-500" : "text-foreground"}`}
        >
          {stats.ciFailing}
        </span>
      </span>
      <span>
        Needs Review:{" "}
        <span
          className={`font-semibold ${stats.needsReview > 0 ? "text-blue-600" : "text-foreground"}`}
        >
          {stats.needsReview}
        </span>
      </span>
      <span>
        Conflicting:{" "}
        <span
          className={`font-semibold ${stats.conflicting > 0 ? "text-red-500" : "text-foreground"}`}
        >
          {stats.conflicting}
        </span>
      </span>
    </div>
  );
}

// ── Board ──────────────────────────────────────────────────────────────

export function PRDashboardBoard({
  pulls,
  stats,
}: {
  pulls: PullData[];
  stats: PRStats;
}) {
  // Classify PRs into columns
  const columns: Record<KanbanColumn, PullData[]> = {
    draft: [],
    "ci-issues": [],
    "needs-review": [],
    approved: [],
  };

  for (const pr of pulls) {
    const col = classifyPR(pr);
    columns[col].push(pr);
  }

  // Sort each column: most recently updated first
  for (const col of Object.values(columns)) {
    col.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  if (pulls.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
        <p className="text-lg font-medium mb-2">No open pull requests</p>
        <p className="text-sm">
          Open PRs will appear here when agents or contributors create them.
        </p>
      </div>
    );
  }

  return (
    <>
      <StatsBar stats={stats} />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {COLUMN_CONFIG.map((cfg) => (
          <KanbanColumnComponent
            key={cfg.key}
            title={cfg.title}
            headerColor={cfg.headerColor}
            emptyText={cfg.emptyText}
            pulls={columns[cfg.key]}
          />
        ))}
      </div>
    </>
  );
}
