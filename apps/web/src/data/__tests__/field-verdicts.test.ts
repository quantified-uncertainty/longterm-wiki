import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

// Mock fs before importing the module under test
vi.mock("fs");
vi.mock("js-yaml", () => ({
  default: { load: vi.fn(() => []) },
}));
vi.mock("@lib/yaml", () => ({
  loadYaml: vi.fn(() => []),
}));
vi.mock("@lib/wiki-server", () => ({
  fetchFromWikiServer: vi.fn(async () => null),
  withApiFallback: vi.fn(
    async (_apiLoader: unknown, localLoader: () => unknown) => ({
      data: localLoader(),
      source: "local" as const,
    }),
  ),
  fetchDetailed: vi.fn(async () => ({
    ok: false,
    error: { type: "not-configured" },
  })),
  getWikiServerConfig: vi.fn(() => null),
  dataSourceLabel: vi.fn((source: string) =>
    source === "api" ? "wiki-server API" : "local files",
  ),
}));

/**
 * Build a mock record-verdicts.json with both row-level and per-field entries.
 *
 * Row-level keys are two segments:  "grant:g_abc123"
 * Per-field keys are three segments: "grant:g_abc123:amount"
 */
function buildMockVerdicts() {
  return {
    // Row-level entries (should be counted)
    "grant:g_001": {
      verdict: "confirmed",
      confidence: 0.9,
      sourcesChecked: 2,
      needsRecheck: false,
      lastComputedAt: "2026-04-01",
    },
    "grant:g_002": {
      verdict: "contradicted",
      confidence: 0.8,
      sourcesChecked: 1,
      needsRecheck: false,
      lastComputedAt: "2026-04-01",
    },
    "grant:g_003": {
      verdict: "partial",
      confidence: 0.7,
      sourcesChecked: 3,
      needsRecheck: false,
      lastComputedAt: "2026-04-01",
    },
    // Per-field entries (should NOT be counted by getRecordVerdictStats)
    "grant:g_001:amount": {
      verdict: "confirmed",
      confidence: 0.95,
      sourcesChecked: 1,
      needsRecheck: false,
      lastComputedAt: "2026-04-01",
    },
    "grant:g_001:recipient": {
      verdict: "contradicted",
      confidence: 0.6,
      sourcesChecked: 1,
      needsRecheck: false,
      lastComputedAt: "2026-04-01",
    },
    "grant:g_002:amount": {
      verdict: "outdated",
      confidence: 0.5,
      sourcesChecked: 1,
      needsRecheck: true,
      lastComputedAt: "2026-03-01",
    },
    // Different record type (should not be counted for "grant")
    "investment:i_001": {
      verdict: "confirmed",
      confidence: 0.9,
      sourcesChecked: 2,
      needsRecheck: false,
      lastComputedAt: "2026-04-01",
    },
  };
}

// Minimal database.json mock — just enough fields to avoid import crashes
const mockDatabase = {
  entities: [],
  typedEntities: [],
  pages: [],
  resources: [],
  insights: [],
  entityLinks: {},
  backlinks: {},
  redirects: {},
  deadLinks: {},
  externalLinksMap: {},
  exploreItems: [],
  idRegistry: {},
  reverseIdRegistry: {},
  graphs: [],
  policyStakeholderIds: {},
};

describe("getRecordVerdictStats — per-field entry filtering", () => {
  beforeEach(() => {
    // Reset module cache so the singleton _recordVerdicts is cleared between tests
    vi.resetModules();

    const mockVerdicts = buildMockVerdicts();

    // Mock readFileSync to return our test data
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.includes("record-verdicts.json")) {
        return JSON.stringify(mockVerdicts);
      }
      if (p.includes("database.json")) {
        return JSON.stringify(mockDatabase);
      }
      if (p.includes("factbase-data.json")) {
        return JSON.stringify({
          entities: {},
          facts: {},
          slugToEntityId: {},
        });
      }
      return "{}";
    });

    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it("counts only row-level entries, not per-field entries", async () => {
    const { getRecordVerdictStats } = await import("../tablebase");

    const stats = getRecordVerdictStats("grant");

    // Should only count the 3 row-level grant entries, not the 3 per-field ones
    expect(stats.total).toBe(3);
    expect(stats.confirmed).toBe(1); // g_001
    expect(stats.contradicted).toBe(1); // g_002
    expect(stats.partial).toBe(1); // g_003
    expect(stats.outdated).toBe(0);
    expect(stats.unverifiable).toBe(0);
    expect(stats.unchecked).toBe(0);
  });

  it("does not count entries from other record types", async () => {
    const { getRecordVerdictStats } = await import("../tablebase");

    const stats = getRecordVerdictStats("investment");

    expect(stats.total).toBe(1);
    expect(stats.confirmed).toBe(1);
  });

  it("returns all zeros for a record type with no entries", async () => {
    const { getRecordVerdictStats } = await import("../tablebase");

    const stats = getRecordVerdictStats("nonexistent");

    expect(stats.total).toBe(0);
    expect(stats.confirmed).toBe(0);
    expect(stats.contradicted).toBe(0);
  });
});
