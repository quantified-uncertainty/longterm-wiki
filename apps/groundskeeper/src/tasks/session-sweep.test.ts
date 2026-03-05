import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("../github.js", () => ({
  getOctokit: vi.fn(),
  parseRepo: vi.fn(() => ({ owner: "test-owner", repo: "test-repo" })),
}));

import { sessionSweep } from "./session-sweep.js";
import { getOctokit } from "../github.js";
import type { Config } from "../config.js";

function makeConfig(): Config {
  return {
    githubAppId: "test",
    githubInstallationId: "test",
    githubAppPrivateKey: "test",
    githubRepo: "test-owner/test-repo",
    wikiServerUrl: "http://localhost:3000",
    discordWebhookUrl: "http://localhost/webhook",
    dailyRunCap: 20,
    runLogPath: "/tmp/test-run-log.json",
    circuitBreakerCooldownMs: 1_800_000,
    tasks: {
      healthCheck: { enabled: true, schedule: "*/5 * * * *" },
      issueResponder: { enabled: false, schedule: "*/10 * * * *" },
      githubShadowbanCheck: { enabled: false, schedule: "0 9 * * *", usernames: [] },
      snapshotRetention: { enabled: false, schedule: "0 3 * * *", keep: 100 },
      sessionSweep: { enabled: true, schedule: "0 */4 * * *" },
    },
  };
}

/** Build a minimal mock Octokit with only the methods we need. */
function makeMockOctokit(issueState: "open" | "closed", labels: string[]) {
  return {
    rest: {
      issues: {
        get: vi.fn().mockResolvedValue({
          data: {
            state: issueState,
            labels: labels.map((name) => ({ name })),
          },
        }),
        removeLabel: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe("sessionSweep", () => {
  let config: Config;

  beforeEach(() => {
    config = makeConfig();
    process.env["WIKI_SERVER_API_KEY"] = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["WIKI_SERVER_API_KEY"];
  });

  it("returns success with no stale sessions message when swept=0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ swept: 0, sessions: [] }),
      })
    );

    const result = await sessionSweep(config);

    expect(result.success).toBe(true);
    expect(result.summary).toContain("No stale sessions");
  });

  it("calls correct sweep endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ swept: 0, sessions: [] }),
      })
    );

    await sessionSweep(config);

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe("http://localhost:3000/api/agent-sessions/sweep");
    expect((calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("returns failure when API key is not set", async () => {
    delete process.env["WIKI_SERVER_API_KEY"];

    const result = await sessionSweep(config);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("failed");
  });

  it("returns failure when sweep endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        text: async () => "Internal Server Error",
      })
    );

    const result = await sessionSweep(config);

    expect(result.success).toBe(false);
    expect(result.summary).toContain("failed");
  });

  it("returns success with no linked issues when sessions have no issueNumber", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          swept: 3,
          sessions: [
            { id: 1, branch: "claude/fix-a", issueNumber: null },
            { id: 2, branch: "claude/fix-b", issueNumber: null },
            { id: 3, branch: "claude/fix-c", issueNumber: null },
          ],
        }),
      })
    );

    const result = await sessionSweep(config);

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Swept 3");
    expect(result.summary).toContain("no linked issues");
  });

  it("removes claude-working label from closed issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          swept: 2,
          sessions: [
            { id: 1, branch: "claude/fix-a", issueNumber: 100 },
            { id: 2, branch: "claude/fix-b", issueNumber: 200 },
          ],
        }),
      })
    );

    const mockOctokit = makeMockOctokit("closed", ["claude-working", "bug"]);
    vi.mocked(getOctokit).mockReturnValue(mockOctokit as never);

    const result = await sessionSweep(config);

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Swept 2");
    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalledTimes(2);
    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      issue_number: 100,
      name: "claude-working",
    });
  });

  it("skips label removal for open issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          swept: 1,
          sessions: [{ id: 1, branch: "claude/fix-a", issueNumber: 100 }],
        }),
      })
    );

    const mockOctokit = makeMockOctokit("open", ["claude-working"]);
    vi.mocked(getOctokit).mockReturnValue(mockOctokit as never);

    const result = await sessionSweep(config);

    expect(result.success).toBe(true);
    expect(mockOctokit.rest.issues.removeLabel).not.toHaveBeenCalled();
  });

  it("skips label removal when issue lacks claude-working label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          swept: 1,
          sessions: [{ id: 1, branch: "claude/fix-a", issueNumber: 100 }],
        }),
      })
    );

    const mockOctokit = makeMockOctokit("closed", ["bug"]);
    vi.mocked(getOctokit).mockReturnValue(mockOctokit as never);

    const result = await sessionSweep(config);

    expect(result.success).toBe(true);
    expect(mockOctokit.rest.issues.removeLabel).not.toHaveBeenCalled();
  });

  it("deduplicates issue numbers before cleaning labels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          swept: 3,
          sessions: [
            { id: 1, branch: "claude/fix-a", issueNumber: 100 },
            { id: 2, branch: "claude/fix-b", issueNumber: 100 }, // duplicate
            { id: 3, branch: "claude/fix-c", issueNumber: 200 },
          ],
        }),
      })
    );

    const mockOctokit = makeMockOctokit("closed", ["claude-working"]);
    vi.mocked(getOctokit).mockReturnValue(mockOctokit as never);

    const result = await sessionSweep(config);

    expect(result.success).toBe(true);
    // Issue 100 should only be processed once despite appearing twice
    expect(mockOctokit.rest.issues.get).toHaveBeenCalledTimes(2);
    expect(mockOctokit.rest.issues.removeLabel).toHaveBeenCalledTimes(2);
  });

  it("returns failure when label removal errors occur", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          swept: 1,
          sessions: [{ id: 1, branch: "claude/fix-a", issueNumber: 100 }],
        }),
      })
    );

    const mockOctokit = {
      rest: {
        issues: {
          get: vi.fn().mockRejectedValue(new Error("GitHub API error")),
          removeLabel: vi.fn(),
        },
      },
    };
    vi.mocked(getOctokit).mockReturnValue(mockOctokit as never);

    const result = await sessionSweep(config);

    // Sweep itself succeeded, but label cleanup had an error
    expect(result.success).toBe(false);
    expect(result.summary).toContain("error");
  });
});
