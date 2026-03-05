/**
 * Render smoke tests for the Statement Scores dashboard content component.
 *
 * Statement Scores makes three parallel API calls (coverage scores, score
 * distribution, and statement stats). These tests verify the component renders
 * without throwing for the key data shapes and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
  withApiFallback: vi.fn(),
}));

vi.mock(
  "/Users/ozziegooen/Documents/GitHub.nosync/longterm-wiki/apps/web/src/app/internal/statement-scores/statement-scores-table",
  () => ({
    StatementScoresTable: () => null,
  })
);

vi.mock("@components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

vi.mock("@components/internal/StatCard", () => ({
  StatCard: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { withApiFallback } from "@lib/wiki-server";
import { StatementScoresContent } from "../statement-scores/statement-scores-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockCoverageScores = [
  {
    id: 1,
    entityId: "openai",
    coverageScore: 0.85,
    categoryScores: {
      safety: 0.9,
      capabilities: 0.8,
      governance: 0.85,
    },
    statementCount: 42,
    qualityAvg: 0.78,
    scoredAt: "2025-01-01T10:00:00Z",
  },
  {
    id: 2,
    entityId: "anthropic",
    coverageScore: 0.72,
    categoryScores: {
      safety: 0.95,
      capabilities: 0.65,
      governance: 0.55,
    },
    statementCount: 38,
    qualityAvg: 0.82,
    scoredAt: "2025-01-01T10:00:00Z",
  },
];

const mockDistribution = {
  buckets: [
    { range: "0.0-0.2", count: 5 },
    { range: "0.2-0.4", count: 12 },
    { range: "0.4-0.6", count: 25 },
    { range: "0.6-0.8", count: 48 },
    { range: "0.8-1.0", count: 30 },
    { range: "unscored", count: 20 },
  ],
  averageQuality: 0.73,
  scoredCount: 120,
  categoryBreakdown: [
    { category: "safety", count: 45, avgQuality: 0.82 },
    { category: "capabilities", count: 38, avgQuality: 0.71 },
    { category: "governance", count: 37, avgQuality: 0.65 },
  ],
};

const mockStats = {
  total: 140,
  byVariety: { safety_claim: 45, capability_claim: 38, governance_claim: 37 },
  byStatus: { active: 120, archived: 15, draft: 5 },
  propertiesCount: 25,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("StatementScoresContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with full data", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        coverageScores: mockCoverageScores,
        distribution: mockDistribution,
        stats: mockStats,
      },
      source: "api" as const,
    });

    const element = await StatementScoresContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with empty data (fallback state)", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        coverageScores: [],
        distribution: {
          buckets: [],
          averageQuality: null,
          scoredCount: 0,
          categoryBreakdown: [],
        },
        stats: { total: 0, byVariety: {}, byStatus: {}, propertiesCount: 0 },
      },
      source: "local" as const,
      apiError: { type: "not-configured" as const },
    });

    const element = await StatementScoresContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with no scored statements", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        coverageScores: [],
        distribution: {
          buckets: [{ range: "unscored", count: 100 }],
          averageQuality: null,
          scoredCount: 0,
          categoryBreakdown: [],
        },
        stats: mockStats,
      },
      source: "api" as const,
    });

    const element = await StatementScoresContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with all statements scored (no unscored bucket)", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        coverageScores: mockCoverageScores,
        distribution: {
          buckets: [
            { range: "0.6-0.8", count: 60 },
            { range: "0.8-1.0", count: 60 },
          ],
          averageQuality: 0.85,
          scoredCount: 120,
          categoryBreakdown: mockDistribution.categoryBreakdown,
        },
        stats: mockStats,
      },
      source: "api" as const,
    });

    const element = await StatementScoresContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with null avgQuality in categories", async () => {
    const distributionWithNullQuality = {
      ...mockDistribution,
      averageQuality: null,
      categoryBreakdown: mockDistribution.categoryBreakdown.map((c) => ({
        ...c,
        avgQuality: null,
      })),
    };

    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        coverageScores: mockCoverageScores,
        distribution: distributionWithNullQuality,
        stats: mockStats,
      },
      source: "api" as const,
    });

    const element = await StatementScoresContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with connection error fallback", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        coverageScores: [],
        distribution: {
          buckets: [],
          averageQuality: null,
          scoredCount: 0,
          categoryBreakdown: [],
        },
        stats: { total: 0, byVariety: {}, byStatus: {}, propertiesCount: 0 },
      },
      source: "local" as const,
      apiError: {
        type: "connection-error" as const,
        message: "ECONNREFUSED",
      },
    });

    const element = await StatementScoresContent();
    expect(element).toBeTruthy();
  });
});
