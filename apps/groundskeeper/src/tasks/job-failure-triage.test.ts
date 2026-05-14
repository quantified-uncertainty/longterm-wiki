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
      getLabel: vi.fn(),
      createLabel: vi.fn(),
      createComment: vi.fn(),
      listComments: vi.fn(),
    },
  },
};

vi.mock("../github.js", () => ({
  getOctokit: () => mockOctokit,
  parseRepo: () => ({ owner: "test-owner", repo: "test-repo" }),
}));

const mockApiRequest = vi.fn();

vi.mock("../wiki-server.js", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { jobFailureTriage } from "./job-failure-triage.js";
import type { Config } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      githubShadowbanCheck: {
        enabled: false,
        schedule: "0 9 * * *",
        usernames: [],
      },
      snapshotRetention: { enabled: false, schedule: "0 3 * * *", keep: 100 },
      sessionSweep: { enabled: false, schedule: "0 */4 * * *" },
      activeAgentsSweep: { enabled: false, schedule: "*/30 * * * *" },
      dataQualitySnapshot: { enabled: false, schedule: "0 6 * * *" },
      jobWorkerHealth: { enabled: false, schedule: "*/5 * * * *" },
      autoUpdateEnqueue: {
        enabled: false,
        schedule: "0 6 * * *",
        budget: 30,
        maxPages: 5,
      },
      backfillSourcesEnqueue: { enabled: false, schedule: "0 2 * * *", limit: 100, maxCost: 5 },
      jobFailureTriage: { enabled: true, schedule: "0 */6 * * *" },
      tablebaseScan: { enabled: false, schedule: "0 5 * * *" },
      e2ePostDeployWatcher: { enabled: false, schedule: "15 * * * *" },
      thingsSearchRefresh: { enabled: false, schedule: "25 * * * *" },
    },
  };
}

const SAMPLE_PATTERN = {
  type: "resource-ingest",
  errorPattern: "Resources snapshot not found at /data/resources-snapshot.json",
  count: 15,
  firstSeen: "2026-04-01T00:00:00Z",
  lastSeen: "2026-04-01T23:00:00Z",
  sampleJobIds: [100, 101, 102, 103, 104],
};

