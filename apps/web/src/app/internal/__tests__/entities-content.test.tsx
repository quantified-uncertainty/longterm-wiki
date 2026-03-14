/**
 * Render smoke tests for the Entities dashboard content component.
 *
 * EntitiesContent reads from local database.json via multiple data functions
 * and builds a unified entity row view. These tests verify the component
 * renders without throwing for typical and edge-case data shapes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@/data", () => ({
  getTypedEntities: vi.fn(),
  getEntityHref: vi.fn(),
  getPageById: vi.fn(),
  getPageCoverageItems: vi.fn(),
  getPageRankings: vi.fn(),
}));

vi.mock("@/app/internal/entities/entities-data-table", () => ({
  EntitiesDataTable: () => null,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  getTypedEntities,
  getEntityHref,
  getPageById,
  getPageCoverageItems,
  getPageRankings,
} from "@/data";
import { EntitiesContent } from "@/app/internal/entities/entities-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockEntities = [
  {
    id: "openai",
    numericId: "E1",
    entityType: "organization",
    title: "OpenAI",
    description: "AI research laboratory",
    status: "active",
    tags: ["frontier-lab"],
    relatedEntries: [{ id: "anthropic" }],
    lastUpdated: "2025-01-01",
  },
  {
    id: "anthropic",
    numericId: "E2",
    entityType: "organization",
    title: "Anthropic",
    description: null,
    status: null,
    tags: [],
    relatedEntries: null,
    lastUpdated: null,
  },
  {
    id: "existential-risk",
    numericId: null,
    entityType: "concept",
    title: "Existential Risk",
    description: "Risks that threaten human extinction",
    status: null,
    tags: ["core-concept"],
    relatedEntries: [],
    lastUpdated: "2024-12-01",
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("EntitiesContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPageCoverageItems).mockReturnValue([]);
    vi.mocked(getPageRankings).mockReturnValue([]);
    vi.mocked(getEntityHref).mockReturnValue("/wiki/E1");
    vi.mocked(getPageById).mockReturnValue(undefined);
  });

  it("renders without throwing with entity data", () => {
    vi.mocked(getTypedEntities).mockReturnValue(mockEntities as never);

    const element = EntitiesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with empty entities", () => {
    vi.mocked(getTypedEntities).mockReturnValue([]);

    const element = EntitiesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when entities have pages", () => {
    vi.mocked(getTypedEntities).mockReturnValue(mockEntities as never);
    vi.mocked(getPageById).mockImplementation((id: string) => {
      if (id === "openai")
        return { id: "openai", title: "OpenAI" } as never;
      return undefined;
    });

    const element = EntitiesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with coverage and ranking data", () => {
    vi.mocked(getTypedEntities).mockReturnValue(mockEntities as never);
    vi.mocked(getPageCoverageItems).mockReturnValue([
      {
        id: "openai",
        quality: 80,
        readerImportance: 90,
        researchImportance: 85,
        tacticalValue: 70,
        score: 75,
        total: 100,
        riskLevel: "low",
        riskScore: 15,
        category: "knowledge-base",
        subcategory: "organizations",
        lastUpdated: "2025-01-01",
        wordCount: 5000,
      },
    ] as never);
    vi.mocked(getPageRankings).mockReturnValue([
      {
        id: "openai",
        quality: 80,
        readerImportance: 90,
        researchImportance: 85,
        readerRank: 1,
        researchRank: 2,
        wordCount: 5000,
        category: "knowledge-base",
      },
    ] as never);

    const element = EntitiesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when all descriptions are null", () => {
    const entitiesNoDesc = mockEntities.map((e) => ({
      ...e,
      description: null,
    }));
    vi.mocked(getTypedEntities).mockReturnValue(entitiesNoDesc as never);

    const element = EntitiesContent();
    expect(element).toBeTruthy();
  });
});
