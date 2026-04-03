"use client";

import { useState } from "react";
import { GITHUB_REPO_URL } from "@lib/site-config";
import {
  classifyPR,
  type PullData,
  type PRStats,
  type KanbanColumn,
  type CheckResult,
  type ActionNeeded,
} from "./pr-dashboard-shared";

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
// TODO #3533: extract CiStatusBadge, MergeStatusBadge, and their style objects
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

// ── ActionNeeded Helpers ───────────────────────────────────────────────

const ACTION_BORDER_COLORS: Record<ActionNeeded, string> = {
  ready: "border-l-green-500",
  building: "border-l-yellow-500",
  "code-fix": "border-l-red-500",
  rebase: "border-l-orange-500",
  "human-label": "border-l-purple-500",
  "comment-response": "border-l-blue-500",
};

const ACTION_LABELS: Record<ActionNeeded, string> = {
  ready: "ready",
  building: "building",
  "code-fix": "needs code fix",
  rebase: "needs rebase",
  "human-label": "needs label",
  "comment-response": "needs response",
};

const ACTION_LABEL_STYLES: Record<ActionNeeded, string> = {
  ready: "text-green-600",
  building: "text-yellow-600",
  "code-fix": "text-red-500",
  rebase: "text-orange-600",
  "human-label": "text-purple-600",
  "comment-response": "text-blue-600",
};

function ActionNeededLabel({ action }: { action: ActionNeeded }) {
  return (
    <span
      className={`text-[10px] font-medium ${ACTION_LABEL_STYLES[action]}`}
    >
      {ACTION_LABELS[action]}
    </span>
  );
}

// ── CI / Gates Split Badges ───────────────────────────────────────────

function summarizeCheckGroup(
  checks: CheckResult[],
): "success" | "failure" | "pending" | "unknown" {
  if (checks.length === 0) return "unknown";
  if (checks.some((c) => c.status === "failure")) return "failure";
  if (checks.some((c) => c.status === "pending")) return "pending";
  if (checks.every((c) => c.status === "success" || c.status === "neutral"))
    return "success";
  return "unknown";
}

function CiGatesBadges({ checks }: { checks: CheckResult[] }) {
  const ciChecks = checks.filter((c) => !c.isGateCheck);
  const gateChecks = checks.filter((c) => c.isGateCheck);

  const ciStatus = summarizeCheckGroup(ciChecks);
  const gateStatus = summarizeCheckGroup(gateChecks);

  const ciStyle = CI_STYLES[ciStatus] ?? CI_STYLES.unknown;
  const gateStyle = CI_STYLES[gateStatus] ?? CI_STYLES.unknown;

  return (
    <>
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${ciStyle.cls}`}
      >
        CI {ciStyle.label}
      </span>
      {gateChecks.length > 0 && (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${gateStyle.cls}`}
        >
          Gates {gateStyle.label}
        </span>
      )}
    </>
  );
}

// ── CodeRabbit Badge ──────────────────────────────────────────────────

function CodeRabbitBadge({
  findings,
}: {
  findings: { critical: number; major: number; minor: number; total: number };
}) {
  if (findings.total === 0) return null;

  // Pick the most severe label to display
  let label: string;
  let cls: string;
  if (findings.critical > 0) {
    label = `${findings.critical} critical`;
    cls = "bg-red-500/15 text-red-500";
  } else if (findings.major > 0) {
    label = `${findings.major} major`;
    cls = "bg-orange-500/15 text-orange-600";
  } else {
    label = `${findings.minor} minor`;
    cls = "bg-yellow-500/15 text-yellow-600";
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
      title={`CodeRabbit: ${findings.critical} critical, ${findings.major} major, ${findings.minor} minor`}
    >
      CR: {label}
    </span>
  );
}

// ── Expandable Check Details ──────────────────────────────────────────

const CHECK_STATUS_ICONS: Record<string, string> = {
  success: "\u2705",
  failure: "\u274C",
  pending: "\u23F3",
  neutral: "\u25CB",
  unknown: "\u2753",
};