const SAMPLE_PATTERN_2 = {
  type: "resource-verify",
  errorPattern: "Unknown job type: resource-verify",
  count: 5,
  firstSeen: "2026-04-01T12:00:00Z",
  lastSeen: "2026-04-01T23:30:00Z",
  sampleJobIds: [200, 201, 202],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("jobFailureTriage", () => {
  it("returns success with no patterns when wiki-server reports none", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { patterns: [], hours: 24, minCount: 3 },
    });

    const result = await jobFailureTriage(makeConfig());

    expect(result.success).toBe(true);
    expect(result.summary).toContain("No recurring failure patterns");
  });

  it("returns success when wiki-server is unreachable", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: "Connection refused",
    });

    const result = await jobFailureTriage(makeConfig());

    // Should not trip circuit breaker
    expect(result.success).toBe(true);
    expect(result.summary).toContain("Could not reach wiki-server");
  });

  it("creates a new GitHub issue for a novel failure pattern", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { patterns: [SAMPLE_PATTERN], hours: 24, minCount: 3 },
    });

    // No existing issues found
    mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: { items: [] },
    });

    // Label exists
    mockOctokit.rest.issues.getLabel.mockResolvedValueOnce({});

    // Issue creation succeeds
    mockOctokit.rest.issues.create.mockResolvedValueOnce({
      data: { number: 999 },
    });

    const result = await jobFailureTriage(makeConfig());

    expect(result.success).toBe(true);
    expect(result.summary).toContain("1 issue(s) created");

    // Verify issue was created with correct content
    const createCall = mockOctokit.rest.issues.create.mock.calls[0][0];
    expect(createCall.title).toContain("[Job Failure] resource-ingest");
    expect(createCall.title).toContain("Resources snapshot not found");
    expect(createCall.body).toContain("resource-ingest");
    expect(createCall.body).toContain("15");
    expect(createCall.body).toContain("100, 101, 102, 103, 104");
    expect(createCall.labels).toContain("job-failure");
    expect(createCall.labels).toContain("groundskeeper");
  });

  it("posts a 'still failing' comment on an existing open issue", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { patterns: [SAMPLE_PATTERN], hours: 24, minCount: 3 },
    });

    // Existing issue found
    mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: {
        items: [
          {
            number: 42,
            title: "[Job Failure] resource-ingest: Resources snapshot not found at /data/resources-snapshot.json",
            body: "**Error pattern:** `Resources snapshot not found at /data/resources-snapshot.json`",
          },
        ],
      },
    });

    // No recent comments
    mockOctokit.rest.issues.listComments.mockResolvedValueOnce({
      data: [],
    });

    // Comment succeeds
    mockOctokit.rest.issues.createComment.mockResolvedValueOnce({});

    const result = await jobFailureTriage(makeConfig());

    expect(result.success).toBe(true);
    expect(result.summary).toContain("1 issue(s) updated");

    // Verify comment was posted
    const commentCall =
      mockOctokit.rest.issues.createComment.mock.calls[0][0];
    expect(commentCall.issue_number).toBe(42);
    expect(commentCall.body).toContain("Still failing");
    expect(commentCall.body).toContain("15");
  });

  it("skips comment if existing issue has a recent comment", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { patterns: [SAMPLE_PATTERN], hours: 24, minCount: 3 },
    });

    // Existing issue found
    mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: {
        items: [
          {
            number: 42,
            title: "[Job Failure] resource-ingest: Resources snapshot not found at /data/resources-snapshot.json",
            body: "**Error pattern:** `Resources snapshot not found at /data/resources-snapshot.json`",
          },
        ],
      },
    });

    // Recent comment exists
    mockOctokit.rest.issues.listComments.mockResolvedValueOnce({
      data: [{ id: 1, body: "Still failing" }],
    });

    const result = await jobFailureTriage(makeConfig());

    expect(result.success).toBe(true);
    expect(result.summary).toContain("1 skipped");
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("respects MAX_ISSUES_PER_RUN cap", async () => {
    const patterns = Array.from({ length: 5 }, (_, i) => ({
      ...SAMPLE_PATTERN,
      type: `type-${i}`,
      errorPattern: `Error ${i}: something went wrong in handler type-${i}`,
    }));

    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { patterns, hours: 24, minCount: 3 },
    });

    // No existing issues for any pattern
    for (let i = 0; i < 5; i++) {
      mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValueOnce({
        data: { items: [] },
      });
    }

    // Label exists for all
    mockOctokit.rest.issues.getLabel.mockResolvedValue({});

    // All issue creations succeed
    mockOctokit.rest.issues.create.mockResolvedValue({
      data: { number: 100 },
    });

    const result = await jobFailureTriage(makeConfig());

    expect(result.success).toBe(true);
    // Only 3 issues created (MAX_ISSUES_PER_RUN), 2 skipped
    expect(mockOctokit.rest.issues.create).toHaveBeenCalledTimes(3);
    expect(result.summary).toContain("3 issue(s) created");
    expect(result.summary).toContain("2 skipped");
  });

  it("creates label if it does not exist", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: { patterns: [SAMPLE_PATTERN], hours: 24, minCount: 3 },
    });

    mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: { items: [] },
    });

    // Label does NOT exist — getLabel throws 404
    mockOctokit.rest.issues.getLabel.mockRejectedValueOnce(
      new Error("Not Found")
    );

    // Label creation succeeds
    mockOctokit.rest.issues.createLabel.mockResolvedValueOnce({});

    // Issue creation succeeds
    mockOctokit.rest.issues.create.mockResolvedValueOnce({
      data: { number: 999 },
    });

    const result = await jobFailureTriage(makeConfig());

    expect(result.success).toBe(true);
    expect(mockOctokit.rest.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "job-failure",
        color: "d93f0b",
      })
    );
  });


  it("logs warning and continues when GitHub issue creation fails", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        patterns: [SAMPLE_PATTERN, SAMPLE_PATTERN_2],
        hours: 24,
        minCount: 3,
      },
    });

    // First pattern: no existing issue → creation will fail
    mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: { items: [] },
    });
    mockOctokit.rest.issues.getLabel.mockResolvedValueOnce({});
    mockOctokit.rest.issues.create.mockRejectedValueOnce(
      new Error("GitHub API rate limit exceeded")
    );

    // Second pattern: no existing issue → creation succeeds
    mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: { items: [] },
    });
    mockOctokit.rest.issues.getLabel.mockResolvedValueOnce({});
    mockOctokit.rest.issues.create.mockResolvedValueOnce({
      data: { number: 500 },
    });

    const result = await jobFailureTriage(makeConfig());

    // First pattern failed, second succeeded — overall has errors
    expect(result.success).toBe(false);
    expect(result.summary).toContain("1 issue(s) created");
    expect(result.summary).toContain("1 error(s)");

    // Issue creation was attempted for both patterns
    expect(mockOctokit.rest.issues.create).toHaveBeenCalledTimes(2);
  });

  it("logs error and continues when GitHub search fails", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        patterns: [SAMPLE_PATTERN, SAMPLE_PATTERN_2],
        hours: 24,
        minCount: 3,
      },
    });

    // First pattern: search throws → caught by outer try/catch, pattern skipped
    mockOctokit.rest.search.issuesAndPullRequests.mockRejectedValueOnce(
      new Error("GitHub search API unavailable")
    );

    // Second pattern: search succeeds, no existing issue, creation succeeds
    mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: { items: [] },
    });
    mockOctokit.rest.issues.getLabel.mockResolvedValueOnce({});
    mockOctokit.rest.issues.create.mockResolvedValueOnce({
      data: { number: 501 },
    });

    const result = await jobFailureTriage(makeConfig());

    // First pattern errored, second succeeded
    expect(result.success).toBe(false);
    expect(result.summary).toContain("1 issue(s) created");
    expect(result.summary).toContain("1 error(s)");

    // Issue was only created for the second pattern (search failure skips the first)
    expect(mockOctokit.rest.issues.create).toHaveBeenCalledTimes(1);
  });
  it("handles multiple patterns — mix of new and existing issues", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        patterns: [SAMPLE_PATTERN, SAMPLE_PATTERN_2],
        hours: 24,
        minCount: 3,
      },
    });

    // First pattern: existing issue found
    mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: {
        items: [
          {
            number: 42,
            title: "[Job Failure] resource-ingest: Resources snapshot not found at /data/resources-snapshot.json",
            body: "**Error pattern:** `Resources snapshot not found at /data/resources-snapshot.json`",
          },
        ],
      },
    });

    // No recent comments on existing issue
    mockOctokit.rest.issues.listComments.mockResolvedValueOnce({
      data: [],
    });

    // Comment on existing issue
    mockOctokit.rest.issues.createComment.mockResolvedValueOnce({});

    // Second pattern: no existing issue
    mockOctokit.rest.search.issuesAndPullRequests.mockResolvedValueOnce({
      data: { items: [] },
    });

    // Label exists
    mockOctokit.rest.issues.getLabel.mockResolvedValueOnce({});

    // New issue created
    mockOctokit.rest.issues.create.mockResolvedValueOnce({
      data: { number: 999 },
    });

    const result = await jobFailureTriage(makeConfig());

    expect(result.success).toBe(true);
    expect(result.summary).toContain("1 issue(s) created");
    expect(result.summary).toContain("1 issue(s) updated");
  });
});
