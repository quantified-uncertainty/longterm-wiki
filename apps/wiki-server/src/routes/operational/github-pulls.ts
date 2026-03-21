import { Hono } from "hono";

const REPO_OWNER = "quantified-uncertainty";
const REPO_NAME = "longterm-wiki";

// ── Types ──────────────────────────────────────────────────────────────────

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

/**
 * Shape returned to consumers (E925 agent enrichment, E927 PR dashboard).
 * New fields (checks, codeRabbitFindings, actionNeeded) are optional for
 * backward compatibility.
 */
export interface OpenPR {
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
  checks?: CheckResult[];
  codeRabbitFindings?: CodeRabbitSummary;
  actionNeeded?: ActionNeeded;
}

// ── Gate check classification ──────────────────────────────────────────────

/**
 * CI checks that are gate checks (require human labels, not real CI failures).
 * Aligned with HUMAN_REQUIRED_CHECKS in crux/lib/pr-analysis/detection.ts.
 */
const GATE_CHECK_NAMES = new Set([
  "check-protected-paths",
  "coderabbit-security-gate",
  "audit-gate",
  "preflight",
  "paused-notice",
  "paused-notice / paused-notice",
]);

/** Maps gate check names to the label needed to satisfy them. */
const GATE_CHECK_TO_LABEL: Record<string, string> = {
  "check-protected-paths": "gate:rules-ok",
  "coderabbit-security-gate": "gate:security-ok",
};

// ── GraphQL query ──────────────────────────────────────────────────────────

const OPEN_PRS_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        headRefName
        author { login }
        createdAt
        updatedAt
        mergeable
        isDraft
        additions
        deletions
        labels(first: 20) {
          nodes { name }
        }
        reviewThreads(first: 50) {
          nodes {
            isResolved
            isOutdated
            comments(first: 1) {
              nodes {
                author { login }
                body
              }
            }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 50) {
                  nodes {
                    ... on CheckRun { name conclusion status }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

// ── GraphQL response types ─────────────────────────────────────────────────

interface GQLCheckRunNode {
  name?: string;
  conclusion?: string | null;
  status?: string;
  context?: undefined;
  state?: undefined;
}

interface GQLStatusContextNode {
  context?: string;
  state?: string;
  name?: undefined;
  conclusion?: undefined;
  status?: undefined;
}

type GQLCheckContextNode = GQLCheckRunNode | GQLStatusContextNode;

interface GQLReviewThreadComment {
  author: { login: string } | null;
  body: string;
}

interface GQLPRNode {
  number: number;
  title: string;
  headRefName: string;
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  isDraft: boolean;
  additions: number;
  deletions: number;
  labels: {
    nodes: Array<{ name: string }>;
  };
  reviewThreads: {
    nodes: Array<{
      isResolved: boolean;
      isOutdated: boolean;
      comments: {
        nodes: GQLReviewThreadComment[];
      };
    }>;
  };
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
          contexts?: {
            nodes: GQLCheckContextNode[];
          };
        } | null;
      };
    }>;
  };
}

interface GQLResponse {
  data?: {
    repository: {
      pullRequests: {
        nodes: GQLPRNode[];
      };
    };
  };
  errors?: Array<{ message: string }>;
}

// ── Mapping helpers ────────────────────────────────────────────────────────

function mapCiStatus(state: string | null | undefined): OpenPR["ciStatus"] {
  if (!state) return "unknown";
  switch (state.toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    case "ERROR":
      return "error";
    default:
      return "unknown";
  }
}

