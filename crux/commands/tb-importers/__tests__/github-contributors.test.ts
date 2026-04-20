import { describe, it, expect } from "vitest";
import {
  fetchRepoContributors,
  aggregateContributors,
  buildProposals,
  importTarget,
  parseTargetsArg,
  type GhContributor,
  type GhContributorsTarget,
} from "../github-contributors.ts";

const TARGET: GhContributorsTarget = {
  orgSlug: "anthropic",
  orgName: "Anthropic",
  repos: ["anthropics/anthropic-sdk-python", "anthropics/courses"],
  minCommits: 5,
};

function makeFetch(byUrl: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (url: string) => {
    const match = byUrl[url];
    if (!match) {
      return { ok: false, status: 404, async json() { return {}; } };
    }
    return {
      ok: match.status >= 200 && match.status < 300,
      status: match.status,
      async json() {
        return match.body;
      },
    };
  }) as unknown as typeof fetch;
}

const SAMPLE_USERS: GhContributor[] = [
  { login: "alice", id: 1, contributions: 50, type: "User", html_url: "https://github.com/alice" },
  { login: "bob", id: 2, contributions: 10, type: "User", html_url: "https://github.com/bob" },
  { login: "carol", id: 3, contributions: 3, type: "User", html_url: "https://github.com/carol" }, // below min
  { login: "dependabot[bot]", id: 4, contributions: 200, type: "Bot", html_url: "https://github.com/dependabot" },
  { login: "an-org", id: 5, contributions: 100, type: "Organization", html_url: "https://github.com/an-org" },
];

describe("fetchRepoContributors", () => {
  it("filters out Bots and Organizations", async () => {
    const fetchImpl = makeFetch({
      "https://api.github.com/repos/anthropics/anthropic-sdk-python/contributors?per_page=100": {
        status: 200,
        body: SAMPLE_USERS,
      },
    });
    const out = await fetchRepoContributors("anthropics/anthropic-sdk-python", { fetchImpl });
    expect(out.map((u) => u.login)).toEqual(["alice", "bob", "carol"]);
  });

  it("throws on bad owner/repo format", async () => {
    await expect(fetchRepoContributors("invalid", {})).rejects.toThrow(/owner\/repo/);
  });

  it("throws on non-2xx HTTP", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(
      fetchRepoContributors("a/b", { fetchImpl })
    ).rejects.toThrow(/HTTP 403/);
  });

  it("sends Authorization when githubToken provided", async () => {
    let captured = "";
    const fetchImpl = (async (_url: string, init: RequestInit | undefined) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      captured = headers.Authorization ?? "";
      return { ok: true, status: 200, async json() { return []; } };
    }) as unknown as typeof fetch;
    await fetchRepoContributors("a/b", { fetchImpl, githubToken: "secret123" });
    expect(captured).toBe("Bearer secret123");
  });

  it("does not send Authorization when no token", async () => {
    let captured: string | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit | undefined) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      captured = headers.Authorization;
      return { ok: true, status: 200, async json() { return []; } };
    }) as unknown as typeof fetch;
    await fetchRepoContributors("a/b", { fetchImpl });
    expect(captured).toBeUndefined();
  });
});

describe("aggregateContributors", () => {
  it("sums contributions across repos and applies threshold", () => {
    const perRepo = {
      "a/r1": [
        { login: "alice", id: 1, contributions: 4, type: "User" as const, html_url: "url1" },
        { login: "bob", id: 2, contributions: 2, type: "User" as const, html_url: "url2" },
      ],
      "a/r2": [
        { login: "alice", id: 1, contributions: 3, type: "User" as const, html_url: "url1" },
        { login: "carol", id: 3, contributions: 5, type: "User" as const, html_url: "url3" },
      ],
    };
    const out = aggregateContributors(perRepo, 5);
    expect(out.map((c) => c.login)).toEqual(["alice", "carol"]);
    expect(out[0].totalContributions).toBe(7);
    expect(out[0].perRepo).toEqual({ "a/r1": 4, "a/r2": 3 });
  });

  it("orders by totalContributions descending", () => {
    const perRepo = {
      "a/r": [
        { login: "low", id: 1, contributions: 5, type: "User" as const, html_url: "u" },
        { login: "high", id: 2, contributions: 100, type: "User" as const, html_url: "u" },
        { login: "mid", id: 3, contributions: 50, type: "User" as const, html_url: "u" },
      ],
    };
    const out = aggregateContributors(perRepo, 5);
    expect(out.map((c) => c.login)).toEqual(["high", "mid", "low"]);
  });

  it("returns empty when nothing meets the threshold", () => {
    const perRepo = {
      "a/r": [{ login: "x", id: 1, contributions: 1, type: "User" as const, html_url: "u" }],
    };
    expect(aggregateContributors(perRepo, 5)).toEqual([]);
  });

  it("handles empty per-repo map", () => {
    expect(aggregateContributors({}, 1)).toEqual([]);
  });
});

