/**
 * Render smoke tests for the Auto-Update Runs dashboard content component.
 *
 * AutoUpdateRunsContent fetches run data from the wiki-server API with a
 * YAML file fallback. These tests mock both paths and verify the component
 * renders without throwing for key data scenarios.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type React from "react";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
  withApiFallback: vi.fn(),
}));

// Mock fs so the YAML fallback doesn't hit the real filesystem
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    readFileSync: vi.fn().mockReturnValue(""),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
  readFileSync: vi.fn().mockReturnValue(""),
}));

vi.mock("@lib/yaml", () => ({
  loadYaml: vi.fn().mockReturnValue({}),
}));

vi.mock("@/app/internal/auto-update-runs/runs-table", () => ({
  RunsTable: () => null,
}));

vi.mock("@components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { withApiFallback } from "@lib/wiki-server";
import { AutoUpdateRunsContent } from "@/app/internal/auto-update-runs/auto-update-runs-content";
import { renderToStaticMarkup } from "react-dom/server";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockRuns = [
  {
    date: "2025-01-15",
    startedAt: "2025-01-15T06:00:00Z",
    trigger: "scheduled",
    sourcesChecked: 12,
    sourcesFailed: 1,
    itemsFetched: 45,
    itemsRelevant: 8,
    pagesPlanned: 5,
    pagesUpdated: 4,
    pagesFailed: 1,
    pagesSkipped: 0,
    budgetLimit: 30,
    budgetSpent: 12.5,
    durationMinutes: 25,
    results: [
      {
        pageId: "openai",
        status: "success" as const,
        tier: "standard",
        durationMs: 15000,
      },
      {
        pageId: "anthropic",
        status: "success" as const,
        tier: "budget",
        durationMs: 8000,
      },
      {
        pageId: "alignment",
        status: "failed" as const,
        tier: "standard",
        error: "Quality gate failed",
      },
    ],
  },
  {
    date: "2025-01-14",
    startedAt: "2025-01-14T06:00:00Z",
    trigger: "manual",
    sourcesChecked: 10,
    sourcesFailed: 0,
    itemsFetched: 30,
    itemsRelevant: 5,
    pagesPlanned: 3,
    pagesUpdated: 3,
    pagesFailed: 0,
    pagesSkipped: 0,
    budgetLimit: 20,
    budgetSpent: 8.0,
    durationMinutes: 15,
    results: [],
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AutoUpdateRunsContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with run data", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockRuns,
      source: "api" as const,
    });

    const element = await AutoUpdateRunsContent();
    expect(element).toBeTruthy();
    if (element) {
      const markup = renderToStaticMarkup(element as React.ReactElement);
      expect(markup).not.toMatch(/undefined|NaN/);
    }
  });

  it("renders without throwing with empty runs", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: [],
      source: "api" as const,
    });

    const element = await AutoUpdateRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API is not configured", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: [],
      source: "local" as const,
      apiError: { type: "not-configured" as const },
    });

    const element = await AutoUpdateRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with connection error", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: [],
      source: "local" as const,
      apiError: {
        type: "connection-error" as const,
        message: "ECONNREFUSED",
      },
    });

    const element = await AutoUpdateRunsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with runs that have failures", async () => {
    const runsWithFailures = [
      {
        ...mockRuns[0],
        pagesFailed: 5,
        pagesUpdated: 0,
      },
    ];

    vi.mocked(withApiFallback).mockResolvedValue({
      data: runsWithFailures,
      source: "api" as const,
    });

    const element = await AutoUpdateRunsContent();
    expect(element).toBeTruthy();
    if (element) {
      const markup = renderToStaticMarkup(element as React.ReactElement);
      expect(markup).not.toMatch(/undefined|NaN/);
    }
  });

  it("renders without throwing with zero budget spent", async () => {
    const zeroBudget = mockRuns.map((r) => ({
      ...r,
      budgetSpent: 0,
      pagesUpdated: 0,
    }));

    vi.mocked(withApiFallback).mockResolvedValue({
      data: zeroBudget,
      source: "api" as const,
    });

    const element = await AutoUpdateRunsContent();
    expect(element).toBeTruthy();
  });
});
