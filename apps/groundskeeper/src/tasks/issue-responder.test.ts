import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock the sleep utility to avoid real delays in tests
vi.mock("../sleep.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger to suppress noisy pino output during tests
vi.mock("../logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Mock Octokit responses
const mockAddLabels = vi.fn().mockResolvedValue({});
const mockRemoveLabel = vi.fn().mockResolvedValue({});
const mockCreateComment = vi.fn().mockResolvedValue({});
const mockGetIssue = vi.fn();
const mockListForRepo = vi.fn();
const mockListComments = vi.fn();
const mockListCommentsForRepo = vi.fn();
const mockGetLabel = vi.fn().mockResolvedValue({});
const mockCreateLabel = vi.fn().mockResolvedValue({});
const mockPullsGet = vi.fn();
const mockPullsList = vi.fn();
const mockPullsListReviews = vi.fn();
const mockPullsListReviewComments = vi.fn();

vi.mock("../github.js", () => ({
  getOctokit: () => ({
    rest: {
      issues: {
        listForRepo: (...args: unknown[]) => mockListForRepo(...args),
        get: (...args: unknown[]) => mockGetIssue(...args),
        addLabels: (...args: unknown[]) => mockAddLabels(...args),
        removeLabel: (...args: unknown[]) => mockRemoveLabel(...args),
        createComment: (...args: unknown[]) => mockCreateComment(...args),
        getLabel: (...args: unknown[]) => mockGetLabel(...args),
        createLabel: (...args: unknown[]) => mockCreateLabel(...args),
        listComments: (...args: unknown[]) => mockListComments(...args),
        listCommentsForRepo: (...args: unknown[]) =>
          mockListCommentsForRepo(...args),
      },
      pulls: {
        get: (...args: unknown[]) => mockPullsGet(...args),
        list: (...args: unknown[]) => mockPullsList(...args),
        listReviews: (...args: unknown[]) => mockPullsListReviews(...args),
        listReviewComments: (...args: unknown[]) =>
          mockPullsListReviewComments(...args),
      },
    },
  }),
  parseRepo: () => ({ owner: "test-owner", repo: "test-repo" }),
}));

const mockRunClaude = vi.fn().mockResolvedValue({
  success: true,
  output: "Done",
  durationMs: 1000,
});

vi.mock("../claude.js", () => ({
  runClaude: (...args: unknown[]) => mockRunClaude(...args),
}));

const mockSendDiscordNotification = vi.fn().mockResolvedValue(undefined);

vi.mock("../notify.js", () => ({
  sendDiscordNotification: (...args: unknown[]) =>
    mockSendDiscordNotification(...args),
}));

import { issueResponder } from "./issue-responder.js";
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
      issueResponder: { enabled: true, schedule: "*/10 * * * *" },
      githubShadowbanCheck: { enabled: false, schedule: "0 9 * * *", usernames: [] },
      snapshotRetention: { enabled: false, schedule: "0 3 * * *", keep: 100 },
      sessionSweep: { enabled: false, schedule: "0 */4 * * *" },
    },
  };
}

function makeIssue(
  number: number,
  labels: string[] = [],
  pullRequest: object | null = null
) {
  return {
    number,
    title: `Test issue #${number}`,
    body: "Fix this bug",
    labels: labels.map((name) => ({ name })),
    pull_request: pullRequest,
    state: "open",
  };
}

