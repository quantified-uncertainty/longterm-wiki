/**
 * Render smoke tests for the Entities dashboard content component.
 *
 * EntitiesContent reads from local database.json via multiple data functions
 * and fetches source-check data from wiki-server. These tests verify the
 * component renders without throwing for typical and edge-case data shapes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ────────────────────────────────────────────────────────

vi.mock("@/data", () => ({
  getTypedEntities: vi.fn(),
  getTypedEntityById: vi.fn(),
  getEntityHref: vi.fn(),
  getPageById: vi.fn(),
  getPageCoverageItems: vi.fn(),
  getPageRankings: vi.fn(),
  getIdRegistry: vi.fn(() => ({
    byWikiId: {},
    bySlug: {},
    stableIdToSlug: {},
    stableIdBySlug: {},
  })),
}));

vi.mock("@lib/wiki-server", () => ({
  fetchDetailed: vi.fn(() => Promise.resolve({ ok: false, error: "mock" })),
}));

vi.mock("@/data/entity-coverage", () => ({
  getEntityDataDepth: vi.fn(() => null),
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
import { fetchDetailed } from "@lib/wiki-server";
import { EntitiesContent } from "@/app/internal/entities/entities-content";

// ── Mock data ────────────────────────────────────────────────────────────────

const mockEntities = [
  {
    id: "openai",
    wikiId: "E1",
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
    wikiId: "E2",
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
    wikiId: null,
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
    vi.mocked(fetchDetailed).mockResolvedValue({ ok: false, error: "mock" } as never);
  });

  it("renders without throwing with entity data", async () => {
    vi.mocked(getTypedEntities).mockReturnValue(mockEntities as never);

    const element = await EntitiesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with empty entities", async () => {
    vi.mocked(getTypedEntities).mockReturnValue([]);

    const element = await EntitiesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when entities have pages", async () => {
    vi.mocked(getTypedEntities).mockReturnValue(mockEntities as never);
    vi.mocked(getPageById).mockImplementation((id: string) => {
      if (id === "openai")
        return { id: "openai", title: "OpenAI" } as never;
      return undefined;
    });

    const element = await EntitiesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing with coverage and ranking data", async () => {
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

    const element = await EntitiesContent();
    expect(element).toBeTruthy();
  });

  it("renders without throwing when all descriptions are null", async () => {
    const entitiesNoDesc = mockEntities.map((e) => ({
      ...e,
      description: null,
    }));
    vi.mocked(getTypedEntities).mockReturnValue(entitiesNoDesc as never);

    const element = await EntitiesContent();
    expect(element).toBeTruthy();
  });

  it("merges source-check data when API is available", async () => {
    vi.mocked(getTypedEntities).mockReturnValue(mockEntities as never);
    vi.mocked(fetchDetailed).mockResolvedValue({
      ok: true,
      data: {
        summaries: [
          {
            entityId: "openai",
            confirmed: 10,
            contradicted: 2,
            outdated: 1,
            partial: 0,
            unverifiable: 3,
            unchecked: 5,
            totalVerdicts: 21,
            avgConfidence: 0.85,
            totalRecords: 30,
          },
        ],
      },
    } as never);

    const element = await EntitiesContent();
    expect(element).toBeTruthy();
  });
});
