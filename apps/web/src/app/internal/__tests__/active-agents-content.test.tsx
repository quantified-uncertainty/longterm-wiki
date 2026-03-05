/**
 * Render smoke tests for the Active Agents dashboard content component.
 *
 * Active Agents makes two parallel API calls (agents + open PRs) and enriches
 * agent rows with PR numbers from branch matching. These tests verify the
 * component renders without throwing for all key data scenarios.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(),
  fetchFromWikiServer: vi.fn(),
  withApiFallback: vi.fn(),
}));

vi.mock(
  "/Users/ozziegooen/Documents/GitHub.nosync/longterm-wiki/apps/web/src/app/internal/active-agents/active-agents-table",
  () => ({
    ActiveAgentsTable: () => null,
  })
);

vi.mock(
  "/Users/ozziegooen/Documents/GitHub.nosync/longterm-wiki/apps/web/src/app/internal/active-agents/agent-events-panel",
  () => ({
    AgentEventsPanel: () => null,
  })
);

vi.mock("@components/internal/DataSourceBanner", () => ({
  DataSourceBanner: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { withApiFallback } from "@lib/wiki-server";
import { ActiveAgentsContent } from "../active-agents/active-agents-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockAgents = [
  {
    id: 1,
    sessionId: "sess-abc123",
    sessionName: "Fix auth session",
    branch: "claude/fix-123",
    task: "Fix authentication vulnerability",
    status: "active",
    currentStep: "Writing tests",
    issueNumber: 123,
    prNumber: null,
    filesTouched: ["src/auth.ts", "src/middleware.ts"],
    model: "claude-opus-4-6",
    worktree: "/tmp/worktree-abc",
    heartbeatAt: "2025-01-01T11:55:00Z",
    startedAt: "2025-01-01T10:00:00Z",
    completedAt: null,
  },
  {
    id: 2,
    sessionId: "sess-def456",
    sessionName: null,
    branch: "claude/feature-789",
    task: "Add dashboard feature",
    status: "completed",
    currentStep: null,
    issueNumber: 789,
    prNumber: 456,
    filesTouched: null,
    model: null,
    worktree: null,
    heartbeatAt: "2025-01-01T09:30:00Z",
    startedAt: "2025-01-01T09:00:00Z",
    completedAt: "2025-01-01T09:30:00Z",
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ActiveAgentsContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with active agents", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        agents: mockAgents.map((a) => ({ ...a })),
        conflicts: [],
        directoryConflicts: [],
      },
      source: "api" as const,
    });

    const element = await ActiveAgentsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with no agents", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { agents: [], conflicts: [], directoryConflicts: [] },
      source: "api" as const,
    });

    const element = await ActiveAgentsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when API is not configured", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { agents: [], conflicts: [], directoryConflicts: [] },
      source: "local" as const,
      apiError: { type: "not-configured" as const },
    });

    const element = await ActiveAgentsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with issue conflicts", async () => {
    const conflictData = {
      agents: [
        { ...mockAgents[0], issueNumber: 100 },
        {
          id: 3,
          sessionId: "sess-ghi789",
          sessionName: null,
          branch: "claude/another-fix-100",
          task: "Also fixing issue 100",
          status: "active",
          currentStep: "Analyzing code",
          issueNumber: 100,
          prNumber: null,
          filesTouched: null,
          model: null,
          worktree: null,
          heartbeatAt: "2025-01-01T11:50:00Z",
          startedAt: "2025-01-01T11:00:00Z",
          completedAt: null,
        },
      ],
      conflicts: [
        { issueNumber: 100, sessionIds: ["sess-abc123", "sess-ghi789"] },
      ],
      directoryConflicts: [],
    };

    vi.mocked(withApiFallback).mockResolvedValue({
      data: conflictData,
      source: "api" as const,
    });

    const element = await ActiveAgentsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with directory conflicts", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: {
        agents: mockAgents.map((a) => ({ ...a })),
        conflicts: [],
        directoryConflicts: [
          {
            directory: "/Users/user/Documents/GitHub.nosync/longterm-wiki",
            sessionIds: ["sess-abc123", "sess-def456"],
          },
        ],
      },
      source: "api" as const,
    });

    const element = await ActiveAgentsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with mixed agent statuses", async () => {
    const mixedAgents = [
      { ...mockAgents[0], status: "active" },
      { ...mockAgents[1], id: 3, status: "stale", sessionId: "sess-stale" },
      {
        ...mockAgents[1],
        id: 4,
        status: "completed",
        sessionId: "sess-completed",
      },
    ];

    vi.mocked(withApiFallback).mockResolvedValue({
      data: { agents: mixedAgents, conflicts: [], directoryConflicts: [] },
      source: "api" as const,
    });

    const element = await ActiveAgentsContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with connection error", async () => {
    vi.mocked(withApiFallback).mockResolvedValue({
      data: { agents: [], conflicts: [], directoryConflicts: [] },
      source: "local" as const,
      apiError: {
        type: "connection-error" as const,
        message: "connect ECONNREFUSED 127.0.0.1:3100",
      },
    });

    const element = await ActiveAgentsContent();
    expect(element).toBeTruthy();
  });
});
