/**
 * Shared types and pure functions for the PR Dashboard.
 *
 * This module is intentionally free of server-only imports so it can be
 * safely imported by both the server content component and the "use client"
 * board component.
 */

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
}

// ── Stats ────────────────────────────────────────────────────────────────

export interface PRStats {
  total: number;
  draft: number;
  ciFailing: number;
  needsReview: number;
  conflicting: number;
}

// ── Kanban Column Classification ────────────────────────────────────────

export type KanbanColumn = "draft" | "ci-issues" | "needs-review" | "approved";

/**
 * Classify a PR into one of the Kanban columns.
 * Single source of truth: used by both stats computation and board grouping.
 */
export function classifyPR(pr: PullData): KanbanColumn {
  if (pr.isDraft) return "draft";

  const hasApproved = pr.labels.some(
    (l) => l === "stage:approved" || l === "ready-to-merge"
  );
  if (hasApproved) return "approved";

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
  };
}
