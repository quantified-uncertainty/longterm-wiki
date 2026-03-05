/**
 * Render smoke tests for the Groundskeeper Runs dashboard content component.
 *
 * The groundskeeper dashboard makes two parallel API calls (runs + stats),
 * handles circuit breaker state, and displays per-task statistics. These
 * tests verify the component renders without throwing for the key data shapes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
  withApiFallback: vi.fn(),
}));

vi.mock("../groundskeeper-runs/groundskeeper-runs-table", () => ({
  GroundskeeperRunsTable: () => null,
}));

vi.mock("@components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { withApiFallback } from "@lib/wiki-server";
import { GroundskeeperRunsContent } from "../groundskeeper-runs/groundskeeper-runs-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockRuns = [
  {
    id: 1,
    taskName: "sync-pages",
    event: "run",
    success: true,
    durationMs: 1250,
    summary: "Synced 5 pages",
    errorMessage: null,
    consecutiveFailures: 0,
    circuitBreakerActive: false,
    timestamp: "2025-01-01T12:00:00Z",
  },
  {
    id: 2,
    taskName: "sync-entities",
    event: "run",
    success: false,
    durationMs: 500,
    summary: null,
    errorMessage: "Connection timeout",
    consecutiveFailures: 3,
    circuitBreakerActive: false,
    timestamp: "2025-01-01T11:30:00Z",
  },
  {
    id: 3,
    taskName: "check-health",
    event: "circuit-open",
    success: false,
    durationMs: null,
    summary: null,
    errorMessage: "Circuit breaker tripped after 5 failures",
    consecutiveFailures: 5,
    circuitBreakerActive: true,
    timestamp: "2025-01-01T11:00:00Z",
  },
];

const mockStats = [
  {
    taskName: "sync-pages",
    last24h: {
      total: 24,
      success: 23,
      failure: 1,
      avgDurationMs: 1200,
      lastRun: "2025-01-01T12:00:00Z",
      lastSuccess: "2025-01-01T12:00:00Z",
      successRate: 95.8,
    },
    allTime: {
      total: 720,
      firstRun: "2024-01-01T00:00:00Z",
    },
  },
  {
    taskName: "sync-entities",
    last24h: {
      total: 12,
      success: 9,
      failure: 3,
      avgDurationMs: 850,
      lastRun: "2025-01-01T11:30:00Z",
      lastSuccess: "2025-01-01T10:00:00Z",
      successRate: 75.0,
    },
    allTime: {
      total: 360,
      firstRun: "2024-01-01T00:00:00Z",
    },
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GroundskeeperRunsContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with runs and stats data", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { runs: mockRuns, stats: mockStats },
      source: "api" as const,
    });

    const element = await GroundskeeperRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with no runs (empty state)", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { runs: [], stats: [] },
      source: "api" as const,
    });

    const element = await GroundskeeperRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API is not configured", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { runs: [], stats: [] },
      source: "local" as const,
      apiError: { type: "not-configured" as const },
    });

    const element = await GroundskeeperRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when circuit breaker is active", async () => {
    const runsWithActiveCircuitBreaker = mockRuns.map((r) => ({
      ...r,
      circuitBreakerActive: true,
    }));

    vi.mocked(withApiFallback).mockResolvedValue({
      data: { runs: runsWithActiveCircuitBreaker, stats: mockStats },
      source: "api" as const,
    });

    const element = await GroundskeeperRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with stats but no runs", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { runs: [], stats: mockStats },
      source: "api" as const,
    });

    const element = await GroundskeeperRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with all failed runs", async () => {
    const allFailedRuns = mockRuns.map((r) => ({ ...r, success: false }));

    vi.mocked(withApiFallback).mockResolvedValue({
      data: { runs: allFailedRuns, stats: [] },
      source: "api" as const,
    });

    const element = await GroundskeeperRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with null avgDurationMs in stats", async () => {
    const statsWithNullDuration = mockStats.map((s) => ({
      ...s,
      last24h: { ...s.last24h, avgDurationMs: null, successRate: null },
    }));

    vi.mocked(withApiFallback).mockResolvedValue({
      data: { runs: mockRuns, stats: statsWithNullDuration },
      source: "api" as const,
    });

    const element = await GroundskeeperRunsContent();
    expect(element).toBeTruthy();
  });
});