function CheckDetailsPanel({ checks }: { checks: CheckResult[] }) {
  const ciChecks = checks.filter((c) => !c.isGateCheck);
  const gateChecks = checks.filter((c) => c.isGateCheck);

  return (
    <div className="mt-2 rounded border border-border/40 bg-muted/30 p-2 text-[11px]">
      {ciChecks.length > 0 && (
        <div className="mb-1.5">
          <div className="font-semibold text-muted-foreground mb-0.5">
            CI Checks
          </div>
          {ciChecks.map((c) => (
            <div key={c.name} className="flex items-center gap-1 leading-relaxed">
              <span>{CHECK_STATUS_ICONS[c.status] ?? CHECK_STATUS_ICONS.unknown}</span>
              <span className="truncate" title={c.name}>
                {c.name}
              </span>
            </div>
          ))}
        </div>
      )}
      {gateChecks.length > 0 && (
        <div>
          <div className="font-semibold text-muted-foreground mb-0.5">
            Gate Checks
          </div>
          {gateChecks.map((c) => (
            <div key={c.name} className="flex items-center gap-1 leading-relaxed">
              <span>{CHECK_STATUS_ICONS[c.status] ?? CHECK_STATUS_ICONS.unknown}</span>
              <span className="truncate" title={c.name}>
                {c.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
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
  const [checksExpanded, setChecksExpanded] = useState(false);

  // Filter labels that are purely workflow/stage markers from display
  const displayLabels = (pr.labels ?? []).filter(
    (l) =>
      l !== "stage:approved" &&
      l !== "agent:working" &&
      l !== "agent:filed"
  );

  // Left border color based on actionNeeded (defaults to transparent when absent)
  const borderClass = pr.actionNeeded
    ? ACTION_BORDER_COLORS[pr.actionNeeded]
    : "border-l-transparent";

  return (
    <div
      className={`rounded-lg border border-border/60 border-l-[3px] ${borderClass} bg-background p-3 shadow-sm`}
    >
      {/* Header: PR number + author + actionNeeded */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <a
            href={`${GITHUB_REPO_URL}/pull/${pr.number}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline tabular-nums font-medium"
          >
            #{pr.number}
          </a>
          {pr.actionNeeded && <ActionNeededLabel action={pr.actionNeeded} />}
        </div>
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
        {/* Use split CI/Gates badges when check data is available, else fallback */}
        {pr.checks && pr.checks.length > 0 ? (
          <CiGatesBadges checks={pr.checks} />
        ) : (
          <CiStatusBadge status={pr.ciStatus} />
        )}
        <MergeStatusBadge status={pr.mergeable} />
        {pr.unresolvedThreads > 0 && (
          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-purple-500/15 text-purple-600">
            {pr.unresolvedThreads} thread{pr.unresolvedThreads !== 1 ? "s" : ""}
          </span>
        )}
        {pr.codeRabbitFindings && pr.codeRabbitFindings.total > 0 && (
          <CodeRabbitBadge findings={pr.codeRabbitFindings} />
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

      {/* Footer: size + age + check details toggle */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          <span className="text-green-600">+{pr.additions}</span>
          {" / "}
          <span className="text-red-500">-{pr.deletions}</span>
        </span>
        <div className="flex items-center gap-2">
          {pr.checks && pr.checks.length > 0 && (
            <button
              onClick={() => setChecksExpanded(!checksExpanded)}
              className="text-[10px] text-blue-500 hover:underline cursor-pointer"
            >
              {checksExpanded ? "hide checks" : `${pr.checks.length} checks`}
            </button>
          )}
          <span className="tabular-nums" suppressHydrationWarning>
            {relativeTime(pr.createdAt)}
          </span>
        </div>
      </div>

      {/* Expandable check details */}
      {checksExpanded && pr.checks && pr.checks.length > 0 && (
        <CheckDetailsPanel checks={pr.checks} />
      )}
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
      {stats.gateBlocked > 0 && (
        <span>
          Gate Blocked:{" "}
          <span className="font-semibold text-orange-600">
            {stats.gateBlocked}
          </span>
        </span>
      )}
      {stats.codeRabbitIssues > 0 && (
        <span>
          CodeRabbit Issues:{" "}
          <span className="font-semibold text-orange-600">
            {stats.codeRabbitIssues}
          </span>
        </span>
      )}
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
