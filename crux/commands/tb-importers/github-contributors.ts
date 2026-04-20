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
 * The personnel record uses role="contributor" / roleType="career", and
 * `personDisplayName` is left null — the GitHub login is stored in `notes`
 * because surfacing a raw login as a display name fails
 * `validate-display-names.ts` ("no raw machine IDs in titles"). Resolution
 * to a real name happens via downstream Wikidata/OpenAlex cross-reference.
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
import { getFetch, getUserAgent, type HttpOptions } from "./http-utils.ts";
import { T1_SOURCE_PREFIXES } from "./allowlist.ts";
import type { CommandResult } from "../../lib/command-types.ts";
import type { EnrichmentProposal } from "./types.ts";

/**
 * GitHub owner / repo name char allowlist (no path traversal, no encoded bytes).
 * Also rejects the literal traversal segments "." and "..".
 */
const GH_NAME_RE = /^[A-Za-z0-9._-]+$/;
const GH_DENY_NAMES = new Set([".", ".."]);

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

export interface GhContributorsOptions extends HttpOptions {
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

function getHeaders(opts: GhContributorsOptions): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": getUserAgent(opts),
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.githubToken) {
    h.Authorization = `Bearer ${opts.githubToken}`;
  }
  return h;
}

/**
 * Validate `owner/repo` against the GitHub character allowlist.
 * Throws on path traversal (`..`), encoded bytes (`%2e`), or any character
 * outside `[A-Za-z0-9._-]`. Defense against SSRF when `owner/repo` arrives
 * via CLI input.
 */
function assertValidOwnerRepo(ownerRepo: string): { owner: string; repo: string } {
  const parts = ownerRepo.split("/");
  if (parts.length !== 2) {
    throw new Error(`expected "owner/repo", got "${ownerRepo}"`);
  }
  const [owner, repo] = parts;
  if (!GH_NAME_RE.test(owner) || !GH_NAME_RE.test(repo)) {
    throw new Error(
      `owner/repo must match /^[A-Za-z0-9._-]+$/, got "${ownerRepo}"`
    );
  }
  if (GH_DENY_NAMES.has(owner) || GH_DENY_NAMES.has(repo)) {
    throw new Error(
      `owner/repo cannot contain traversal segments "." or "..", got "${ownerRepo}"`
    );
  }
  return { owner, repo };
}

/**
 * Fetch contributors for one repo. Returns Users only (filters Bots and
 * Organizations) since we want human personnel.
 */
export async function fetchRepoContributors(
  ownerRepo: string,
  opts: GhContributorsOptions = {}
): Promise<GhContributor[]> {
  assertValidOwnerRepo(ownerRepo);
  const url = `https://api.github.com/repos/${ownerRepo}/contributors?per_page=100`;
  const resp = await getFetch(opts)(url, { headers: getHeaders(opts) });
  if (!resp.ok) {
    throw new Error(
      `GitHub contributors HTTP ${resp.status} for ${ownerRepo}`
    );
  }
  const rows = (await resp.json()) as GhContributor[];
  if (!Array.isArray(rows)) {
    throw new Error(
      `GitHub contributors response was not an array for ${ownerRepo}`
    );
  }
  return rows.filter((r) => r?.type === "User");
}

/**
 * Aggregate contributors across all of an org's repos and apply the
 * minCommits threshold. Sorted descending by totalContributions.
 *
 * If the same login appears more than once in the same repo (GitHub
 * shouldn't but defensive), the per-repo count accumulates so the
 * invariant `totalContributions === sum(perRepo.values())` holds.
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
        existing.perRepo[repo] = (existing.perRepo[repo] ?? 0) + c.contributions;
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
 *
 * `personDisplayName` is intentionally null: surfacing the GitHub login
 * as a person's display name fails `validate-display-names.ts`
 * ("no raw machine IDs in titles"). The login is in `notes` for
 * downstream Wikidata/OpenAlex resolution.
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
      source: `${T1_SOURCE_PREFIXES.githubContributors}${target.orgSlug}:${c.login}`,
      sourceUrl: c.htmlUrl,
      responseHash,
      recordType: "personnel" as const,
      record: {
        // T1 seeding only — role is placeholder; real title comes from T2 team-page verification.
        role: "contributor",
        roleType: "career",
        // Display name left null on purpose; see header comment.
        personDisplayName: null,
        orgDisplayName: target.orgName,
        source: c.htmlUrl,
        notes: `GitHub contributor "${c.login}": ${c.totalContributions} commits across ${Object.keys(c.perRepo).length} repo(s)`,
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
 * Returns the proposals AND a `failures` count for the caller; per-repo
 * errors are logged and skipped but surfaced via the count.
 *
 * Per-repo fetches run in parallel. GitHub's authenticated rate limit is
 * 5000/h, so a target with 10 repos is comfortably under any cap; without
 * a token (60/h) you're rate-limit constrained anyway and parallelism is
 * effectively bounded by the limit.
 */
export async function importTarget(
  target: GhContributorsTarget,
  opts: GhContributorsOptions = {}
): Promise<{ proposals: EnrichmentProposal[]; failures: number }> {
  const minCommits =
    target.minCommits ?? opts.defaultMinCommits ?? DEFAULT_MIN_COMMITS;
  const perRepo: Record<string, GhContributor[]> = {};
  let failures = 0;
  const settled = await Promise.all(
    target.repos.map(async (repo) => {
      try {
        return { repo, contribs: await fetchRepoContributors(repo, opts) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[github-contributors] skipping repo ${repo}: ${msg}`);
        return { repo, error: msg };
      }
    })
  );
  for (const r of settled) {
    if ("error" in r) failures++;
    else perRepo[r.repo] = r.contribs;
  }
  const aggregated = aggregateContributors(perRepo, minCommits);
  return { proposals: buildProposals(target, aggregated), failures };
}

/** CLI entry — `crux tb github-contributors --target=anthropic:repo1,repo2`. */
export async function cliMain(args: string[]): Promise<CommandResult> {
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
  let totalFailures = 0;
  for (const t of targets) {
    console.log(
      `[github-contributors] fetching ${t.orgSlug} (${t.repos.length} repos)...`
    );
    try {
      const { proposals, failures } = await importTarget(t, opts);
      console.log(
        `[github-contributors]   → ${proposals.length} contributors, ${failures} repo failures`
      );
      all.push(...proposals);
      totalFailures += failures;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[github-contributors] target ${t.orgSlug} failed: ${msg}`);
      totalFailures++;
    }
  }
  const clientOpts: ProposeClientOptions = { submit };
  const results = await submitBatch(all, clientOpts);
  printBatchSummary(results, "github-contributors");
  if (totalFailures > 0) {
    console.warn(`[github-contributors] ${totalFailures} repo/target failures`);
  }
  return { exitCode: 0, output: "" };
}

/**
 * Parse `--target=slug:owner/repo,owner/repo2` flags. The repo list is
 * comma-separated. Empty segments (`a/b,,a/c`) are rejected as typos.
 * Each `owner/repo` is validated against the GitHub allowlist.
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
    if (!orgSlug) {
      throw new Error(`--target slug must be non-empty, got "${value}"`);
    }
    const repos = reposCsv.split(",");
    if (repos.length === 0 || repos.some((r) => r.length === 0)) {
      throw new Error(
        `--target repos must be a comma-separated list with no empty entries, got "${reposCsv}"`
      );
    }
    for (const r of repos) {
      assertValidOwnerRepo(r);
    }
    out.push({ orgSlug, orgName: orgSlug, repos });
  }
  return out;
}
