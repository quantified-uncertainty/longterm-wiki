import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockSearch = vi.fn();
const mockIssuesCreate = vi.fn();
const mockIssuesUpdate = vi.fn();
const mockIssuesCreateComment = vi.fn();

vi.mock("../github.js", () => ({
  getOctokit: () => ({
    rest: {
      search: { issuesAndPullRequests: mockSearch },
      issues: {
        create: mockIssuesCreate,
        update: mockIssuesUpdate,
        createComment: mockIssuesCreateComment,
      },
    },
  }),
  parseRepo: () => ({ owner: "test-owner", repo: "test-repo" }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { healthCheck } from "./health-check.js";
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
    circuitBreakerCooldownMs: 60_000,
    tasks: {
      healthCheck: { enabled: true, schedule: "*/5 * * * *" },
      resolveConflicts: { enabled: false, schedule: "0 */2 * * *" },
      codeReview: { enabled: false, schedule: "0 9 * * 1" },
      issueResponder: { enabled: false, schedule: "*/10 * * * *" },
    },
  };
}

const ISSUE_TITLE = "[Groundskeeper] Wiki server health check failure";

describe("healthCheck", () => {
  let config: Config;

  beforeEach(() => {
    config = makeConfig();
    vi.clearAllMocks();
  });

  describe("server is up", () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({ ok: true });
    });

    it("returns success when server is up and no open issue", async () => {
      mockSearch.mockResolvedValue({ data: { items: [] } });

      const result = await healthCheck(config);

      expect(result.success).toBe(true);
      expect(result.summary).toBe("Server up");
      expect(mockIssuesCreate).not.toHaveBeenCalled();
      expect(mockIssuesUpdate).not.toHaveBeenCalled();
    });

    it("closes existing open issue when server recovers", async () => {
      mockSearch.mockResolvedValue({
        data: {
          items: [{ number: 100, title: ISSUE_TITLE }],
        },
      });

      const result = await healthCheck(config);

      expect(result.success).toBe(true);
      expect(result.summary).toContain("closed issue #100");
      expect(mockIssuesUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 100,
          state: "closed",
          state_reason: "completed",
        })
      );
      expect(mockIssuesCreateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 100,
          body: expect.stringContaining("back up"),
        })
      );
    });
  });

  describe("server is down", () => {
    beforeEach(() => {
      mockFetch.mockRejectedValue(new Error("connection refused"));
    });

    it("adds comment to existing open issue instead of creating new one", async () => {
      // First search: open issues — finds one
      mockSearch.mockResolvedValueOnce({
        data: {
          items: [{ number: 200, title: ISSUE_TITLE }],
        },
      });

      const result = await healthCheck(config);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("updated issue #200");
      expect(mockIssuesCreate).not.toHaveBeenCalled();
      expect(mockIssuesCreateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 200,
          body: expect.stringContaining("still down"),
        })
      );
    });

    it("reopens recently-closed issue instead of creating new one", async () => {
      const closedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago

      // First search: open issues — none
      mockSearch.mockResolvedValueOnce({ data: { items: [] } });
      // Second search: closed issues — finds recently closed
      mockSearch.mockResolvedValueOnce({
        data: {
          items: [
            { number: 300, title: ISSUE_TITLE, closed_at: closedAt },
          ],
        },
      });

      const result = await healthCheck(config);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("reopened issue #300");
      expect(mockIssuesUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 300,
          state: "open",
        })
      );
      expect(mockIssuesCreateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 300,
          body: expect.stringContaining("down again"),
        })
      );
      expect(mockIssuesCreate).not.toHaveBeenCalled();
    });

    it("creates new issue when no open or recently-closed issue exists", async () => {
      // First search: open issues — none
      mockSearch.mockResolvedValueOnce({ data: { items: [] } });
      // Second search: closed issues — none matching
      mockSearch.mockResolvedValueOnce({ data: { items: [] } });

      mockIssuesCreate.mockResolvedValue({
        data: { number: 400 },
      });

      const result = await healthCheck(config);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("created issue #400");
      expect(mockIssuesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          title: ISSUE_TITLE,
          labels: ["groundskeeper"],
        })
      );
    });

    it("creates new issue when closed issue is older than 30 minutes", async () => {
      const closedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago

      // First search: open issues — none
      mockSearch.mockResolvedValueOnce({ data: { items: [] } });
      // Second search: closed issues — found but too old
      mockSearch.mockResolvedValueOnce({
        data: {
          items: [
            { number: 500, title: ISSUE_TITLE, closed_at: closedAt },
          ],
        },
      });

      mockIssuesCreate.mockResolvedValue({
        data: { number: 501 },
      });

      const result = await healthCheck(config);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("created issue #501");
      // Should NOT reopen the old issue
      expect(mockIssuesUpdate).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("ignores issues with non-matching title in search results", async () => {
      mockFetch.mockRejectedValue(new Error("connection refused"));

      // Search returns issues that don't exactly match the title
      mockSearch.mockResolvedValueOnce({
        data: {
          items: [
            { number: 600, title: "[Groundskeeper] Some other issue" },
          ],
        },
      });
      mockSearch.mockResolvedValueOnce({ data: { items: [] } });

      mockIssuesCreate.mockResolvedValue({
        data: { number: 601 },
      });

      const result = await healthCheck(config);

      // Should create a new issue since none matched the exact title
      expect(result.success).toBe(false);
      expect(result.summary).toContain("created issue #601");
    });

    it("handles fetch timeout gracefully", async () => {
      mockFetch.mockRejectedValue(new DOMException("signal timed out", "AbortError"));

      mockSearch.mockResolvedValueOnce({ data: { items: [] } });
      mockSearch.mockResolvedValueOnce({ data: { items: [] } });
      mockIssuesCreate.mockResolvedValue({ data: { number: 700 } });

      const result = await healthCheck(config);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("created issue #700");
    });
  });
});
