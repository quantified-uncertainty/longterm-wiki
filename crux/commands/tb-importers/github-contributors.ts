/**
 * GitHub contributors → personnel hints importer (T1, QUA-640).
 *
 * For AI labs with public repos (Anthropic, DeepMind, MIRI, Redwood, Apollo,
 * FAR AI, Conjecture, EleutherAI), the GitHub contributors API gives us a
 * deterministic list of GitHub users with ≥N commits to org-controlled repos.
 *
 * Important: this is a T1 SEEDING step. The contributor's role/title still
 * needs T2 verification against the org's team page — we record the GitHub
 * association, not the role. Per QUA-640: "personnel role/title still needs
 * T2 verification against team pages; this is a T1 seeding step".
 *
 * The personnel record we write therefore uses role="contributor" and
 * roleType="career" — explicitly distinguishing it from key-person rows.
 *
 * API: https://api.github.com/repos/<owner>/<repo>/contributors?per_page=100
 *   (requires no auth for public repos; rate-limited at 60/h unauth or
 *    5000/h with a token).
 */

import { createHash } from "crypto";
import {
  submitBatch,
  printBatchSummary,
  type ProposeClientOptions,
} from "./propose-client.ts";
import type { EnrichmentProposal } from "./types.ts";

const USER_AGENT = "longterm-wiki <ozzie@quantifieduncertainty.org>";

export interface GhContributorsTarget {
  /** Org slug from data/entities/organizations.yaml */
  orgSlug: string;
  /** Display name for the org */
  orgName: string;
  /** GitHub repos (`owner/repo`) attributed to this org */
  repos: readonly string[];
  /** Minimum commit count to include a contributor. Defaults to 5. */
  minCommits?: number;
}

export interface GhContributorsOptions {
  /** Override fetch — used by tests to inject responses */
  fetchImpl?: typeof fetch;
  /** Override the User-Agent */
  userAgent?: string;
  /** Personal access token for higher rate limits (5000/h vs 60/h unauth) */
  githubToken?: string;
  /** Default minimum commits floor when target lacks its own (defaults to 5) */
  defaultMinCommits?: number;
}

/** Shape of one row in `GET /repos/{owner}/{repo}/contributors`. Partial. */
export interface GhContributor {
  login: string;
  id: number;
  contributions: number;
  type: "User" | "Bot" | "Organization";
  html_url: string;
}

/** Aggregated contributor across all of one org's repos. */
export interface AggregatedContributor {
  login: string;
  /** Total contributions summed across the org's repos. */
  totalContributions: number;
  /** Per-repo breakdown for evidence. */
  perRepo: Record<string, number>;
  /** GitHub profile URL — first one observed. */
  htmlUrl: string;
}

const DEFAULT_MIN_COMMITS = 5;

function getFetch(opts: GhContributorsOptions): typeof fetch {
  return opts.fetchImpl ?? globalThis.fetch;
}

function getHeaders(opts: GhContributorsOptions): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": opts.userAgent ?? USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.githubToken) {
    h.Authorization = `Bearer ${opts.githubToken}`;
  }
  return h;
}

/**
 * Fetch contributors for one repo. Returns Users only (filters Bots and
 * Organizations) since we want human personnel.
 */
export async function fetchRepoContributors(
  ownerRepo: string,
  opts: GhContributorsOptions = {}
): Promise<GhContributor[]> {
  if (!ownerRepo.includes("/")) {
    throw new Error(`expected "owner/repo", got "${ownerRepo}"`);
  }
  const url = `https://api.github.com/repos/${ownerRepo}/contributors?per_page=100`;
  const resp = await getFetch(opts)(url, { headers: getHeaders(opts) });
  if (!resp.ok) {
    throw new Error(
      `GitHub contributors HTTP ${resp.status} for ${ownerRepo}`
    );
  }
  const rows = (await resp.json()) as GhContributor[];
  return rows.filter((r) => r.type === "User");
}

/**
 * Aggregate contributors across all of an org's repos and apply the
 * minCommits threshold. Sorted descending by totalContributions.
 */
export function aggregateContributors(
  perRepo: Record<string, GhContributor[]>,
  minCommits: number
): AggregatedContributor[] {
  const byLogin = new Map<string, AggregatedContributor>();
  for (const [repo, contribs] of Object.entries(perRepo)) {
    for (const c of contribs) {
      const existing = byLogin.get(c.login);
      if (existing) {
        existing.totalContributions += c.contributions;
        existing.perRepo[repo] = c.contributions;
      } else {
        byLogin.set(c.login, {
          login: c.login,
          totalContributions: c.contributions,
          perRepo: { [repo]: c.contributions },
          htmlUrl: c.html_url,
        });
      }
    }
  }
  return [...byLogin.values()]
    .filter((c) => c.totalContributions >= minCommits)
    .sort((a, b) => b.totalContributions - a.totalContributions);
}

