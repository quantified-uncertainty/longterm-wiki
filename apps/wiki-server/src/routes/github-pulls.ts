import { Hono } from "hono";

const REPO_OWNER = "quantified-uncertainty";
const REPO_NAME = "longterm-wiki";

/**
 * Shape returned to consumers (E925 agent enrichment, E927 PR dashboard).
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
}

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
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
              }
            }
          }
        }
      }
    }
  }
}
`;

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
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: { state: string } | null;
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

function mapNode(node: GQLPRNode): OpenPR {
  const lastCommit = node.commits.nodes[0]?.commit;
  return {
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
  };
}

// ── Route ──────────────────────────────────────────────────────────────────

const githubPullsApp = new Hono().get("/", async (c) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return c.json(
      { error: "GITHUB_TOKEN not configured on server", pulls: [] },
      200
    );
  }

  try {
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
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "(no body)");
      return c.json(
        { error: `GitHub GraphQL returned ${resp.status}: ${text}`, pulls: [] },
        200
      );
    }

    const result = (await resp.json()) as GQLResponse;

    if (result.errors?.length) {
      const msgs = result.errors.map((e) => e.message).join("; ");
      return c.json({ error: `GraphQL error: ${msgs}`, pulls: [] }, 200);
    }

    const nodes = result.data?.repository.pullRequests.nodes ?? [];
    const pulls: OpenPR[] = nodes.map(mapNode);

    return c.json({ pulls });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to fetch PRs: ${msg}`, pulls: [] }, 200);
  }
});

export const githubPullsRoute = githubPullsApp;
export type GithubPullsRoute = typeof githubPullsApp;
