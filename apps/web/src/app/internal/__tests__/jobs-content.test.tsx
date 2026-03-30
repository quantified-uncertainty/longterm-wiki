/**
 * Render smoke tests for the Jobs dashboard content component.
 *
 * JobsDashboardContent fetches job stats and recent failures from the
 * wiki-server API with an empty-data fallback. These tests mock the API
 * path and verify the component renders correctly for key data scenarios.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type React from "react";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
  withApiFallback: vi.fn(),
}));

vi.mock("@/app/internal/jobs/jobs-overview-table", () => ({
  JobsOverviewTable: () => null,
}));

vi.mock("@/app/internal/jobs/jobs-failures-table", () => ({
  RecentFailuresTable: () => null,
}));

vi.mock("@components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { withApiFallback } from "@lib/wiki-server";
import { JobsDashboardContent } from "@/app/internal/jobs/jobs-content";
import { renderToStaticMarkup } from "react-dom/server";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockStatsWithData = {
  stats: {
    totalJobs: 150,
    byType: {
      "claim-verification": {
        byStatus: { pending: 5, running: 2, completed: 80, failed: 3 },
        avgDurationMs: 12500,
        failureRate: 0.036,
      },
      "resource-ingest": {
        byStatus: { pending: 0, completed: 50, failed: 10 },
        avgDurationMs: 45000,
        failureRate: 0.167,
      },
    },
  },
  recentFailures: [
    {
      id: 42,
      type: "claim-verification",
      status: "failed",
      params: null,
      result: null,
      error: "Timeout after 30s",
      priority: 0,
      retries: 3,
      maxRetries: 3,
      createdAt: "2026-03-28T10:00:00Z",
      claimedAt: null,
      startedAt: null,
      completedAt: "2026-03-28T10:05:00Z",
      workerId: "worker-1",
      runAfter: null,
      dedupKey: null,
      parentJobId: null,
      costUsd: null,
    },
  ],
};

const mockStatsEmpty = {
  stats: { totalJobs: 0, byType: {} },
  recentFailures: [],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("JobsDashboardContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with job data showing totals and type count", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockStatsWithData,
      source: "api" as const,
    });

    const element = await JobsDashboardContent();
    expect(element).toBeTruthy();
    const markup = renderToStaticMarkup(element as React.ReactElement);
    expect(markup).toContain("150");
    expect(markup).toContain("2"); // 2 types
    expect(markup).not.toMatch(/undefined|NaN/);
  });

  it("renders empty state when no jobs exist", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockStatsEmpty,
      source: "api" as const,
    });

    const element = await JobsDashboardContent();
    expect(element).toBeTruthy();
    const markup = renderToStaticMarkup(element as React.ReactElement);
    expect(markup).toContain("No jobs found");
    expect(markup).not.toContain("Jobs by Type");
  });

  it("renders aggregate status pills for non-zero counts", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockStatsWithData,
      source: "api" as const,
    });

    const element = await JobsDashboardContent();
    const markup = renderToStaticMarkup(element as React.ReactElement);
    // 5 pending from claim-verification + 0 from resource-ingest
    expect(markup).toContain("5 pending");
    expect(markup).toContain("2 running");
    expect(markup).toContain("130 completed"); // 80 + 50
    expect(markup).toContain("13 failed"); // 3 + 10
  });

  it("handles types with missing statuses (sparse byStatus)", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        stats: {
          totalJobs: 10,
          byType: {
            "sparse-type": {
              byStatus: { completed: 10 },
              // no pending, running, failed, etc.
            },
          },
        },
        recentFailures: [],
      },
      source: "api" as const,
    });

    const element = await JobsDashboardContent();
    expect(element).toBeTruthy();
    const markup = renderToStaticMarkup(element as React.ReactElement);
    expect(markup).not.toMatch(/undefined|NaN/);
    expect(markup).toContain("10");
  });

  it("renders with API not configured fallback", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockStatsEmpty,
      source: "local" as const,
      apiError: { type: "not-configured" as const },
    });

    const element = await JobsDashboardContent();
    expect(element).toBeTruthy();
  });

  it("renders with connection error fallback", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockStatsEmpty,
      source: "local" as const,
      apiError: { type: "connection-error" as const, message: "ECONNREFUSED" },
    });

    const element = await JobsDashboardContent();
    expect(element).toBeTruthy();
  });

  it("handles failure entries with null error gracefully", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        stats: { totalJobs: 1, byType: { test: { byStatus: { failed: 1 } } } },
        recentFailures: [
          {
            id: 99,
            type: "test",
            status: "failed",
            params: null,
            result: null,
            error: null, // null error — should show "Unknown error"
            priority: 0,
            retries: 0,
            maxRetries: 3,
            createdAt: "2026-03-28T10:00:00Z",
            claimedAt: null,
            startedAt: null,
            completedAt: null,
            workerId: null,
            runAfter: null,
            dedupKey: null,
            parentJobId: null,
            costUsd: null,
          },
        ],
      },
      source: "api" as const,
    });

    const element = await JobsDashboardContent();
    expect(element).toBeTruthy();
    // RecentFailuresTable is mocked, but the buildFailureRows function
    // should handle null error by converting to "Unknown error"
  });
});
