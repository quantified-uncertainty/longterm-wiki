import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockOctokit = {
  rest: {
    search: {
      issuesAndPullRequests: vi.fn(),
    },
    issues: {
      create: vi.fn(),
      update: vi.fn(),
      createComment: vi.fn(),
      listComments: vi.fn(),
    },
  },
};

vi.mock("../github.js", () => ({
  getOctokit: () => mockOctokit,
  parseRepo: () => ({ owner: "test-owner", repo: "test-repo" }),
}));

vi.mock("../wiki-server.js", () => ({
  recordIncident: vi.fn().mockResolvedValue(true),
}));

vi.mock("../incident-buffer.js", () => ({
  recordFailure: vi.fn(),
  getCurrentOutage: vi.fn().mockReturnValue(null),
  clearOutage: vi.fn(),
  addToBuffer: vi.fn(),
  flushBuffer: vi.fn().mockResolvedValue(0),
  backfillOutageIncident: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  healthCheck,
  COMMENT_COOLDOWN_MS,
  CONSECUTIVE_FAILURES_THRESHOLD,
  _resetIssueCreationLock,
  _resetConsecutiveFailures,
  _getConsecutiveFailures,
} from "./health-check.js";
import type { Config } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<Config>): Config {
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
    },
    ...overrides,
  };
}

const EXISTING_ISSUE = {
  number: 42,
  title: "[Groundskeeper] Wiki server health check failure",
};

function mockServerDown() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Connection refused"))
  );
}

function mockServerUp() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true })
  );
}

/** Run healthCheck enough times to exceed the consecutive failure threshold. */
async function exceedFailureThreshold(cfg: Config) {
  for (let i = 0; i < CONSECUTIVE_FAILURES_THRESHOLD; i++) {
    await healthCheck(cfg);
  }
}

function mockNoOpenIssue() {
  mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValue({
    data: { items: [] },
  });
}

