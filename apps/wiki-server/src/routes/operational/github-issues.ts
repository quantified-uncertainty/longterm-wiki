import { Hono } from "hono";

const REPO = "quantified-uncertainty/longterm-wiki";

interface GitHubIssueResponse {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
  created_at: string;
  closed_at: string | null;
  pull_request?: { url: string };
}

const githubIssuesApp = new Hono()
  .get("/", async (c) => {
    const numbersParam = c.req.query("numbers");
    if (!numbersParam) {
      return c.json({ error: "numbers query parameter is required" }, 400);
    }

    const numbers = numbersParam
      .split(",")
      .map((n) => parseInt(n.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);

    if (numbers.length === 0) {
      return c.json({ error: "no valid issue numbers provided" }, 400);
    }

    if (numbers.length > 50) {
      return c.json({ error: "maximum 50 issues per request" }, 400);
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return c.json({ error: "GITHUB_TOKEN not configured on server" }, 500);
    }

    const issues = await Promise.all(
      numbers.map(async (num) => {
        try {
          const res = await fetch(
            `https://api.github.com/repos/${REPO}/issues/${num}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "longterm-wiki-server",
              },
            }
          );

          if (!res.ok) {
            return {
              number: num,
              title: `Issue #${num} (not found)`,
              state: "unknown",
              labels: [] as string[],
              created_at: "",
              closed_at: null as string | null,
            };
          }

          const data = (await res.json()) as GitHubIssueResponse;
          return {
            number: data.number,
            title: data.title,
            state: data.state,
            labels: data.labels.map((l) => l.name),
            created_at: data.created_at,
            closed_at: data.closed_at,
            ...(data.pull_request ? { pull_request: { url: data.pull_request.url } } : {}),
          };
        } catch (_e) {
          return {
            number: num,
            title: `Issue #${num} (fetch error)`,
            state: "unknown",
            labels: [] as string[],
            created_at: "",
            closed_at: null as string | null,
          };
        }
      })
    );

    return c.json({ issues });
  });

export const githubIssuesRoute = githubIssuesApp;
export type GithubIssuesRoute = typeof githubIssuesApp;
