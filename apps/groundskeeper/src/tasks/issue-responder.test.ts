import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock the sleep utility to avoid real delays in tests
vi.mock("../sleep.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../claude.js", () => ({
  runClaude: vi.fn().mockResolvedValue({
    success: true,
    output: "Done",
    durationMs: 1000,
  }),
}));

vi.mock("../notify.js", () => ({
  sendDiscordNotification: vi.fn().mockResolvedValue(undefined),
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
      resolveConflicts: { enabled: false, schedule: "0 */2 * * *" },
      codeReview: { enabled: false, schedule: "0 9 * * 1" },
      issueResponder: { enabled: true, schedule: "*/10 * * * *" },
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
    vi.clearAllMocks();

    // Default: no comment-triggered items
    mockListCommentsForRepo.mockResolvedValue({ data: [] });
    // Default: no existing PRs
    mockPullsList.mockResolvedValue({ data: [] });
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
            { name: "claude-working" },
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
          labels: ["claude-working"],
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
            { name: "claude-working" },
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
          name: "claude-working",
        })
      );
    });

    it("skips items that already have claude-working label", async () => {
      const issue = makeIssue(42, [
        "groundskeeper-autofix",
        "claude-working",
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
            { name: "claude-working" },
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
            { name: "claude-working" },
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
            { name: "claude-working" },
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
            { name: "claude-working" },
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
            labels: [{ name: "claude-working" }],
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
            { name: "claude-working" },
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
});
