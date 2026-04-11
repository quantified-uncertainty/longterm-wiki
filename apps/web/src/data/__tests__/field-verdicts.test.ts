import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

// Mock fs before importing the module under test
vi.mock("fs");
vi.mock("js-yaml", () => ({
  default: { load: vi.fn(() => []) },
}));
vi.mock("@lib/yaml", () => ({
  loadYaml: vi.fn(() => ({})),
}));
vi.mock("@lib/wiki-server", () => ({
  fetchFromWikiServer: vi.fn(async () => null),
  withApiFallback: vi.fn(
    async (_apiLoader: unknown, localLoader: () => unknown) => ({
      data: localLoader(),
      source: "local" as const,
    })
  ),
  fetchDetailed: vi.fn(async () => ({
    ok: false,
    error: { type: "not-configured" },
  })),
  getWikiServerConfig: vi.fn(() => null),
  dataSourceLabel: vi.fn((source: string) =>
    source === "api" ? "wiki-server API" : "local files"
  ),
}));

// Sample record-verdicts.json data that includes per-field entries
const mockRecordVerdicts = {
  // Whole-row verdict
  "grant:g_abc123": {
    verdict: "confirmed",
    confidence: 0.95,
    sourcesChecked: 2,
    needsRecheck: false,
    lastComputedAt: "2026-04-01T00:00:00Z",
  },
  // Per-field verdicts for the same record
  "grant:g_abc123:amount": {
    verdict: "confirmed",
    confidence: 0.99,
    sourcesChecked: 1,
    needsRecheck: false,
    lastComputedAt: "2026-04-01T00:00:00Z",
  },
  "grant:g_abc123:date": {
    verdict: "outdated",
    confidence: 0.7,
    sourcesChecked: 1,
    needsRecheck: true,
    lastComputedAt: "2026-03-15T00:00:00Z",
  },
  "grant:g_abc123:grantee": {
    verdict: "contradicted",
    confidence: 0.8,
    sourcesChecked: 1,
    needsRecheck: true,
    lastComputedAt: "2026-03-20T00:00:00Z",
  },
  // A different record with only a row-level verdict
  "grant:g_xyz789": {
    verdict: "partial",
    confidence: 0.6,
    sourcesChecked: 1,
    needsRecheck: false,
    lastComputedAt: "2026-04-02T00:00:00Z",
  },
};

// Mock minimal database.json (required by tablebase.ts module load)
const mockDatabase = {
  entities: [],
  typedEntities: [],
  pages: [],
  idRegistry: {},
  reverseIdRegistry: {},
};

beforeEach(() => {
  vi.resetModules();
  const mockedFs = vi.mocked(fs);
  mockedFs.existsSync.mockReturnValue(true);
  mockedFs.readFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
    const p = String(filePath);
    if (p.endsWith("record-verdicts.json")) {
      return JSON.stringify(mockRecordVerdicts);
    }
    if (p.endsWith("database.json")) {
      return JSON.stringify(mockDatabase);
    }
    return "{}";
  });
});

describe("getFieldVerdict", () => {
  it("returns the per-field verdict for a known field", async () => {
    const { getFieldVerdict } = await import("../tablebase");
    const verdict = getFieldVerdict("grant", "g_abc123", "amount");
    expect(verdict).not.toBeNull();
    expect(verdict!.verdict).toBe("confirmed");
    expect(verdict!.confidence).toBe(0.99);
  });

  it("returns null for an unknown field", async () => {
    const { getFieldVerdict } = await import("../tablebase");
    const verdict = getFieldVerdict("grant", "g_abc123", "nonexistent");
    expect(verdict).toBeNull();
  });

  it("returns null for a record with no per-field verdicts", async () => {
    const { getFieldVerdict } = await import("../tablebase");
    const verdict = getFieldVerdict("grant", "g_xyz789", "amount");
    expect(verdict).toBeNull();
  });

  it("returns null for a completely unknown record", async () => {
    const { getFieldVerdict } = await import("../tablebase");
    const verdict = getFieldVerdict("grant", "g_unknown", "amount");
    expect(verdict).toBeNull();
  });

  it("does not confuse row-level and field-level verdicts", async () => {
    const { getRecordVerdict, getFieldVerdict } = await import("../tablebase");
    // Row-level should return the whole-row verdict
    const rowVerdict = getRecordVerdict("grant", "g_abc123");
    expect(rowVerdict).not.toBeNull();
    expect(rowVerdict!.verdict).toBe("confirmed");

    // Field-level for "amount" should return a different confidence
    const fieldVerdict = getFieldVerdict("grant", "g_abc123", "amount");
    expect(fieldVerdict).not.toBeNull();
    expect(fieldVerdict!.confidence).toBe(0.99);
  });
});

describe("getFieldVerdicts", () => {
  it("returns all per-field verdicts for a record", async () => {
    const { getFieldVerdicts } = await import("../tablebase");
    const verdicts = getFieldVerdicts("grant", "g_abc123");
    expect(Object.keys(verdicts)).toHaveLength(3);
    expect(verdicts).toHaveProperty("amount");
    expect(verdicts).toHaveProperty("date");
    expect(verdicts).toHaveProperty("grantee");
    expect(verdicts.amount.verdict).toBe("confirmed");
    expect(verdicts.date.verdict).toBe("outdated");
    expect(verdicts.grantee.verdict).toBe("contradicted");
  });

  it("returns an empty object for a record with no field verdicts", async () => {
    const { getFieldVerdicts } = await import("../tablebase");
    const verdicts = getFieldVerdicts("grant", "g_xyz789");
    expect(verdicts).toEqual({});
  });

  it("returns an empty object for an unknown record", async () => {
    const { getFieldVerdicts } = await import("../tablebase");
    const verdicts = getFieldVerdicts("grant", "g_unknown");
    expect(verdicts).toEqual({});
  });

  it("does not include the row-level verdict in the field verdicts map", async () => {
    const { getFieldVerdicts } = await import("../tablebase");
    const verdicts = getFieldVerdicts("grant", "g_abc123");
    // The key "grant:g_abc123" (no field name) should not appear
    // as a field in the result
    for (const key of Object.keys(verdicts)) {
      expect(key).not.toBe("");
      expect(key).not.toContain(":");
    }
  });
});
