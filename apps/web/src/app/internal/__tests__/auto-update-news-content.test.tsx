/**
 * Render smoke tests for the Auto-Update News dashboard content component.
 *
 * AutoUpdateNewsContent fetches news items from the wiki-server API with a
 * YAML file fallback, plus reads sources config from the filesystem. These
 * tests mock all external dependencies and verify the component renders
 * without throwing for key data scenarios.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type React from "react";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
  withApiFallback: vi.fn(),
}));

// Mock fs so the YAML fallback and sources loading don't hit the real filesystem
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
  loadYaml: vi.fn().mockReturnValue({ sources: [] }),
}));

vi.mock("@/app/internal/auto-update-news/news-table", () => ({
  NewsTable: () => null,
}));

vi.mock("@/app/internal/auto-update-news/sources-table", () => ({
  SourcesTable: () => null,
}));

vi.mock("@components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { withApiFallback } from "@lib/wiki-server";
import { AutoUpdateNewsContent } from "@/app/internal/auto-update-news/auto-update-news-content";
import { renderToStaticMarkup } from "react-dom/server";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockNewsItems = [
  {
    title: "OpenAI announces new safety framework",
    url: "https://example.com/openai-safety",
    sourceId: "rss-openai-blog",
    publishedAt: "2025-01-15T10:00:00Z",
    summary: "OpenAI released a new preparedness framework for frontier models",
    relevanceScore: 85,
    topics: ["safety", "governance"],
    routedTo: "OpenAI",
    routedTier: "standard",
    runDate: "2025-01-15",
  },
  {
    title: "Anthropic publishes responsible scaling update",
    url: "https://example.com/anthropic-rsp",
    sourceId: "rss-anthropic-blog",
    publishedAt: "2025-01-14T09:00:00Z",
    summary: "Update to Anthropic's responsible scaling policy",
    relevanceScore: 90,
    topics: ["responsible-scaling", "policy"],
    routedTo: "Anthropic",
    routedTier: "budget",
    runDate: "2025-01-15",
  },
  {
    title: "Minor AI news article",
    url: "https://example.com/minor-news",
    sourceId: "web-search-general",
    publishedAt: "2025-01-13T15:00:00Z",
    summary: "A minor development in AI",
    relevanceScore: 30,
    topics: ["general"],
    routedTo: null,
    routedTier: null,
    runDate: "2025-01-15",
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AutoUpdateNewsContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with news data", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { items: mockNewsItems, runDates: ["2025-01-15"] },
      source: "api" as const,
    });

    const element = await AutoUpdateNewsContent();
    expect(element).toBeTruthy();
    if (element) {
      const markup = renderToStaticMarkup(element as React.ReactElement);
      expect(markup).not.toMatch(/undefined|NaN/);
    }
  });

  it("renders without throwing with empty news", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { items: [], runDates: [] },
      source: "api" as const,
    });

    const element = await AutoUpdateNewsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API is not configured", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { items: [], runDates: [] },
      source: "local" as const,
      apiError: { type: "not-configured" as const },
    });

    const element = await AutoUpdateNewsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with connection error", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { items: [], runDates: [] },
      source: "local" as const,
      apiError: {
        type: "connection-error" as const,
        message: "ECONNREFUSED",
      },
    });

    const element = await AutoUpdateNewsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with multiple run dates", async () => {
    const multiRunNews = [
      ...mockNewsItems,
      {
        ...mockNewsItems[0],
        title: "Another article from a different run",
        runDate: "2025-01-14",
      },
    ];

    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        items: multiRunNews,
        runDates: ["2025-01-15", "2025-01-14"],
      },
      source: "api" as const,
    });

    const element = await AutoUpdateNewsContent();
    expect(element).toBeTruthy();
    if (element) {
      const markup = renderToStaticMarkup(element as React.ReactElement);
      expect(markup).not.toMatch(/undefined|NaN/);
    }
  });

  it("renders without throwing when no items are routed", async () => {
    const unroutedItems = mockNewsItems.map((i) => ({
      ...i,
      routedTo: null,
      routedTier: null,
    }));

    vi.mocked(withApiFallback).mockResolvedValue({
      data: { items: unroutedItems, runDates: ["2025-01-15"] },
      source: "api" as const,
    });

    const element = await AutoUpdateNewsContent();
    expect(element).toBeTruthy();
  });
});