function mockExistingOpenIssue() {
  mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValue({
    data: { items: [EXISTING_ISSUE] },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("healthCheck", () => {
  let config: Config;

  beforeEach(() => {
    config = makeConfig();
    vi.clearAllMocks();
    _resetIssueCreationLock();
    _resetConsecutiveFailures();
    // Default: issues.create returns a valid response
    mockOctokit.rest.issues.create.mockResolvedValue({
      data: { number: 99 },
    });
    mockOctokit.rest.issues.update.mockResolvedValue({});
    mockOctokit.rest.issues.createComment.mockResolvedValue({});
    mockOctokit.rest.issues.listComments.mockResolvedValue({
      data: [],
    });
  });

  // -----------------------------------------------------------------------
  // Server up
  // -----------------------------------------------------------------------

  describe("when server is up", () => {
    beforeEach(() => mockServerUp());

    it("returns success when server is healthy and no open issue", async () => {
      mockNoOpenIssue();
      const result = await healthCheck(config);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("Server up");
    });

    it("closes an existing open issue when server recovers", async () => {
      mockExistingOpenIssue();
      const result = await healthCheck(config);

      expect(result.success).toBe(true);
      expect(result.summary).toContain("closed issue #42");

      expect(mockOctokit.rest.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42,
          state: "closed",
          state_reason: "completed",
        })
      );

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42,
          body: expect.stringContaining("back up"),
        })
      );
    });

    it("handles failure to close issue gracefully", async () => {
      mockExistingOpenIssue();
      mockOctokit.rest.issues.update.mockRejectedValue(
        new Error("GitHub 500")
      );

      const result = await healthCheck(config);
      // Should still succeed — the server IS up
      expect(result.success).toBe(true);
    });

    it("handles failure to post recovery comment gracefully", async () => {
      mockExistingOpenIssue();
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        new Error("GitHub 500")
      );

      const result = await healthCheck(config);
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Server down — new issue creation
  // -----------------------------------------------------------------------

  describe("when server is down and no existing issue", () => {
    beforeEach(() => {
      mockServerDown();
      mockNoOpenIssue();
    });

    it("does not create an issue below the consecutive failure threshold", async () => {
      const result = await healthCheck(config);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("waiting before escalating");
      expect(mockOctokit.rest.issues.create).not.toHaveBeenCalled();
    });

    it("creates a new issue after reaching the consecutive failure threshold", async () => {
      // First N-1 calls build up the counter
      await exceedFailureThreshold(config);
      // The Nth call should trigger issue creation
      const result = await healthCheck(config);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("created issue #99");
      expect(mockOctokit.rest.issues.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "[Groundskeeper] Wiki server health check failure",
          labels: ["groundskeeper"],
        })
      );
    });

    it("handles issue creation failure gracefully", async () => {
      mockOctokit.rest.issues.create.mockRejectedValue(
        new Error("GitHub 500")
      );

      await exceedFailureThreshold(config);
      const result = await healthCheck(config);
      expect(result.success).toBe(false);
      expect(result.summary).toContain("failed to create issue");
    });
  });

  // -----------------------------------------------------------------------
  // Server down — existing issue, comment rate-limiting
  // -----------------------------------------------------------------------

  describe("when server is down and issue already exists", () => {
    beforeEach(async () => {
      mockServerDown();
      mockNoOpenIssue();
      // Build up consecutive failures past the threshold first
      await exceedFailureThreshold(config);
      // Now switch to existing issue for the actual test calls
      mockExistingOpenIssue();
    });

    it("posts a 'still down' comment when no previous comments exist", async () => {
      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [],
      });

      const result = await healthCheck(config);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("comment posted");
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42,
          body: expect.stringContaining("still down"),
        })
      );
    });

    it("rate-limits comments when a recent comment exists within cooldown window", async () => {
      // The `since` param filters server-side; a non-empty response means
      // a comment exists within the cooldown window.
      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [{ created_at: new Date().toISOString() }],
      });

      const result = await healthCheck(config);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("comment rate-limited");
      // createComment may have been called during exceedFailureThreshold,
      // so check the last call behavior via summary instead
    });

    it("posts a comment when no comments exist within cooldown window", async () => {
      // The `since` param filters server-side; an empty response means
      // no comment was posted within the cooldown window.
      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [],
      });

      const result = await healthCheck(config);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("comment posted");
    });

    it("handles 'still down' comment failure gracefully", async () => {
      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [],
      });
      mockOctokit.rest.issues.createComment.mockRejectedValue(
        new Error("GitHub 500")
      );

      const result = await healthCheck(config);
      // Should not throw — failure is caught
      expect(result.success).toBe(false);
      expect(result.summary).toContain("issue #42");
    });

    it("handles listComments failure gracefully and allows commenting", async () => {
      mockOctokit.rest.issues.listComments.mockRejectedValue(
        new Error("GitHub 500")
      );

      const result = await healthCheck(config);
      // When we can't check last comment time, allow the comment
      expect(result.success).toBe(false);
      expect(result.summary).toContain("comment posted");
    });
  });

  // -----------------------------------------------------------------------
  // Race condition prevention
  // -----------------------------------------------------------------------

  describe("parallel issue creation guard", () => {
    it("prevents duplicate issue creation from concurrent runs", async () => {
      mockServerDown();
      mockNoOpenIssue();

      // Exceed failure threshold first so concurrent runs will try to create issues
      await exceedFailureThreshold(config);

      // Slow down the first issue creation so both runs overlap
      let resolveCreate:
        | ((val: { data: { number: number } }) => void)
        | undefined;
      let createCallCount = 0;

      mockOctokit.rest.issues.create.mockImplementation(() => {
        createCallCount++;
        if (createCallCount === 1) {
          return new Promise((resolve) => {
            resolveCreate = resolve;
          });
        }
        return Promise.resolve({ data: { number: 100 } });
      });

      // Start two health checks concurrently
      const run1 = healthCheck(config);
      const run2 = healthCheck(config);

      // Wait for the second to complete (it should see the lock and bail)
      const result2 = await run2;
      expect(result2.success).toBe(false);
      expect(result2.summary).toContain("issue creation in progress");

      // Now let the first complete
      resolveCreate?.({ data: { number: 99 } });
      const result1 = await run1;
      expect(result1.success).toBe(false);
      expect(result1.summary).toContain("created issue #99");

      // Only one issue.create call should have been made
      expect(createCallCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // GitHub search failure
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Consecutive failure threshold
  // -----------------------------------------------------------------------

  describe("consecutive failure threshold", () => {
    it("resets consecutive failures when server recovers", async () => {
      mockServerDown();
      mockNoOpenIssue();

      // Accumulate some failures
      await healthCheck(config);
      await healthCheck(config);
      expect(_getConsecutiveFailures()).toBe(2);

      // Server recovers
      mockServerUp();
      mockNoOpenIssue();
      await healthCheck(config);
      expect(_getConsecutiveFailures()).toBe(0);
    });

    it("tracks consecutive failures across calls", async () => {
      mockServerDown();
      mockNoOpenIssue();

      for (let i = 1; i <= CONSECUTIVE_FAILURES_THRESHOLD; i++) {
        await healthCheck(config);
        expect(_getConsecutiveFailures()).toBe(i);
      }
    });
  });

  // -----------------------------------------------------------------------
  // GitHub search failure
  // -----------------------------------------------------------------------

  describe("findOpenHealthIssue failure", () => {
    it("handles search API failure gracefully", async () => {
      mockServerDown();
      mockOctokit.rest.search.issuesAndPullRequests.mockRejectedValue(
        new Error("GitHub search down")
      );

      const result = await healthCheck(config);
      expect(result.success).toBe(false);
      expect(result.summary).toContain("failed to check for existing issue");
    });
  });
});
