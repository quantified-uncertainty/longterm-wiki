/**
 * Render smoke tests for the Update Schedule dashboard content component.
 *
 * UpdateScheduleContent uses getUpdateSchedule() which returns local data
 * with a source indicator. These tests verify the component renders without
 * throwing for typical and edge-case data shapes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@/data", () => ({
  getUpdateSchedule: vi.fn(),
}));

vi.mock("@/app/internal/updates/updates-table", () => ({
  UpdatesTable: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { getUpdateSchedule } from "@/data";
import { UpdateScheduleContent } from "@/app/internal/updates/updates-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockScheduleItems = [
  {
    id: "existential-risk",
    title: "Existential Risk",
    category: "knowledge-base",
    quality: 85,
    importance: 95,
    lastEdited: "2024-06-01",
    updateFrequency: 90,
    daysUntilDue: -30,
    staleness: 1.5,
    priority: 95,
  },
  {
    id: "alignment",
    title: "Alignment",
    category: "knowledge-base",
    quality: 70,
    importance: 90,
    lastEdited: "2025-01-01",
    updateFrequency: 180,
    daysUntilDue: 120,
    staleness: 0.3,
    priority: 60,
  },
  {
    id: "openai",
    title: "OpenAI",
    category: "knowledge-base",
    quality: 60,
    importance: 80,
    lastEdited: "2024-12-01",
    updateFrequency: 30,
    daysUntilDue: -45,
    staleness: 2.5,
    priority: 88,
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("UpdateScheduleContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with schedule data", async () => {
    vi.mocked(getUpdateSchedule).mockResolvedValue({
      data: mockScheduleItems as never,
      source: "api" as const,
    });

    const element = await UpdateScheduleContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with empty schedule", async () => {
    vi.mocked(getUpdateSchedule).mockResolvedValue({
      data: [],
      source: "api" as const,
    });

    const element = await UpdateScheduleContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when all pages are overdue", async () => {
    const allOverdue = mockScheduleItems.map((i) => ({
      ...i,
      daysUntilDue: -10,
    }));
    vi.mocked(getUpdateSchedule).mockResolvedValue({
      data: allOverdue as never,
      source: "api" as const,
    });

    const element = await UpdateScheduleContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when no pages are overdue", async () => {
    const noneOverdue = mockScheduleItems.map((i) => ({
      ...i,
      daysUntilDue: 30,
    }));
    vi.mocked(getUpdateSchedule).mockResolvedValue({
      data: noneOverdue as never,
      source: "local" as const,
    });

    const element = await UpdateScheduleContent();
    expect(element).toBeTruthy();
  });
});
