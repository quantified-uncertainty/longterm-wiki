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

// ── QUA-423 phase 2: runtime guard in getRecordVerdict + getFieldVerdict ──
//
// The QUA-417 bug was callers passing a composite React key (`${owner}-${id}`)
// to getRecordVerdict. Before phase 2 this silently returned null (the key
// didn't exist in the verdict map); now it explicitly returns null at the
// guard, logs a dev-mode warning, and skips the map lookup entirely.

describe("getRecordVerdict / getFieldVerdict — QUA-423 composite-key guard", () => {
  beforeEach(() => {
    vi.resetModules();
    const mockVerdicts = buildMockVerdicts();
    vi.mocked(fs.readFileSync).mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.includes("record-verdicts.json")) return JSON.stringify(mockVerdicts);
      if (p.includes("database.json")) return JSON.stringify(mockDatabase);
      if (p.includes("factbase-data.json")) {
        return JSON.stringify({ entities: {}, facts: {}, slugToEntityId: {} });
      }
      return "{}";
    });
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it("returns the verdict for a valid raw record PK", async () => {
    const { getRecordVerdict } = await import("../tablebase");
    const v = getRecordVerdict("grant", "g_001");
    expect(v?.verdict).toBe("confirmed");
  });

  it("returns null for the QUA-417 composite-key shape (no silent lookup)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getRecordVerdict } = await import("../tablebase");

    // sid_-prefixed composite (the exact shape that shipped)
    const v = getRecordVerdict("grant", "sid_ULjDXpSLCI-g_001");
    expect(v).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("getRecordVerdict");
    expect(String(warn.mock.calls[0][0])).toMatch(/QUA-417/);
    warn.mockRestore();
  });

  it("returns null on empty string recordId (caller forgot a guard)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getRecordVerdict } = await import("../tablebase");
    expect(getRecordVerdict("grant", "")).toBeNull();
    warn.mockRestore();
  });

  it("does NOT flag legitimate hyphenated IDs (false-positive guard)", async () => {
    const { getRecordVerdict } = await import("../tablebase");
    // Expect null because the key isn't in the mock, but the guard should
    // NOT short-circuit and warn — these are legitimate IDs.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getRecordVerdict("wiki-page", "some-name-2024")).toBeNull();
    expect(getRecordVerdict("publication", "arxiv-2310-12345")).toBeNull();
    // No warnings fired for these shapes.
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toMatch(/QUA-417/);
    }
    warn.mockRestore();
  });

  it("getFieldVerdict applies the same guard", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getFieldVerdict } = await import("../tablebase");

    // Valid: returns the per-field verdict
    expect(getFieldVerdict("grant", "g_001", "amount")?.verdict).toBe("confirmed");

    // Composite key: guarded
    const v = getFieldVerdict("grant", "sid_abc-sid_def", "amount");
    expect(v).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("getFieldVerdict");
    warn.mockRestore();
  });
});
