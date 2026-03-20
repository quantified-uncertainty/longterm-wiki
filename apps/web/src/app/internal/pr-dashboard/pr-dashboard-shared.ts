/**
 * Shared types and pure functions for the PR Dashboard.
 *
 * This module is intentionally free of server-only imports so it can be
 * safely imported by both the server content component and the "use client"
 * board component.
 */

// ── Enriched Check / CodeRabbit / Action Types ─────────────────────────

export interface CheckResult {
  name: string;
  status: "success" | "failure" | "pending" | "neutral" | "unknown";
  isGateCheck: boolean;
}

export interface CodeRabbitSummary {
  critical: number;
  major: number;
  minor: number;
  total: number;
}

export type ActionNeeded =
  | "code-fix"
  | "rebase"
  | "human-label"
  | "comment-response"
  | "ready"
  | "building";

// ── Types (matches OpenPR from wiki-server github-pulls route) ──────────

export interface PullData {
  number: number;
  title: string;
  branch: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  ciStatus: "success" | "failure" | "pending" | "error" | "unknown";
  mergeable: "mergeable" | "conflicting" | "unknown";
  labels: string[];
  unresolvedThreads: number;
  // Enriched fields (optional — gracefully degrade when absent)
  checks?: CheckResult[];
  codeRabbitFindings?: CodeRabbitSummary;
  actionNeeded?: ActionNeeded;
}

// ── Stats ────────────────────────────────────────────────────────────────

export interface PRStats {
  total: number;
  draft: number;
  ciFailing: number;
  needsReview: number;
  conflicting: number;
  gateBlocked: number;
  codeRabbitIssues: number;
}

// ── Kanban Column Classification ────────────────────────────────────────

export type KanbanColumn = "draft" | "ci-issues" | "needs-review" | "approved";

/**
 * Classify a PR into one of the Kanban columns.
 * When enriched `actionNeeded` data is available, use it for smarter placement.
 * Falls back to the original heuristic when the field is absent.
 */
export function classifyPR(pr: PullData): KanbanColumn {
  if (pr.isDraft) return "draft";

  const labels = pr.labels ?? [];
  const hasApproved = labels.some(
    (l) => l === "stage:approved"
  );
  if (hasApproved) return "approved";

  // Use enriched actionNeeded when available for smarter column assignment
  if (pr.actionNeeded) {
    switch (pr.actionNeeded) {
      case "ready":
        return "approved";
      case "building":
      case "code-fix":
        return "ci-issues";
      case "rebase":
      case "human-label":
      case "comment-response":
        return "needs-review";
    }
  }

  // Fallback: original heuristic when actionNeeded is not provided
  if (
    pr.ciStatus === "pending" ||
    pr.ciStatus === "failure" ||
    pr.ciStatus === "error"
  ) {
    return "ci-issues";
  }

  return "needs-review";
}

/**
 * Compute aggregate stats from a list of PRs using the shared classifyPR logic.
 */
export function computeStats(pulls: PullData[]): PRStats {
  const counts: Record<KanbanColumn, number> = {
    draft: 0,
    "ci-issues": 0,
    "needs-review": 0,
    approved: 0,
  };

  for (const pr of pulls) {
    counts[classifyPR(pr)]++;
  }

  return {
    total: pulls.length,
    draft: counts.draft,
    ciFailing: pulls.filter((p) => p.ciStatus === "failure").length,
    needsReview: counts["needs-review"],
    conflicting: pulls.filter((p) => p.mergeable === "conflicting").length,
    gateBlocked: pulls.filter(
      (p) => p.checks?.some((c) => c.isGateCheck && c.status === "failure")
    ).length,
    codeRabbitIssues: pulls.filter(
      (p) => p.codeRabbitFindings && p.codeRabbitFindings.total > 0
    ).length,
  };
}
