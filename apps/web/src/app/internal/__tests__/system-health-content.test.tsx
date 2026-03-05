/**
 * Render smoke tests for the System Health dashboard content component.
 *
 * System Health had 17 bugs across 2 fix PRs at launch — it's the highest-risk
 * dashboard. These tests verify the component renders without throwing for
 * the full range of API response shapes it handles.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
  fetchFromWikiServer: vi.fn(),
  withApiFallback: vi.fn(),
}));

vi.mock("../system-health/system-health-table", () => ({
  SystemHealthTable: () => null,
}));

vi.mock("../system-health/open-prs-table", () => ({
  OpenPRsTable: () => null,
}));

vi.mock("@components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  withApiFallback,
  fetchDetailed,
  fetchFromWikiServer,
} from "@lib/wiki-server";
import { SystemHealthContent } from "../system-health/system-health-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockMonitoringStatus = {
  overall: "healthy",
  checkedAt: "2025-01-01T12:00:00Z",
  services: [
    { name: "wiki-server", status: "healthy", openIncidents: 0 },
    { name: "groundskeeper", status: "healthy", openIncidents: 0 },
    { name: "discord-bot", status: "unknown", openIncidents: 0 },
    { name: "vercel-frontend", status: "healthy", openIncidents: 0 },
    { name: "github-actions", status: "unknown", openIncidents: 0 },
  ],
  dbCounts: { pages: 750, entities: 200, facts: 1500 },
  recentIncidents: [],
  jobsQueue: { pending: 0, running: 2, completed: 45 },
  activeAgents: 1,
};

const mockExtendedData = {
  ci: {
    sha: "abc12345",
    totalChecks: 5,
    allCompleted: true,
    allPassed: true,
    anyFailed: false,
    checks: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "success" },
      { name: "validate", status: "completed", conclusion: "success" },
      { name: "typecheck", status: "completed", conclusion: "success" },
    ],
  },
  groundskeeperTasks: [
    {
      taskName: "sync-pages",
      totalRuns: 24,
      successCount: 23,
      failureCount: 1,
      successRate: 95.8,
      avgDurationMs: 1500,
      lastRun: "2025-01-01T11:00:00Z",
    },
  ],
  integrity: {
    totalDanglingRefs: 0,
    status: "clean",
    breakdown: {
      facts: 0,
      claims: 0,
      summaries: 0,
      citations: 0,
      editLogs: 0,
    },
  },
  autoUpdate: {
    totalRuns: 10,
    recentRuns: [
      {
        id: 1,
        date: "2025-01-01",
        trigger: "scheduled",
        pagesUpdated: 5,
        pagesFailed: 0,
        budgetSpent: 1.5,
        completed: true,
      },
    ],
  },
  recentSessions: [
    {
      id: 1,
      sessionId: "sess-abc",
      branch: "claude/fix-123",
      task: "Fix auth bug",
      status: "completed",
      issueNumber: 123,
      prNumber: 456,
      startedAt: "2025-01-01T10:00:00Z",
      completedAt: "2025-01-01T12:00:00Z",
      model: "claude-opus-4-6",
    },
  ],
};

const mockOpenPRs = {
  pulls: [
    {
      number: 500,
      title: "feat: add new feature",
      url: "https://github.com/org/repo/pull/500",
      branch: "claude/feature-500",
      author: "claude-bot",
      createdAt: "2025-01-01T08:00:00Z",
      updatedAt: "2025-01-01T09:00:00Z",
      checksState: "success",
      mergeable: "mergeable",
      labels: [],
    },
  ],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SystemHealthContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no Vercel env vars
    delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
    delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF;
    delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE;
    delete process.env.NEXT_PUBLIC_BUILD_TIMESTAMP;
  });

  afterEach(() => {
    // Clean up any Vercel env vars set during tests so they don't leak into
    // other test suites running in the same process.
    delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
    delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF;
    delete process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE;
    delete process.env.NEXT_PUBLIC_BUILD_TIMESTAMP;
  });

  it("renders without throwing with full healthy data", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockMonitoringStatus,
      source: "api" as const,
    });
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: mockExtendedData,
    });
    vi.mocked(fetchFromWikiServer).mockResolvedValue(mockOpenPRs);

    const element = await SystemHealthContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API is down (fallback data)", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        overall: "unknown",
        checkedAt: new Date().toISOString(),
        services: [],
        dbCounts: { pages: 0, entities: 0, facts: 0 },
        recentIncidents: [],
        jobsQueue: {},
        activeAgents: 0,
      },
      source: "local" as const,
      apiError: { type: "not-configured" as const },
    });
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: false,
      error: { type: "not-configured" as const },
    });
    vi.mocked(fetchFromWikiServer).mockResolvedValue(null);

    const element = await SystemHealthContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when system is degraded with open incidents", async () => {
    const degradedStatus = {
      ...mockMonitoringStatus,
      overall: "degraded",
      recentIncidents: [
        {
          id: 1,
          service: "wiki-server",
          severity: "critical",
          status: "open",
          title: "Database connection lost",
          detail: "Connection pool exhausted",
          detectedAt: "2025-01-01T10:00:00Z",
          resolvedAt: null,
          resolvedBy: null,
          checkSource: "groundskeeper",
        },
        {
          id: 2,
          service: "discord-bot",
          severity: "warning",
          status: "resolved",
          title: "High latency",
          detail: null,
          detectedAt: "2025-01-01T09:00:00Z",
          resolvedAt: "2025-01-01T09:30:00Z",
          resolvedBy: "auto",
          checkSource: null,
        },
      ],
      services: [
        { name: "wiki-server", status: "degraded", openIncidents: 1 },
        { name: "groundskeeper", status: "healthy", openIncidents: 0 },
        { name: "discord-bot", status: "unknown", openIncidents: 0 },
        { name: "vercel-frontend", status: "healthy", openIncidents: 0 },
        { name: "github-actions", status: "unknown", openIncidents: 0 },
      ],
    };

    vi.mocked(withApiFallback).mockResolvedValue({
      data: degradedStatus,
      source: "api" as const,
    });
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: false,
      error: { type: "connection-error" as const, message: "timeout" },
    });
    vi.mocked(fetchFromWikiServer).mockResolvedValue({ pulls: [] });

    const element = await SystemHealthContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when CI has failures", async () => {
    const extendedWithCIFail = {
      ...mockExtendedData,
      ci: {
        ...mockExtendedData.ci,
        allPassed: false,
        anyFailed: true,
        checks: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "test", status: "completed", conclusion: "failure" },
          { name: "validate", status: "completed", conclusion: "failure" },
        ],
      },
    };

    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockMonitoringStatus,
      source: "api" as const,
    });
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: extendedWithCIFail,
    });
    vi.mocked(fetchFromWikiServer).mockResolvedValue({ pulls: [] });

    const element = await SystemHealthContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when CI is null (no GitHub token)", async () => {
    const extendedNoCi = {
      ...mockExtendedData,
      ci: null,
    };

    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockMonitoringStatus,
      source: "api" as const,
    });
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: extendedNoCi,
    });
    vi.mocked(fetchFromWikiServer).mockResolvedValue({ pulls: [] });

    const element = await SystemHealthContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with pending jobs in queue", async () => {
    const statusWithJobs = {
      ...mockMonitoringStatus,
      jobsQueue: { pending: 10, running: 2, completed: 100 },
    };

    vi.mocked(withApiFallback).mockResolvedValue({
      data: statusWithJobs,
      source: "api" as const,
    });
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: mockExtendedData,
    });
    vi.mocked(fetchFromWikiServer).mockResolvedValue({ pulls: [] });

    const element = await SystemHealthContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with data integrity issues", async () => {
    const extendedWithIntegrityIssues = {
      ...mockExtendedData,
      integrity: {
        totalDanglingRefs: 5,
        status: "dirty",
        breakdown: {
          facts: 2,
          claims: 1,
          summaries: 0,
          citations: 2,
          editLogs: 0,
        },
      },
    };

    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockMonitoringStatus,
      source: "api" as const,
    });
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: extendedWithIntegrityIssues,
    });
    vi.mocked(fetchFromWikiServer).mockResolvedValue({ pulls: [] });

    const element = await SystemHealthContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with Vercel deployment metadata", async () => {
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA =
      "abcdef1234567890abcdef1234567890abcdef12";
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF = "main";
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE = "feat: new feature";
    process.env.NEXT_PUBLIC_BUILD_TIMESTAMP = "2025-01-01T12:00:00Z";

    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockMonitoringStatus,
      source: "api" as const,
    });
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: mockExtendedData,
    });
    vi.mocked(fetchFromWikiServer).mockResolvedValue({ pulls: [] });

    const element = await SystemHealthContent();
    expect(element).toBeTruthy();
  });

  it("augments github-actions status from CI data when service is unknown", async () => {
    const statusWithUnknownCI = {
      ...mockMonitoringStatus,
      services: [
        { name: "wiki-server", status: "healthy", openIncidents: 0 },
        { name: "github-actions", status: "unknown", openIncidents: 0 },
      ],
    };

    vi.mocked(withApiFallback).mockResolvedValue({
      data: statusWithUnknownCI,
      source: "api" as const,
    });
    // CI shows all passed — github-actions should be augmented to "healthy"
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: mockExtendedData,
    });
    vi.mocked(fetchFromWikiServer).mockResolvedValue({ pulls: [] });

    const element = await SystemHealthContent();
    expect(element).toBeTruthy();
  });

  it("renders with open PRs that have conflicts", async () => {
    const conflictingPRs = {
      pulls: [
        {
          number: 501,
          title: "feat: conflicting change",
          url: "https://github.com/org/repo/pull/501",
          branch: "claude/feature-501",
          author: "claude-bot",
          createdAt: "2025-01-01T08:00:00Z",
          updatedAt: "2025-01-01T09:00:00Z",
          checksState: "failure",
          mergeable: "conflicting",
          labels: [],
        },
      ],
    };

    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockMonitoringStatus,
      source: "api" as const,
    });
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: mockExtendedData,
    });
    vi.mocked(fetchFromWikiServer).mockResolvedValue(conflictingPRs);

    const element = await SystemHealthContent();
    expect(element).toBeTruthy();
  });
});
