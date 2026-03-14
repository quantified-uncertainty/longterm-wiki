/**
 * Render smoke tests for the Session Insights dashboard content component.
 *
 * SessionInsightsContent fetches learnings and recommendations from the
 * wiki-server API. These tests verify the component renders without
 * throwing for the key data scenarios including empty state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type React from "react";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@/lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
  withApiFallback: vi.fn(),
}));

vi.mock("@/app/internal/session-insights/insights-table", () => ({
  InsightsTable: () => null,
}));

vi.mock("@/components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { withApiFallback } from "@/lib/wiki-server";
import { SessionInsightsContent } from "@/app/internal/session-insights/session-insights-content";
import { renderToStaticMarkup } from "react-dom/server";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockInsights = {
  insights: [
    {
      date: "2025-01-01",
      branch: "claude/fix-auth",
      title: "Fix auth session",
      type: "learning" as const,
      text: "The auth middleware needs to check token expiry before validation",
    },
    {
      date: "2025-01-02",
      branch: "claude/add-dashboard",
      title: "Add dashboard",
      type: "recommendation" as const,
      text: "Consider adding caching for dashboard API calls",
    },
    {
      date: null,
      branch: null,
      title: null,
      type: "learning" as const,
      text: "Some insight without session metadata",
    },
  ],
  summary: {
    total: 3,
    byType: { learning: 2, recommendation: 1 },
  },
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SessionInsightsContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with insights data", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockInsights,
      source: "api" as const,
    });

    const element = await SessionInsightsContent();
    expect(element).toBeTruthy();
    if (element) {
      const markup = renderToStaticMarkup(element as React.ReactElement);
      expect(markup).not.toMatch(/undefined|NaN/);
    }
  });

  it("renders without throwing with empty insights", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { insights: [], summary: { total: 0, byType: {} } },
      source: "api" as const,
    });

    const element = await SessionInsightsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API returns null (no local fallback)", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: null,
      source: "local" as const,
      apiError: { type: "not-configured" as const },
    });

    const element = await SessionInsightsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with connection error", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: null,
      source: "local" as const,
      apiError: {
        type: "connection-error" as const,
        message: "ECONNREFUSED",
      },
    });

    const element = await SessionInsightsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when summary has many types", async () => {
    const manyTypes = {
      insights: mockInsights.insights,
      summary: {
        total: 10,
        byType: { learning: 5, recommendation: 3, observation: 2 },
      },
    };

    vi.mocked(withApiFallback).mockResolvedValue({
      data: manyTypes,
      source: "api" as const,
    });

    const element = await SessionInsightsContent();
    expect(element).toBeTruthy();
    if (element) {
      const markup = renderToStaticMarkup(element as React.ReactElement);
      expect(markup).not.toMatch(/undefined|NaN/);
    }
  });
});
