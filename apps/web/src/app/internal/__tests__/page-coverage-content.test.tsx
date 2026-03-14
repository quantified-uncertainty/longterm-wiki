/**
 * Render smoke tests for the Page Coverage dashboard content component.
 *
 * PageCoverageContent reads from local database.json via getPageCoverageItems().
 * These tests mock the data layer to verify the component renders without
 * throwing for typical and edge-case data shapes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@/data", () => ({
  getPageCoverageItems: vi.fn(),
}));

vi.mock("@/app/internal/page-coverage/coverage-table", () => ({
  CoverageTable: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { getPageCoverageItems } from "@/data";
import { PageCoverageContent } from "@/app/internal/page-coverage/page-coverage-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockCoverageItems = [
  {
    id: "existential-risk",
    title: "Existential Risk",
    quality: 85,
    riskLevel: "low",
    score: 72,
    total: 100,
    category: "knowledge-base",
    subcategory: "concepts",
    lastUpdated: "2025-01-01",
    wordCount: 3500,
    readerImportance: 90,
    researchImportance: 80,
    tacticalValue: 70,
  },
  {
    id: "alignment",
    title: "Alignment",
    quality: null,
    riskLevel: "high",
    score: 45,
    total: 100,
    category: "knowledge-base",
    subcategory: "concepts",
    lastUpdated: "2024-06-15",
    wordCount: 1200,
    readerImportance: 95,
    researchImportance: 95,
    tacticalValue: 60,
  },
  {
    id: "rlhf",
    title: "RLHF",
    quality: 60,
    riskLevel: "medium",
    score: 58,
    total: 100,
    category: "knowledge-base",
    subcategory: "approaches",
    lastUpdated: "2025-02-01",
    wordCount: 2800,
    readerImportance: 75,
    researchImportance: 85,
    tacticalValue: 50,
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PageCoverageContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without throwing with coverage data", () => {
    vi.mocked(getPageCoverageItems).mockReturnValue(mockCoverageItems as never);

    const element = PageCoverageContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with empty data", () => {
    vi.mocked(getPageCoverageItems).mockReturnValue([]);

    const element = PageCoverageContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when all quality values are null", () => {
    const itemsWithoutQuality = mockCoverageItems.map((i) => ({
      ...i,
      quality: null,
    }));
    vi.mocked(getPageCoverageItems).mockReturnValue(
      itemsWithoutQuality as never
    );

    const element = PageCoverageContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when all items are high risk", () => {
    const allHighRisk = mockCoverageItems.map((i) => ({
      ...i,
      riskLevel: "high",
    }));
    vi.mocked(getPageCoverageItems).mockReturnValue(allHighRisk as never);

    const element = PageCoverageContent();
    expect(element).toBeTruthy();
  });
});