function mapMergeable(m: GQLPRNode["mergeable"]): OpenPR["mergeable"] {
  switch (m) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function mapCheckStatus(
  node: GQLCheckContextNode
): CheckResult["status"] {
  // CheckRun: conclusion is the final result, status indicates if still running
  if (node.conclusion !== undefined) {
    if (node.status?.toUpperCase() === "IN_PROGRESS" || node.status?.toUpperCase() === "QUEUED") {
      return "pending";
    }
    const conclusion = node.conclusion?.toUpperCase();
    switch (conclusion) {
      case "SUCCESS":
        return "success";
      case "FAILURE":
      case "TIMED_OUT":
      case "CANCELLED":
        return "failure";
      case "NEUTRAL":
      case "SKIPPED":
        return "neutral";
      case "ACTION_REQUIRED":
        return "failure";
      case null:
      case undefined:
        return "pending"; // still running
      default:
        return "unknown";
    }
  }
  // StatusContext: uses state field
  if (node.state !== undefined) {
    switch (node.state?.toUpperCase()) {
      case "SUCCESS":
        return "success";
      case "FAILURE":
      case "ERROR":
        return "failure";
      case "PENDING":
      case "EXPECTED":
        return "pending";
      default:
        return "unknown";
    }
  }
  return "unknown";
}

function extractChecks(node: GQLPRNode): CheckResult[] {
  const rollup = node.commits.nodes[0]?.commit?.statusCheckRollup;
  const contexts = rollup?.contexts?.nodes ?? [];
  return contexts.map((ctx) => {
    const name = ctx.name ?? ctx.context ?? "unknown";
    return {
      name,
      status: mapCheckStatus(ctx),
      isGateCheck: GATE_CHECK_NAMES.has(name),
    };
  });
}

// ── CodeRabbit detection ───────────────────────────────────────────────────

const CODERABBIT_LOGINS = new Set(["coderabbitai", "coderabbitai[bot]"]);
const SEVERITY_CRITICAL_RE = /🔴\s*Critical/;
const SEVERITY_MAJOR_RE = /🟠\s*Major/;
const SEVERITY_MINOR_RE = /🟡\s*Minor/;

function extractCodeRabbitSummary(
  node: GQLPRNode
): CodeRabbitSummary | undefined {
  let critical = 0;
  let major = 0;
  let minor = 0;

  for (const thread of node.reviewThreads.nodes) {
    if (thread.isResolved || thread.isOutdated) continue;
    const firstComment = thread.comments.nodes[0];
    if (!firstComment?.author?.login) continue;
    if (!CODERABBIT_LOGINS.has(firstComment.author.login)) continue;

    const body = firstComment.body;
    if (SEVERITY_CRITICAL_RE.test(body)) critical++;
    else if (SEVERITY_MAJOR_RE.test(body)) major++;
    else if (SEVERITY_MINOR_RE.test(body)) minor++;
  }

  const total = critical + major + minor;
  if (total === 0) return undefined;
  return { critical, major, minor, total };
}

// ── Action classification ──────────────────────────────────────────────────

function classifyAction(pr: OpenPR): ActionNeeded {
  // Priority: rebase > code-fix > building > human-label > comment-response > ready

  // 1. Rebase needed — merge conflicts
  if (pr.mergeable === "conflicting") {
    return "rebase";
  }

  // 2. Code fix — real CI failures (not gate checks)
  const realFailures =
    pr.checks?.filter((c) => c.status === "failure" && !c.isGateCheck) ?? [];
  if (realFailures.length > 0) {
    return "code-fix";
  }

  // Also code-fix for critical/major CodeRabbit findings
  if (
    pr.codeRabbitFindings &&
    (pr.codeRabbitFindings.critical > 0 || pr.codeRabbitFindings.major > 0)
  ) {
    return "code-fix";
  }

  // 3. Building — checks still in progress
  const pendingChecks =
    pr.checks?.filter((c) => c.status === "pending" && !c.isGateCheck) ?? [];
  if (pendingChecks.length > 0) {
    return "building";
  }

  // 4. Human label needed — only gate checks failing
  const gateFailures =
    pr.checks?.filter((c) => c.status === "failure" && c.isGateCheck) ?? [];
  if (gateFailures.length > 0) {
    return "human-label";
  }

  // 5. Comment response — unresolved review threads from human reviewers only.
  //    Subtract CodeRabbit threads (already tracked via codeRabbitFindings).
  const codeRabbitThreads = pr.codeRabbitFindings?.total ?? 0;
  const humanUnresolvedThreads = pr.unresolvedThreads - codeRabbitThreads;
  if (humanUnresolvedThreads > 0) {
    return "comment-response";
  }

  // 6. All green
  return "ready";
}

// ── Node mapping ───────────────────────────────────────────────────────────

function mapNode(node: GQLPRNode): OpenPR {
  const lastCommit = node.commits.nodes[0]?.commit;
  const unresolvedThreads = node.reviewThreads.nodes.filter(
    (t) => !t.isResolved && !t.isOutdated
  ).length;

  const checks = extractChecks(node);
  const codeRabbitFindings = extractCodeRabbitSummary(node);

  const pr: OpenPR = {
    number: node.number,
    title: node.title,
    branch: node.headRefName,
    author: node.author?.login ?? "unknown",
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    isDraft: node.isDraft,
    additions: node.additions,
    deletions: node.deletions,
    ciStatus: mapCiStatus(lastCommit?.statusCheckRollup?.state),
    mergeable: mapMergeable(node.mergeable),
    labels: node.labels.nodes.map((l) => l.name),
    unresolvedThreads,
    checks,
    codeRabbitFindings,
  };

  pr.actionNeeded = classifyAction(pr);

  return pr;
}

// ── Shared fetch logic ─────────────────────────────────────────────────────

interface FetchResult {
  pulls: OpenPR[];
  error?: string;
}

async function fetchEnrichedPRs(token: string): Promise<FetchResult> {
  const resp = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "longterm-wiki-server",
    },
    body: JSON.stringify({
      query: OPEN_PRS_QUERY,
      variables: { owner: REPO_OWNER, name: REPO_NAME },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(no body)");
    return {
      pulls: [],
      error: `GitHub GraphQL returned ${resp.status}: ${text}`,
    };
  }

  const result = (await resp.json()) as GQLResponse;

  if (result.errors?.length) {
    const msgs = result.errors.map((e) => e.message).join("; ");
    return { pulls: [], error: `GraphQL error: ${msgs}` };
  }

  const nodes = result.data?.repository.pullRequests.nodes ?? [];
  const pulls: OpenPR[] = nodes.map(mapNode);
  return { pulls };
}

// ── Patrol summary types ───────────────────────────────────────────────────

interface PatrolAttentionItem {
  pr: number;
  action: ActionNeeded;
  reason: string;
}

interface PatrolHumanItem {
  pr: number;
  labels: string[];
}

export interface PatrolSummary {
  needsAttention: PatrolAttentionItem[];
  allGreen: number[];
  waitingOnHuman: PatrolHumanItem[];
  building: number[];
}

function buildPatrolSummary(pulls: OpenPR[]): PatrolSummary {
  const needsAttention: PatrolAttentionItem[] = [];
  const allGreen: number[] = [];
  const waitingOnHuman: PatrolHumanItem[] = [];
  const building: number[] = [];

  for (const pr of pulls) {
    if (pr.isDraft) continue; // skip drafts from patrol summary

    switch (pr.actionNeeded) {
      case "rebase":
        needsAttention.push({
          pr: pr.number,
          action: "rebase",
          reason: "merge conflicts",
        });
        break;

      case "code-fix": {
        const reasons: string[] = [];
        const realFailures =
          pr.checks?.filter((c) => c.status === "failure" && !c.isGateCheck) ??
          [];
        if (realFailures.length > 0) {
          reasons.push(
            `failing: ${realFailures.map((c) => c.name).join(", ")}`
          );
        }
        if (pr.codeRabbitFindings) {
          const parts: string[] = [];
          if (pr.codeRabbitFindings.critical > 0)
            parts.push(`${pr.codeRabbitFindings.critical} critical`);
          if (pr.codeRabbitFindings.major > 0)
            parts.push(`${pr.codeRabbitFindings.major} major`);
          if (parts.length > 0) {
            reasons.push(
              `${parts.join(", ")} unresolved CodeRabbit findings`
            );
          }
        }
        needsAttention.push({
          pr: pr.number,
          action: "code-fix",
          reason: reasons.join("; "),
        });
        break;
      }

      case "building":
        building.push(pr.number);
        break;

      case "human-label": {
        // Determine which gate labels are missing
        const gateFailures =
          pr.checks?.filter(
            (c) => c.status === "failure" && c.isGateCheck
          ) ?? [];
        const missingLabels: string[] = [];
        for (const check of gateFailures) {
          const requiredLabel = GATE_CHECK_TO_LABEL[check.name];
          if (requiredLabel && !pr.labels.includes(requiredLabel)) {
            missingLabels.push(requiredLabel);
          }
        }
        waitingOnHuman.push({
          pr: pr.number,
          labels: missingLabels,
        });
        break;
      }

      case "comment-response": {
        const crThreads = pr.codeRabbitFindings?.total ?? 0;
        const humanThreads = pr.unresolvedThreads - crThreads;
        needsAttention.push({
          pr: pr.number,
          action: "comment-response",
          reason: `${humanThreads} unresolved human review thread${humanThreads !== 1 ? "s" : ""}`,
        });
        break;
      }

      case "ready":
        allGreen.push(pr.number);
        break;
    }
  }

  return { needsAttention, allGreen, waitingOnHuman, building };
}

// ── Routes ─────────────────────────────────────────────────────────────────

const githubPullsApp = new Hono()
  .get("/", async (c) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return c.json(
        { error: "GITHUB_TOKEN not configured on server", pulls: [] as OpenPR[] },
        200
      );
    }

    try {
      const result = await fetchEnrichedPRs(token);
      if (result.error) {
        return c.json({ error: result.error, pulls: result.pulls }, 200);
      }
      return c.json({ pulls: result.pulls });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `Failed to fetch PRs: ${msg}`, pulls: [] as OpenPR[] },
        200
      );
    }
  })
  .get("/patrol-summary", async (c) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return c.json(
        {
          error: "GITHUB_TOKEN not configured on server",
          needsAttention: [] as PatrolAttentionItem[],
          allGreen: [] as number[],
          waitingOnHuman: [] as PatrolHumanItem[],
          building: [] as number[],
        },
        200
      );
    }

    try {
      const result = await fetchEnrichedPRs(token);
      if (result.error) {
        return c.json(
          {
            error: result.error,
            needsAttention: [] as PatrolAttentionItem[],
            allGreen: [] as number[],
            waitingOnHuman: [] as PatrolHumanItem[],
            building: [] as number[],
          },
          200
        );
      }
      const summary = buildPatrolSummary(result.pulls);
      return c.json(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: `Failed to fetch PRs: ${msg}`,
          needsAttention: [] as PatrolAttentionItem[],
          allGreen: [] as number[],
          waitingOnHuman: [] as PatrolHumanItem[],
          building: [] as number[],
        },
        200
      );
    }
  });

export const githubPullsRoute = githubPullsApp;
export type GithubPullsRoute = typeof githubPullsApp;