/**
 * Build one personnel proposal per contributor.
 *
 * The `source` is `github-contributors:<orgSlug>:<login>` — uniquely
 * identifies the (org, person) tuple. The `responseHash` covers the
 * canonicalized aggregated record so retries with the same data produce
 * identical proposals.
 */
export function buildProposals(
  target: GhContributorsTarget,
  contributors: readonly AggregatedContributor[]
): EnrichmentProposal[] {
  return contributors.map((c) => {
    const canonical = JSON.stringify({
      org: target.orgSlug,
      login: c.login,
      perRepo: c.perRepo,
    });
    const responseHash = createHash("sha256").update(canonical).digest("hex");
    return {
      tier: "T1" as const,
      source: `github-contributors:${target.orgSlug}:${c.login}`,
      sourceUrl: c.htmlUrl,
      responseHash,
      recordType: "personnel" as const,
      record: {
        // T1 seeding only — role is placeholder; real title comes from T2 team-page verification.
        role: "contributor",
        roleType: "career",
        // GitHub login — will need cross-reference with Wikidata/OpenAlex
        // by a downstream step (out of scope for QUA-640). We record the
        // login so the resolver can do that lookup.
        personDisplayName: c.login,
        orgDisplayName: target.orgName,
        source: c.htmlUrl,
        notes: `GitHub contributor: ${c.totalContributions} commits across ${Object.keys(c.perRepo).length} repo(s)`,
        isFounder: false,
      },
      entityRefs: {
        organization: target.orgSlug,
        person: c.login,
      },
    };
  });
}

/**
 * Fetch + aggregate + build proposals for one target.
 * Errors on individual repos are logged + skipped.
 */
export async function importTarget(
  target: GhContributorsTarget,
  opts: GhContributorsOptions = {}
): Promise<EnrichmentProposal[]> {
  const minCommits =
    target.minCommits ?? opts.defaultMinCommits ?? DEFAULT_MIN_COMMITS;
  const perRepo: Record<string, GhContributor[]> = {};
  for (const repo of target.repos) {
    try {
      perRepo[repo] = await fetchRepoContributors(repo, opts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[github-contributors] skipping repo ${repo}: ${msg}`);
    }
  }
  const aggregated = aggregateContributors(perRepo, minCommits);
  return buildProposals(target, aggregated);
}

/** CLI entry — `crux tb github-contributors --target=anthropic:repo1,repo2`. */
export async function cliMain(
  args: string[]
): Promise<{ exitCode: number; output: string }> {
  const submit = args.includes("--submit");
  const targets = parseTargetsArg(args);
  if (targets.length === 0) {
    return {
      exitCode: 2,
      output:
        "No targets specified. Pass --target=slug:owner/repo[,owner/repo2] (repeatable)",
    };
  }
  const opts: GhContributorsOptions = {
    githubToken: process.env.GITHUB_TOKEN,
  };
  const all: EnrichmentProposal[] = [];
  for (const t of targets) {
    console.log(
      `[github-contributors] fetching ${t.orgSlug} (${t.repos.length} repos)...`
    );
    const proposals = await importTarget(t, opts);
    console.log(`[github-contributors]   → ${proposals.length} contributors`);
    all.push(...proposals);
  }
  const clientOpts: ProposeClientOptions = { submit };
  const results = await submitBatch(all, clientOpts);
  printBatchSummary(results, "github-contributors");
  return { exitCode: 0, output: "" };
}

/**
 * Parse `--target=slug:owner/repo,owner/repo2` flags. The repo list is
 * comma-separated and may not contain spaces.
 */
export function parseTargetsArg(args: readonly string[]): GhContributorsTarget[] {
  const out: GhContributorsTarget[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--target=")) continue;
    const value = arg.slice("--target=".length);
    const colonIdx = value.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(
        `--target must be slug:owner/repo[,owner/repo2], got "${value}"`
      );
    }
    const orgSlug = value.slice(0, colonIdx);
    const reposCsv = value.slice(colonIdx + 1);
    const repos = reposCsv.split(",").filter(Boolean);
    if (repos.length === 0 || repos.some((r) => !r.includes("/"))) {
      throw new Error(
        `--target repos must each be "owner/repo", got "${reposCsv}"`
      );
    }
    out.push({ orgSlug, orgName: orgSlug, repos });
  }
  return out;
}