describe("buildProposals", () => {
  it("emits T1 + github-contributors source", () => {
    const proposals = buildProposals(TARGET, [
      {
        login: "alice",
        totalContributions: 50,
        perRepo: { "anthropics/anthropic-sdk-python": 50 },
        htmlUrl: "https://github.com/alice",
      },
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].tier).toBe("T1");
    expect(proposals[0].source).toBe("github-contributors:anthropic:alice");
    expect(proposals[0].recordType).toBe("personnel");
  });

  it("uses role=contributor / roleType=career (T1 seeding only)", () => {
    const [p] = buildProposals(TARGET, [
      { login: "alice", totalContributions: 50, perRepo: {}, htmlUrl: "u" },
    ]);
    expect(p.record.role).toBe("contributor");
    expect(p.record.roleType).toBe("career");
    expect(p.record.isFounder).toBe(false);
  });

  it("hashes the canonical record deterministically", () => {
    const a1 = buildProposals(TARGET, [
      { login: "x", totalContributions: 5, perRepo: { "r": 5 }, htmlUrl: "u" },
    ])[0];
    const a2 = buildProposals(TARGET, [
      { login: "x", totalContributions: 5, perRepo: { "r": 5 }, htmlUrl: "u" },
    ])[0];
    expect(a1.responseHash).toBe(a2.responseHash);
  });

  it("hash differs when commit counts differ", () => {
    const a = buildProposals(TARGET, [
      { login: "x", totalContributions: 5, perRepo: { "r": 5 }, htmlUrl: "u" },
    ])[0];
    const b = buildProposals(TARGET, [
      { login: "x", totalContributions: 6, perRepo: { "r": 6 }, htmlUrl: "u" },
    ])[0];
    expect(a.responseHash).not.toBe(b.responseHash);
  });

  it("entityRefs carry org slug + person login for resolver", () => {
    const [p] = buildProposals(TARGET, [
      { login: "alice", totalContributions: 5, perRepo: {}, htmlUrl: "u" },
    ]);
    expect(p.entityRefs).toEqual({ organization: "anthropic", person: "alice" });
  });
});

describe("importTarget", () => {
  it("aggregates across repos and emits proposals above threshold", async () => {
    const fetchImpl = makeFetch({
      "https://api.github.com/repos/anthropics/anthropic-sdk-python/contributors?per_page=100": {
        status: 200,
        body: [
          { login: "alice", id: 1, contributions: 8, type: "User", html_url: "u1" },
          { login: "carol", id: 3, contributions: 2, type: "User", html_url: "u3" },
        ],
      },
      "https://api.github.com/repos/anthropics/courses/contributors?per_page=100": {
        status: 200,
        body: [
          { login: "alice", id: 1, contributions: 3, type: "User", html_url: "u1" },
          { login: "carol", id: 3, contributions: 4, type: "User", html_url: "u3" },
        ],
      },
    });
    const out = await importTarget(TARGET, { fetchImpl });
    // alice: 11 (>=5), carol: 6 (>=5)
    expect(out.map((p) => (p.record.personDisplayName as string))).toEqual([
      "alice",
      "carol",
    ]);
  });

  it("skips broken repos and returns proposals from the others", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("anthropic-sdk-python")) {
        return { ok: false, status: 500, async json() { return {}; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return [{ login: "alice", id: 1, contributions: 100, type: "User", html_url: "u" }];
        },
      };
    }) as unknown as typeof fetch;
    const out = await importTarget(TARGET, { fetchImpl });
    expect(out).toHaveLength(1);
    expect((out[0].record.personDisplayName as string)).toBe("alice");
  });
});

describe("parseTargetsArg", () => {
  it("parses single repo", () => {
    expect(parseTargetsArg(["--target=anthropic:anthropics/sdk"])).toEqual([
      { orgSlug: "anthropic", orgName: "anthropic", repos: ["anthropics/sdk"] },
    ]);
  });
  it("parses multiple repos comma-separated", () => {
    const out = parseTargetsArg(["--target=anthropic:anthropics/a,anthropics/b"]);
    expect(out[0].repos).toEqual(["anthropics/a", "anthropics/b"]);
  });
  it("throws when repo is missing the slash", () => {
    expect(() => parseTargetsArg(["--target=anthropic:badrepo"])).toThrow(/owner\/repo/);
  });
  it("throws when repos list is empty", () => {
    expect(() => parseTargetsArg(["--target=anthropic:"])).toThrow();
  });
  it("throws when colon is missing", () => {
    expect(() => parseTargetsArg(["--target=anthropic"])).toThrow(/slug:owner\/repo/);
  });
});
