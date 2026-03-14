/**
 * Render smoke tests for the Page Changes dashboard content component.
 *
 * PageChangesContent fetches session data from the wiki-server API and
 * enriches it with local page metadata from database.json. These tests
 * verify the component renders without throwing for the key data scenarios.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
  withApiFallback: vi.fn(),
}));

vi.mock("@/data", () => ({
  getPageChangeSessions: vi.fn(),
  getAllPages: vi.fn(),
  getIdRegistry: vi.fn(),
}));

vi.mock("@/app/internal/page-changes/page-changes-sessions", () => ({
  PageChangesSessions: () => null,
}));

vi.mock("@components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { withApiFallback } from "@lib/wiki-server";
import { PageChangesContent } from "@/app/internal/page-changes/page-changes-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockSessions = [
  {
    sessionKey: "2025-01-01|claude/fix-auth",
    date: "2025-01-01",
    branch: "claude/fix-auth",
    sessionTitle: "Fix authentication flow",
    summary: "Updated auth middleware",
    pr: 123,
    model: "claude-opus-4-6",
    duration: "45 min",
    cost: "$1.50",
    pages: [
      {
        pageId: "existential-risk",
        pageTitle: "Existential Risk",
        pagePath: "/wiki/E42",
        numericId: "E42",
        category: "knowledge-base",
      },
      {
        pageId: "alignment",
        pageTitle: "Alignment",
        pagePath: "/wiki/E43",
        numericId: "E43",
        category: "knowledge-base",
      },
    ],
  },
  {
    sessionKey: "2025-01-02|claude/feature-dashboard",
    date: "2025-01-02",
    branch: "claude/feature-dashboard",
    sessionTitle: "Add dashboard feature",
    summary: "",
    pages: [
      {
        pageId: "openai",
        pageTitle: "OpenAI",
        pagePath: "/wiki/E1",
        numericId: "E1",
        category: "knowledge-base",
      },
    ],
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PageChangesContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with session data", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: mockSessions,
      source: "api" as const,
    });

    const element = await PageChangesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with empty sessions", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: [],
      source: "api" as const,
    });

    const element = await PageChangesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API is not configured", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: [],
      source: "local" as const,
      apiError: { type: "not-configured" as const },
    });

    const element = await PageChangesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with sessions missing optional fields", async () => {
    const minimalSessions = [
      {
        sessionKey: "2025-01-01|unknown",
        date: "2025-01-01",
        branch: "unknown",
        sessionTitle: "",
        summary: "",
        pages: [
          {
            pageId: "some-page",
            pageTitle: "some-page",
            pagePath: "/wiki/some-page",
            numericId: "some-page",
            category: "unknown",
          },
        ],
      },
    ];

    vi.mocked(withApiFallback).mockResolvedValue({
      data: minimalSessions,
      source: "local" as const,
    });

    const element = await PageChangesContent();
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

    const element = await PageChangesContent();
    expect(element).toBeTruthy();
  });
});
