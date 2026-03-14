/**
 * Render smoke tests for the Improve Runs dashboard content component.
 *
 * ImproveRunsContent fetches artifact data from the wiki-server API and
 * transforms it into run rows with cost, quality gate, and phase data.
 * These tests verify the component renders without throwing for key
 * data scenarios.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
}));

vi.mock("@/app/internal/improve-runs/runs-table", () => ({
  RunsTable: () => null,
}));

vi.mock("@components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { fetchDetailed } from "@lib/wiki-server";
import { ImproveRunsContent } from "@/app/internal/improve-runs/improve-runs-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockArtifacts = [
  {
    id: 1,
    pageId: "existential-risk",
    engine: "v2",
    tier: "standard",
    directions: "Improve clarity and add citations",
    startedAt: "2025-01-01T10:00:00Z",
    completedAt: "2025-01-01T10:15:00Z",
    durationS: 900,
    totalCost: 2.5,
    qualityGatePassed: true,
    qualityGaps: null,
    toolCallCount: 12,
    refinementCycles: 2,
    phasesRun: ["research", "enrich", "review"],
    sourceCache: [{ url: "https://example.com" }],
    citationAudit: { total: 5, verified: 4 },
    sectionDiffs: [{ section: "Overview", added: 3, removed: 1 }],
    costBreakdown: { research: 1.0, enrich: 1.0, review: 0.5 },
  },
  {
    id: 2,
    pageId: "alignment",
    engine: "v1",
    tier: "budget",
    directions: null,
    startedAt: "2025-01-02T09:00:00Z",
    completedAt: "2025-01-02T09:05:00Z",
    durationS: 300,
    totalCost: 0.8,
    qualityGatePassed: false,
    qualityGaps: ["missing citations", "too short"],
    toolCallCount: 5,
    refinementCycles: 1,
    phasesRun: ["enrich"],
    sourceCache: [],
    citationAudit: null,
    sectionDiffs: [],
    costBreakdown: null,
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ImproveRunsContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with run data", async () => {
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: { entries: mockArtifacts, total: mockArtifacts.length },
    });

    const element = await ImproveRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with empty runs", async () => {
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: { entries: [], total: 0 },
    });

    const element = await ImproveRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API fails", async () => {
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: false,
      error: { type: "not-configured" as const },
    });

    const element = await ImproveRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API has connection error", async () => {
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: false,
      error: {
        type: "connection-error" as const,
        message: "ECONNREFUSED",
      },
    });

    const element = await ImproveRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with null costs and durations", async () => {
    const runsWithNulls = mockArtifacts.map((a) => ({
      ...a,
      totalCost: null,
      durationS: null,
      completedAt: null,
    }));

    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: { entries: runsWithNulls, total: runsWithNulls.length },
    });

    const element = await ImproveRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when all runs fail quality gate", async () => {
    const allFailed = mockArtifacts.map((a) => ({
      ...a,
      qualityGatePassed: false,
      qualityGaps: ["insufficient citations"],
    }));

    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: { entries: allFailed, total: allFailed.length },
    });

    const element = await ImproveRunsContent();
    expect(element).toBeTruthy();
  });
});