describe("issue-responder", () => {
  let config: Config;

  beforeEach(() => {
    config = makeConfig();
    // resetAllMocks clears both call history AND implementations,
    // preventing mock state from leaking between tests.
    vi.resetAllMocks();

    // Re-establish default behaviors after reset
    mockAddLabels.mockResolvedValue({});
    mockRemoveLabel.mockResolvedValue({});
    mockCreateComment.mockResolvedValue({});
    mockCreateLabel.mockResolvedValue({});
    // Default: no comment-triggered items
    mockListCommentsForRepo.mockResolvedValue({ data: [] });
    // Default: no existing PRs
    mockPullsList.mockResolvedValue({ data: [] });
    // Default: no concurrent claim comments (for claimItem verification)
    mockListComments.mockResolvedValue({ data: [] });
    // Default: label already exists (no create needed)
    mockGetLabel.mockResolvedValue({});
    // Default: Claude succeeds
    mockRunClaude.mockResolvedValue({
      success: true,
      output: "Done",
      durationMs: 1000,
    });
    mockSendDiscordNotification.mockResolvedValue(undefined);
  });

  describe("claim verification (race condition fix)", () => {
    it("adds label before spawning Claude and verifies claim", async () => {
      const issue = makeIssue(42, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });

      // After claiming, re-fetch returns our label
      mockGetIssue.mockResolvedValue({
        data: {
          ...issue,
          labels: [
            { name: "groundskeeper-autofix" },
            { name: "agent:working" },
          ],
        },
      });

      // No pre-existing groundskeeper comments (no concurrent claim)
      mockListComments.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);

      // Label should have been added
      expect(mockAddLabels).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42,
          labels: ["agent:working"],
        })
      );
    });

    it("aborts if another instance claimed the issue concurrently", async () => {
      const issue = makeIssue(42, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });

      // After we add the label, re-fetch shows the label is there
      mockGetIssue.mockResolvedValue({
        data: {
          ...issue,
          labels: [
            { name: "groundskeeper-autofix" },
            { name: "agent:working" },
          ],
        },
      });

      const now = new Date();
      // When we verify our claim, listComments returns TWO claim comments:
      // one from another instance (earlier) and one from us (later).
      // The earlier one wins, so we should back off.
      mockListComments.mockResolvedValue({
        data: [
          {
            id: 998,
            body: "<!-- groundskeeper-claim -->\nGroundskeeper is picking up this issue.",
            created_at: new Date(now.getTime() - 500).toISOString(),
            user: { login: "groundskeeper-bot[bot]", type: "Bot" },
          },
          {
            id: 999,
            body: "<!-- groundskeeper-claim -->\nGroundskeeper is picking up this issue.",
            created_at: now.toISOString(),
            user: { login: "groundskeeper-bot[bot]", type: "Bot" },
          },
        ],
      });

      const result = await issueResponder(config);

      // Should have detected the race and backed off
      expect(result.success).toBe(true);
      expect(result.summary).toContain("claimed by another instance");

      // Should have removed our label since we lost the race
      expect(mockRemoveLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42,
          name: "agent:working",
        })
      );
    });

    it("skips items that already have agent:working label", async () => {
      const issue = makeIssue(42, [
        "groundskeeper-autofix",
        "agent:working",
      ]);
      mockListForRepo.mockResolvedValue({ data: [issue] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("No issues to process");
      expect(mockAddLabels).not.toHaveBeenCalled();
    });
  });

  describe("label removal retry", () => {
    it("retries label removal on failure", async () => {
      const issue = makeIssue(42, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockGetIssue.mockResolvedValue({
        data: {
          ...issue,
          labels: [
            { name: "groundskeeper-autofix" },
            { name: "agent:working" },
          ],
        },
      });
      mockListComments.mockResolvedValue({ data: [] });

      // First removal fails, second succeeds
      mockRemoveLabel
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce({});

      const result = await issueResponder(config);
      expect(result.success).toBe(true);

      // Should have retried
      expect(mockRemoveLabel).toHaveBeenCalledTimes(2);
    });

    it("gives up after max retries but still reports success", async () => {
      const issue = makeIssue(42, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockGetIssue.mockResolvedValue({
        data: {
          ...issue,
          labels: [
            { name: "groundskeeper-autofix" },
            { name: "agent:working" },
          ],
        },
      });
      mockListComments.mockResolvedValue({ data: [] });

      // All removal attempts fail
      mockRemoveLabel.mockRejectedValue(new Error("API error"));

      const result = await issueResponder(config);
      expect(result.success).toBe(true);

      // Should have tried 3 times (initial + 2 retries)
      expect(mockRemoveLabel).toHaveBeenCalledTimes(3);
    });
  });

  describe("comment signature", () => {
    it("uses machine-parseable comment marker", async () => {
      const issue = makeIssue(42, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockGetIssue.mockResolvedValue({
        data: {
          ...issue,
          labels: [
            { name: "groundskeeper-autofix" },
            { name: "agent:working" },
          ],
        },
      });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      // The claim comment should use the machine-parseable marker
      const claimCall = mockCreateComment.mock.calls[0];
      expect(claimCall[0].body).toContain("<!-- groundskeeper-claim -->");
    });

    it("completion comment uses machine-parseable marker", async () => {
      const issue = makeIssue(42, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockGetIssue.mockResolvedValue({
        data: {
          ...issue,
          labels: [
            { name: "groundskeeper-autofix" },
            { name: "agent:working" },
          ],
        },
      });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      // The completion comment should also use the marker
      const completionCall = mockCreateComment.mock.calls[1];
      expect(completionCall[0].body).toContain(
        "<!-- groundskeeper-response -->"
      );
    });
  });

  describe("duplicate detection in comment-triggered items", () => {
    it("uses machine-parseable marker instead of bold text matching", async () => {
      // Set up: no labeled items, but a comment-triggered item
      mockListForRepo.mockResolvedValue({ data: [] });

      const now = new Date();
      const triggerComment = {
        id: 100,
        body: "/groundskeeper fix this please",
        created_at: now.toISOString(),
        issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/42",
        user: { login: "human-user", type: "User" },
      };

      mockListCommentsForRepo.mockResolvedValue({
        data: [triggerComment],
      });

      // The issue itself
      mockGetIssue.mockResolvedValue({
        data: makeIssue(42),
      });

      // Already responded with machine-parseable marker
      mockListComments.mockResolvedValue({
        data: [
          {
            id: 200,
            body: "<!-- groundskeeper-response -->\nGroundskeeper finished.",
            created_at: new Date(now.getTime() + 1000).toISOString(),
            user: { login: "groundskeeper-bot[bot]", type: "Bot" },
          },
        ],
      });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("No issues to process");
    });

    it("does not false-positive on user mentioning Groundskeeper in bold", async () => {
      // Set up: no labeled items, but a comment-triggered item
      mockListForRepo.mockResolvedValue({ data: [] });

      const now = new Date();
      const triggerComment = {
        id: 100,
        body: "/groundskeeper fix this please",
        created_at: now.toISOString(),
        issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/42",
        user: { login: "human-user", type: "User" },
      };

      mockListCommentsForRepo.mockResolvedValue({
        data: [triggerComment],
      });

      mockGetIssue.mockResolvedValue({
        data: makeIssue(42),
      });

      // A user comment mentions "**Groundskeeper**" in bold but is NOT a response
      mockListComments.mockResolvedValue({
        data: [
          {
            id: 201,
            body: "I heard **Groundskeeper** can fix this.",
            created_at: new Date(now.getTime() + 1000).toISOString(),
            user: { login: "another-user", type: "User" },
          },
        ],
      });

      // Since it's not a groundskeeper response (no marker), this item should be picked up
      // Then claimed and processed
      // After claiming, re-fetch shows label added
      mockGetIssue
        .mockResolvedValueOnce({ data: makeIssue(42) }) // for findCommentTriggeredItems
        .mockResolvedValueOnce({
          data: {
            ...makeIssue(42),
            labels: [{ name: "agent:working" }],
          },
        }); // for claim verification

      // No pre-existing groundskeeper claim comments
      mockListComments
        .mockResolvedValueOnce({
          data: [
            {
              id: 201,
              body: "I heard **Groundskeeper** can fix this.",
              created_at: new Date(now.getTime() + 1000).toISOString(),
              user: { login: "another-user", type: "User" },
            },
          ],
        }) // for findCommentTriggeredItems
        .mockResolvedValueOnce({ data: [] }); // for claim verification

      const result = await issueResponder(config);
      // Should have processed the item, not skipped it
      expect(result.success).toBe(true);
      expect(result.summary).not.toContain("No issues to process");
    });
  });

  describe("no work items", () => {
    it("returns success with summary when nothing to process", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("No issues to process");
    });
  });

  describe("rate limiting", () => {
    it("adds delay between sequential API calls in findLabeledItems", async () => {
      // Create multiple PR issues requiring pulls.get calls
      const issues = [
        makeIssue(1, ["groundskeeper-autofix"], { url: "..." }),
        makeIssue(2, ["groundskeeper-autofix"], { url: "..." }),
        makeIssue(3, ["groundskeeper-autofix"], { url: "..." }),
      ];
      mockListForRepo.mockResolvedValue({ data: issues });
      mockPullsGet.mockResolvedValue({
        data: { head: { ref: "fix-branch" } },
      });

      // PR review context mocks (needed because first item is a PR)
      mockPullsListReviews.mockResolvedValue({ data: [] });
      mockPullsListReviewComments.mockResolvedValue({ data: [] });

      // After claiming, re-fetch shows label added
      mockGetIssue.mockResolvedValue({
        data: {
          ...issues[0],
          labels: [
            { name: "groundskeeper-autofix" },
            { name: "agent:working" },
          ],
        },
      });
      mockListComments.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);

      // Should have called pulls.get for each PR issue (with delays between)
      expect(mockPullsGet).toHaveBeenCalledTimes(3);
    });
  });

  // ── findLabeledItems ────────────────────────────────────────────────────

  describe("findLabeledItems", () => {
    it("returns empty list when no issues have trigger label", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("No issues to process");
    });

    it("fetches PR branch when issue is a pull request", async () => {
      const prIssue = makeIssue(10, ["groundskeeper-autofix"], { url: "..." });
      mockListForRepo.mockResolvedValue({ data: [prIssue] });
      mockPullsGet.mockResolvedValue({
        data: { head: { ref: "feature/my-branch" } },
      });
      mockPullsListReviews.mockResolvedValue({ data: [] });
      mockPullsListReviewComments.mockResolvedValue({ data: [] });

      mockListComments.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);

      // Should have fetched the PR to get the branch ref
      expect(mockPullsGet).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 10 })
      );
    });

    it("filters out issues already labeled with agent:working", async () => {
      const workingIssue = makeIssue(20, [
        "groundskeeper-autofix",
        "agent:working",
      ]);
      const readyIssue = makeIssue(21, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({
        data: [workingIssue, readyIssue],
      });

      // Claim verification for issue 21
      mockListComments.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);

      // Should have picked up issue 21, not 20
      expect(result.summary).toContain("21");
    });

    it("handles labels as plain strings (not just objects)", async () => {
      // The GitHub API sometimes returns labels as strings
      const issue = {
        number: 30,
        title: "Test with string labels",
        body: "Fix this",
        labels: ["groundskeeper-autofix"] as (string | { name?: string })[],
        pull_request: null,
        state: "open",
      };
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockListComments.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toContain("30");
    });
  });

  // ── findCommentTriggeredItems ───────────────────────────────────────────

  describe("findCommentTriggeredItems", () => {
    it("ignores comments from bot users", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      mockListCommentsForRepo.mockResolvedValue({
        data: [
          {
            id: 1,
            body: "/groundskeeper do something",
            created_at: new Date().toISOString(),
            issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/42",
            user: { login: "groundskeeper-bot[bot]", type: "Bot" },
          },
        ],
      });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("No issues to process");
    });

    it("ignores comments that do not start with /groundskeeper", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      mockListCommentsForRepo.mockResolvedValue({
        data: [
          {
            id: 2,
            body: "Please ask /groundskeeper to fix this",
            created_at: new Date().toISOString(),
            issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/42",
            user: { login: "human-user", type: "User" },
          },
        ],
      });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("No issues to process");
    });

    it("skips comment-triggered items on closed issues", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      mockListCommentsForRepo.mockResolvedValue({
        data: [
          {
            id: 3,
            body: "/groundskeeper fix this",
            created_at: new Date().toISOString(),
            issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/50",
            user: { login: "human-user", type: "User" },
          },
        ],
      });

      // Issue is closed
      mockGetIssue.mockResolvedValue({
        data: {
          ...makeIssue(50),
          state: "closed",
        },
      });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("No issues to process");
    });

    it("deduplicates multiple trigger comments on same issue", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      const now = new Date();
      mockListCommentsForRepo.mockResolvedValue({
        data: [
          {
            id: 10,
            body: "/groundskeeper fix this",
            created_at: new Date(now.getTime() - 1000).toISOString(),
            issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/60",
            user: { login: "alice", type: "User" },
          },
          {
            id: 11,
            body: "/groundskeeper please fix",
            created_at: now.toISOString(),
            issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/60",
            user: { login: "bob", type: "User" },
          },
        ],
      });

      mockGetIssue.mockResolvedValue({
        data: makeIssue(60),
      });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      // Should have only called issues.get once for issue 60 (deduplication)
      expect(mockGetIssue).toHaveBeenCalledTimes(1);
      expect(mockGetIssue).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 60 })
      );
    });

    it("skips issue already labeled as being worked on via comment trigger", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      mockListCommentsForRepo.mockResolvedValue({
        data: [
          {
            id: 20,
            body: "/groundskeeper fix this",
            created_at: new Date().toISOString(),
            issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/70",
            user: { login: "alice", type: "User" },
          },
        ],
      });

      // Issue is already being worked on
      mockGetIssue.mockResolvedValue({
        data: makeIssue(70, ["agent:working"]),
      });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("No issues to process");
    });

    it("detects already-responded comments using machine-parseable marker", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      const triggerTime = new Date(Date.now() - 10000);
      mockListCommentsForRepo.mockResolvedValue({
        data: [
          {
            id: 30,
            body: "/groundskeeper fix this",
            created_at: triggerTime.toISOString(),
            issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/80",
            user: { login: "alice", type: "User" },
          },
        ],
      });

      mockGetIssue.mockResolvedValue({
        data: makeIssue(80),
      });

      // There's a response comment after the trigger
      mockListComments.mockResolvedValue({
        data: [
          {
            id: 31,
            body: "<!-- groundskeeper-response -->\n Done!",
            created_at: new Date().toISOString(),
            user: { login: "groundskeeper-bot[bot]", type: "Bot" },
          },
        ],
      });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("No issues to process");
    });

    it("fetches branch for PR comment-triggered items", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      mockListCommentsForRepo.mockResolvedValue({
        data: [
          {
            id: 40,
            body: "/groundskeeper address review comments",
            created_at: new Date().toISOString(),
            issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/90",
            user: { login: "alice", type: "User" },
          },
        ],
      });

      // Issue is a PR
      mockGetIssue.mockResolvedValue({
        data: makeIssue(90, [], { url: "..." }),
      });

      mockListComments.mockResolvedValue({ data: [] });

      // PR details
      mockPullsGet.mockResolvedValue({
        data: { head: { ref: "feature/pr-branch" } },
      });
      mockPullsListReviews.mockResolvedValue({ data: [] });
      mockPullsListReviewComments.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);

      // Should have fetched the PR branch
      expect(mockPullsGet).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 90 })
      );
    });
  });

  // ── Deduplication between label and comment triggers ───────────────────

  describe("deduplication between label and comment triggers", () => {
    it("labeled item takes priority over comment-triggered item for same issue", async () => {
      const issue = makeIssue(100, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });

      // Same issue also has a comment trigger
      mockListCommentsForRepo.mockResolvedValue({
        data: [
          {
            id: 50,
            body: "/groundskeeper also triggered via comment",
            created_at: new Date().toISOString(),
            issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/100",
            user: { login: "alice", type: "User" },
          },
        ],
      });

      mockGetIssue.mockResolvedValue({
        data: makeIssue(100),
      });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      // Issue 100 should appear only once in processing
      // The addLabels call will be for issue 100
      expect(mockAddLabels).toHaveBeenCalledTimes(1);
      expect(mockAddLabels).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 100 })
      );
    });

    it("processes only one item per cycle when multiple items are queued", async () => {
      const issue1 = makeIssue(1, ["groundskeeper-autofix"]);
      const issue2 = makeIssue(2, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue1, issue2] });

      mockListComments.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);

      // Only issue 1 (first item) should be claimed
      expect(mockAddLabels).toHaveBeenCalledTimes(1);
      expect(mockAddLabels).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 1 })
      );
    });
  });

  // ── hasLinkedClaudePR ──────────────────────────────────────────────────

  describe("hasLinkedClaudePR", () => {
    it("skips issue that already has a linked claude/ PR", async () => {
      const issue = makeIssue(200, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });

      // A claude/ PR exists that references this issue
      mockPullsList.mockResolvedValue({
        data: [
          {
            number: 999,
            head: { ref: "claude/fix-issue-200" },
            body: "Closes #200",
          },
        ],
      });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      expect(result.summary).toContain("already has a linked PR");
      expect(result.summary).toContain("200");

      // Should not have tried to claim the issue
      expect(mockAddLabels).not.toHaveBeenCalled();
    });

    it("does not skip issue when linked PR branch does not start with claude/", async () => {
      const issue = makeIssue(201, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });

      // A PR exists referencing the issue but NOT a claude/ branch
      mockPullsList.mockResolvedValue({
        data: [
          {
            number: 998,
            head: { ref: "fix/non-claude-branch" },
            body: "Closes #201",
          },
        ],
      });

      mockListComments.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);
      // Should have processed the issue (no skip)
      expect(result.summary).not.toContain("already has a linked PR");
    });

    it("does not check hasLinkedClaudePR for PR items", async () => {
      // PRs themselves don't need a linked PR check
      const prIssue = makeIssue(202, ["groundskeeper-autofix"], { url: "..." });
      mockListForRepo.mockResolvedValue({ data: [prIssue] });
      mockPullsGet.mockResolvedValue({
        data: { head: { ref: "feature/pr-to-fix" } },
      });
      mockPullsListReviews.mockResolvedValue({ data: [] });
      mockPullsListReviewComments.mockResolvedValue({ data: [] });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      // mockPullsList (for hasLinkedClaudePR) should NOT have been called for a PR item
      expect(mockPullsList).not.toHaveBeenCalled();
    });
  });

  // ── PR review context assembly ─────────────────────────────────────────

  describe("PR review context assembly", () => {
    it("includes CHANGES_REQUESTED review bodies in the Claude prompt", async () => {
      const prIssue = makeIssue(300, ["groundskeeper-autofix"], { url: "..." });
      mockListForRepo.mockResolvedValue({ data: [prIssue] });
      mockPullsGet.mockResolvedValue({
        data: { head: { ref: "feature/pr-branch" } },
      });

      // Review with CHANGES_REQUESTED
      mockPullsListReviews.mockResolvedValue({
        data: [
          {
            id: 1,
            state: "CHANGES_REQUESTED",
            body: "Please fix the formatting issue on line 42",
            user: { login: "reviewer-alice" },
          },
        ],
      });
      mockPullsListReviewComments.mockResolvedValue({ data: [] });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      // runClaude should have been called with prompt containing review context
      expect(mockRunClaude).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prompt: expect.stringContaining("reviewer-alice"),
        })
      );
      expect(mockRunClaude).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prompt: expect.stringContaining("Please fix the formatting issue"),
        })
      );
    });

    it("includes inline review comments in the Claude prompt", async () => {
      const prIssue = makeIssue(301, ["groundskeeper-autofix"], { url: "..." });
      mockListForRepo.mockResolvedValue({ data: [prIssue] });
      mockPullsGet.mockResolvedValue({
        data: { head: { ref: "feature/other-branch" } },
      });

      mockPullsListReviews.mockResolvedValue({ data: [] });
      mockPullsListReviewComments.mockResolvedValue({
        data: [
          {
            id: 100,
            path: "src/foo.ts",
            line: 15,
            original_line: 15,
            body: "This function should return null instead of undefined",
            user: { login: "bob" },
          },
        ],
      });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      expect(mockRunClaude).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prompt: expect.stringContaining("src/foo.ts"),
        })
      );
      expect(mockRunClaude).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prompt: expect.stringContaining(
            "This function should return null instead of undefined"
          ),
        })
      );
    });

    it("handles empty review context gracefully", async () => {
      const prIssue = makeIssue(302, ["groundskeeper-autofix"], { url: "..." });
      mockListForRepo.mockResolvedValue({ data: [prIssue] });
      mockPullsGet.mockResolvedValue({
        data: { head: { ref: "feature/empty-review" } },
      });

      mockPullsListReviews.mockResolvedValue({ data: [] });
      mockPullsListReviewComments.mockResolvedValue({ data: [] });
      mockListComments.mockResolvedValue({ data: [] });

      const result = await issueResponder(config);
      expect(result.success).toBe(true);

      // Prompt should still be built and runClaude called
      expect(mockRunClaude).toHaveBeenCalled();
      expect(mockRunClaude).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prompt: expect.stringContaining("(no review comments)"),
        })
      );
    });

    it("PR prompt includes the branch checkout instruction", async () => {
      const prIssue = makeIssue(303, ["groundskeeper-autofix"], { url: "..." });
      mockListForRepo.mockResolvedValue({ data: [prIssue] });
      mockPullsGet.mockResolvedValue({
        data: { head: { ref: "feature/specific-branch" } },
      });

      mockPullsListReviews.mockResolvedValue({ data: [] });
      mockPullsListReviewComments.mockResolvedValue({ data: [] });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      expect(mockRunClaude).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prompt: expect.stringContaining("feature/specific-branch"),
        })
      );
    });

    it("issue prompt includes branch creation instruction", async () => {
      const issue = makeIssue(304, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      expect(mockRunClaude).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prompt: expect.stringContaining("claude/fix-issue-304"),
        })
      );
    });

    it("issue prompt includes trigger comment when comment-triggered", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });

      const triggerComment = "/groundskeeper please update the docs section";
      mockListCommentsForRepo.mockResolvedValue({
        data: [
          {
            id: 200,
            body: triggerComment,
            created_at: new Date().toISOString(),
            issue_url: "https://api.github.com/repos/test-owner/test-repo/issues/305",
            user: { login: "alice", type: "User" },
          },
        ],
      });

      mockGetIssue.mockResolvedValue({
        data: makeIssue(305),
      });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      expect(mockRunClaude).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prompt: expect.stringContaining(
            "please update the docs section"
          ),
        })
      );
    });
  });

  // ── Claude Code failure handling ────────────────────────────────────────

  describe("Claude Code failure handling", () => {
    it("posts failure comment when Claude returns success: false", async () => {
      const issue = makeIssue(400, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockListComments.mockResolvedValue({ data: [] });

      mockRunClaude.mockResolvedValue({
        success: false,
        output: "Error: could not find relevant files",
        durationMs: 5000,
      });

      const result = await issueResponder(config);
      expect(result.success).toBe(false);
      expect(result.summary).toContain("Failed on");
      expect(result.summary).toContain("400");

      // Should post failure comment with response marker
      expect(mockCreateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 400,
          body: expect.stringContaining("<!-- groundskeeper-response -->"),
        })
      );
      expect(mockCreateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("could not resolve"),
        })
      );
    });

    it("removes working label even on Claude failure", async () => {
      const issue = makeIssue(401, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockListComments.mockResolvedValue({ data: [] });

      mockRunClaude.mockResolvedValue({
        success: false,
        output: "Timeout",
        durationMs: 600000,
      });

      await issueResponder(config);

      // Label should be removed regardless of Claude's outcome
      expect(mockRemoveLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 401,
          name: "agent:working",
        })
      );
    });

    it("sends Discord notification on failure", async () => {
      const issue = makeIssue(402, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockListComments.mockResolvedValue({ data: [] });

      mockRunClaude.mockResolvedValue({
        success: false,
        output: "Process crashed",
        durationMs: 2000,
      });

      await issueResponder(config);

      // Should have sent two Discord notifications: one on start, one on failure
      expect(mockSendDiscordNotification).toHaveBeenCalledTimes(2);
      const failureNotification = mockSendDiscordNotification.mock.calls[1][1];
      expect(failureNotification).toContain("❌");
      expect(failureNotification).toContain("402");
    });

    it("sends Discord notification on success", async () => {
      const issue = makeIssue(403, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockListComments.mockResolvedValue({ data: [] });

      mockRunClaude.mockResolvedValue({
        success: true,
        output: "PR created successfully",
        durationMs: 45000,
      });

      await issueResponder(config);

      // Should have sent two Discord notifications: one on start, one on success
      expect(mockSendDiscordNotification).toHaveBeenCalledTimes(2);
      const successNotification = mockSendDiscordNotification.mock.calls[1][1];
      expect(successNotification).toContain("✅");
      expect(successNotification).toContain("403");
    });

    it("truncates long Claude output in success comment", async () => {
      const issue = makeIssue(404, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockListComments.mockResolvedValue({ data: [] });

      const longOutput = "x".repeat(5000);
      mockRunClaude.mockResolvedValue({
        success: true,
        output: longOutput,
        durationMs: 30000,
      });

      await issueResponder(config);

      const commentCall = mockCreateComment.mock.calls.find(
        (call) =>
          call[0].body?.includes("<!-- groundskeeper-response -->") &&
          call[0].body?.includes("✅")
      );
      expect(commentCall).toBeDefined();
      expect(commentCall![0].body).toContain("truncated");
    });
  });

  // ── Daily AI cap enforcement ────────────────────────────────────────────

  describe("daily AI cap enforcement", () => {
    it("posts error comment when daily run cap is reached", async () => {
      const issue = makeIssue(500, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockListComments.mockResolvedValue({ data: [] });

      // runClaude returns the cap-reached result (as if isDailyCapReached returned true)
      mockRunClaude.mockResolvedValue({
        success: false,
        output: "Daily run cap reached",
        durationMs: 0,
      });

      const result = await issueResponder(config);
      expect(result.success).toBe(false);

      // Should still remove the label even when cap is reached
      expect(mockRemoveLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 500,
          name: "agent:working",
        })
      );
    });
  });

  // ── GitHub API error handling ──────────────────────────────────────────

  describe("GitHub API error handling", () => {
    it("propagates error when listForRepo fails", async () => {
      mockListForRepo.mockRejectedValue(new Error("GitHub API rate limited"));

      await expect(issueResponder(config)).rejects.toThrow(
        "GitHub API rate limited"
      );
    });

    it("propagates error when listCommentsForRepo fails", async () => {
      mockListForRepo.mockResolvedValue({ data: [] });
      mockListCommentsForRepo.mockRejectedValue(
        new Error("GitHub API unavailable")
      );

      await expect(issueResponder(config)).rejects.toThrow(
        "GitHub API unavailable"
      );
    });

    it("propagates error when addLabels fails during claim", async () => {
      const issue = makeIssue(600, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockAddLabels.mockRejectedValue(new Error("GitHub permissions error"));

      await expect(issueResponder(config)).rejects.toThrow(
        "GitHub permissions error"
      );
    });

    it("propagates error when getPRReviewContext API calls fail", async () => {
      const prIssue = makeIssue(601, ["groundskeeper-autofix"], { url: "..." });
      mockListForRepo.mockResolvedValue({ data: [prIssue] });
      mockPullsGet.mockResolvedValue({
        data: { head: { ref: "feature/branch" } },
      });
      mockListComments.mockResolvedValue({ data: [] });

      // listReviews throws
      mockPullsListReviews.mockRejectedValue(new Error("Review API error"));
      mockPullsListReviewComments.mockResolvedValue({ data: [] });

      await expect(issueResponder(config)).rejects.toThrow("Review API error");
    });
  });

  // ── ensureLabelExists ─────────────────────────────────────────────────

  describe("ensureLabelExists", () => {
    it("creates trigger label when it does not exist", async () => {
      // getLabel throws (label not found), so createLabel should be called
      mockGetLabel.mockRejectedValue(new Error("Label not found"));
      mockListForRepo.mockResolvedValue({ data: [] });

      await issueResponder(config);

      expect(mockCreateLabel).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "groundskeeper-autofix",
        })
      );
    });

    it("does not create label when it already exists", async () => {
      // getLabel succeeds (label exists)
      mockGetLabel.mockResolvedValue({ data: { name: "groundskeeper-autofix" } });
      mockListForRepo.mockResolvedValue({ data: [] });

      await issueResponder(config);

      expect(mockCreateLabel).not.toHaveBeenCalled();
    });
  });

  // ── PR vs issue prompt selection ───────────────────────────────────────

  describe("prompt selection based on item type", () => {
    it("uses issue prompt for regular issues (includes branch creation)", async () => {
      const issue = makeIssue(700, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      const prompt = mockRunClaude.mock.calls[0][1].prompt as string;
      // Issue prompt includes branch creation and PR creation steps
      expect(prompt).toContain("checkout -b claude/fix-issue-700");
      expect(prompt).toContain("gh pr create");
      // Issue prompt should NOT reference checking out an existing branch
      expect(prompt).not.toContain("git fetch origin");
    });

    it("uses PR prompt for pull requests (includes checkout instruction)", async () => {
      const prIssue = makeIssue(701, ["groundskeeper-autofix"], { url: "..." });
      mockListForRepo.mockResolvedValue({ data: [prIssue] });
      mockPullsGet.mockResolvedValue({
        data: { head: { ref: "feature/pr-to-fix-branch" } },
      });
      mockPullsListReviews.mockResolvedValue({ data: [] });
      mockPullsListReviewComments.mockResolvedValue({ data: [] });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      const prompt = mockRunClaude.mock.calls[0][1].prompt as string;
      // PR prompt includes checking out the existing branch
      expect(prompt).toContain("feature/pr-to-fix-branch");
      expect(prompt).toContain("git fetch origin");
      // PR prompt should NOT create a new branch
      expect(prompt).not.toContain("checkout -b claude/");
    });
  });

  // ── runClaude invocation parameters ───────────────────────────────────

  describe("runClaude invocation", () => {
    it("calls runClaude with 10-minute timeout and 30 max turns", async () => {
      const issue = makeIssue(800, ["groundskeeper-autofix"]);
      mockListForRepo.mockResolvedValue({ data: [issue] });
      mockListComments.mockResolvedValue({ data: [] });

      await issueResponder(config);

      expect(mockRunClaude).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          timeoutMs: 600_000,
          maxTurns: 30,
        })
      );
    });
  });
});
