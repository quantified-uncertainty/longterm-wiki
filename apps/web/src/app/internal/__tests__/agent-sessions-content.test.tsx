/**
 * Render smoke tests for the Agent Sessions dashboard content component.
 *
 * These tests call the async server component directly with mocked API data
 * to verify the component renders without throwing. They catch data shape
 * mismatches (e.g. renamed fields, missing required props) before they
 * reach production.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
  withApiFallback: vi.fn(),
}));

// Table is a "use client" component — stub it so the node env can import it.
vi.mock(
  "/Users/ozziegooen/Documents/GitHub.nosync/longterm-wiki/apps/web/src/app/internal/agent-sessions/sessions-table",
  () => ({
    AgentSessionsTable: () => null,
  })
);

vi.mock("@components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  withApiFallback,
  fetchDetailed,
} from "@lib/wiki-server";
import { AgentSessionsContent } from "../agent-sessions/agent-sessions-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockAgentSessions = [
  {
    id: 1,
    branch: "claude/fix-123",
    task: "Fix authentication bug",
    sessionType: "bugfix",
    issueNumber: 123,
    worktree: null,
    status: "completed",
    startedAt: "2025-01-01T10:00:00Z",
    completedAt: "2025-01-01T12:00:00Z",
    prUrl: "https://github.com/org/repo/pull/456",
    prOutcome: "merged",
    fixesPrUrl: null,
  },
  {
    id: 2,
    branch: "claude/feature-789",
    task: "Add new dashboard",
    sessionType: "infrastructure",
    issueNumber: 789,
    worktree: null,
    status: "active",
    startedAt: "2025-01-02T09:00:00Z",
    completedAt: null,
    prUrl: null,
    prOutcome: null,
    fixesPrUrl: null,
  },
];

const mockSessionLogs = [
  {
    id: 1,
    branch: "claude/fix-123",
    title: "Fix auth bug session",
    model: "claude-opus-4-6",
    cost: "2.50",
    costCents: 250,
    durationMinutes: 120,
    prUrl: "https://github.com/org/repo/pull/456",
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AgentSessionsContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing when API returns session data", async () => {
    vi.mocked(fetchDetailed)
      .mockResolvedValueOnce({ ok: true, data: { sessions: mockAgentSessions } })
      .mockResolvedValueOnce({ ok: true, data: { sessions: mockSessionLogs } });

    vi.mocked(withApiFallback).mockImplementation(async (apiLoader) => {
      const result = await apiLoader();
      if (result && typeof result === "object" && "ok" in result && result.ok) {
        return { data: (result as { ok: true; data: unknown }).data, source: "api" as const };
      }
      return { data: [], source: "local" as const };
    });

    const element = await AgentSessionsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API returns empty sessions", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: [],
      source: "api" as const,
    });

    const element = await AgentSessionsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API fails (fallback to local data)", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: [],
      source: "local" as const,
      apiError: { type: "not-configured" as const },
    });

    const element = await AgentSessionsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API has connection error", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: [],
      source: "local" as const,
      apiError: {
        type: "connection-error" as const,
        message: "ECONNREFUSED",
      },
    });

    const element = await AgentSessionsContent();
    expect(element).toBeTruthy();
  });

  it("enriches sessions with cost and PR data from session logs", async () => {
    vi.mocked(fetchDetailed)
      .mockResolvedValueOnce({ ok: true, data: { sessions: mockAgentSessions } })
      .mockResolvedValueOnce({ ok: true, data: { sessions: mockSessionLogs } });

    // Use the real withApiFallback to test the data transformation
    const { withApiFallback: realWithApiFallback } = await vi.importActual<
      typeof import("@lib/wiki-server")
    >("@lib/wiki-server");
    vi.mocked(withApiFallback).mockImplementation(realWithApiFallback);

    // Verify the component doesn't crash with enriched data
    const element = await AgentSessionsContent();
    expect(element).toBeTruthy();
  });

  it("handles sessions with fix-chain data (fixesPrUrl)", async () => {
    const sessionsWithFixes = [
      ...mockAgentSessions,
      {
        id: 3,
        branch: "claude/fix-of-fix",
        task: "Fix regression from PR 456",
        sessionType: "bugfix",
        issueNumber: null,
        worktree: null,
        status: "completed",
        startedAt: "2025-01-03T10:00:00Z",
        completedAt: "2025-01-03T11:00:00Z",
        prUrl: "https://github.com/org/repo/pull/500",
        prOutcome: "merged",
        fixesPrUrl: "https://github.com/org/repo/pull/456",
      },
    ];

    vi.mocked(withApiFallback).mockResolvedValue({
      data: sessionsWithFixes.map((s) => ({
        ...s,
        model: null,
        cost: null,
        costCents: null,
        durationMinutes: null,
        title: null,
      })),
      source: "api" as const,
    });

    const element = await AgentSessionsContent();
    expect(element).toBeTruthy();
  });
});
