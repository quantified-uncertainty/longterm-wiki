/**
 * Strict-fail counter tests (QUA-953).
 *
 * Verifies that getTypedEntities() correctly tracks fall-throughs from
 * TypedEntitySchema.safeParse to GenericEntityPassthroughSchema.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

vi.mock("fs");
vi.mock("js-yaml", () => ({ default: { load: vi.fn(() => []) } }));
vi.mock("@lib/wiki-server", () => ({
  fetchFromWikiServer: vi.fn(async () => null),
  withApiFallback: vi.fn(async (_apiLoader: unknown, localLoader: () => unknown) => ({
    data: localLoader(),
    source: "local" as const,
  })),
  fetchDetailed: vi.fn(async () => ({ ok: false, error: { type: "not-configured" } })),
  getWikiServerConfig: vi.fn(() => null),
  dataSourceLabel: vi.fn(() => "local files"),
}));

const baseEntity = {
  tags: [],
  clusters: [],
  relatedEntries: [],
  sources: [],
  customFields: [],
  relatedTopics: [],
};

function buildMockDatabase(extra: object[] = []) {
  return {
    entities: [],
    typedEntities: [
      // Valid risk — passes strict schema
      {
        id: "valid-risk",
        entityType: "risk",
        title: "Valid Risk",
        description: "ok",
        riskCategory: "accident",
        ...baseEntity,
      },
      ...extra,
    ],
    resources: [],
    publications: [],
    organizations: [],
    pathRegistry: {},
    idRegistry: { byWikiId: {}, bySlug: {} },
    pages: [],
    stats: {},
  };
}

function mockReadFile(database: object) {
  vi.mocked(fs.readFileSync).mockImplementation((filepath: unknown) => {
    const fp = String(filepath);
    if (fp.endsWith("database.json")) {
      return JSON.stringify(database);
    }
    return "{}";
  });
}

async function loadFreshTablebase() {
  const mod = await import("../tablebase");
  mod._resetStrictFailStatsForTests();
  return mod;
}

describe("strict-fail counter (QUA-953)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns an empty stats object before getTypedEntities is called", async () => {
    const { getStrictFailStats } = await loadFreshTablebase();
    const stats = getStrictFailStats();
    expect(stats.populatedAt).toBeNull();
    expect(stats.fallthroughCount).toBe(0);
    expect(stats.hardFailCount).toBe(0);
    expect(stats.totalEntities).toBe(0);
    expect(stats.byType).toEqual({});
  });

  it("counts zero fall-throughs when all entities pass the strict schema", async () => {
    mockReadFile(buildMockDatabase());
    const { getTypedEntities, getStrictFailStats } = await loadFreshTablebase();

    getTypedEntities();
    const stats = getStrictFailStats();

    expect(stats.populatedAt).not.toBeNull();
    expect(stats.fallthroughCount).toBe(0);
    expect(stats.hardFailCount).toBe(0);
    expect(stats.totalEntities).toBe(1);
    expect(stats.byType).toEqual({});
  });

  it("increments fallthroughCount and bucketing by entityType for unknown types", async () => {
    mockReadFile(
      buildMockDatabase([
        { id: "weird-1", entityType: "weirdType", title: "Weird One", description: "first" },
        { id: "weird-2", entityType: "weirdType", title: "Weird Two", description: "second" },
        { id: "other-1", entityType: "otherWeirdType", title: "Other Weird", description: "third" },
      ]),
    );

    const { getTypedEntities, getStrictFailStats } = await loadFreshTablebase();
    getTypedEntities();
    const stats = getStrictFailStats();

    expect(stats.fallthroughCount).toBe(3);
    expect(stats.hardFailCount).toBe(0);
    expect(stats.totalEntities).toBe(4);
    expect(stats.byType.weirdType?.count).toBe(2);
    expect(stats.byType.otherWeirdType?.count).toBe(1);
    expect(stats.byType.weirdType?.samples.length).toBe(2);
    expect(stats.byType.weirdType?.samples[0]?.id).toBe("weird-1");
    expect(stats.byType.otherWeirdType?.samples[0]?.id).toBe("other-1");
  });

  it("captures field path and message for the first failing issue", async () => {
    mockReadFile(
      buildMockDatabase([
        // entityType is 'risk' but severity has an invalid enum value → strict fail with a field path
        {
          id: "risk-bad-severity",
          entityType: "risk",
          title: "Risk Bad Severity",
          description: "bad enum",
          severity: "totally-invalid-severity",
          ...baseEntity,
        },
      ]),
    );

    const { getTypedEntities, getStrictFailStats } = await loadFreshTablebase();
    getTypedEntities();
    const stats = getStrictFailStats();

    expect(stats.fallthroughCount).toBe(1);
    const sample = stats.byType.risk?.samples[0];
    expect(sample?.id).toBe("risk-bad-severity");
    expect(sample?.fieldPath).toBe("severity");
    expect(sample?.message.length).toBeGreaterThan(0);
  });

  it("caps samples per type at 5", async () => {
    const extras = Array.from({ length: 8 }, (_, i) => ({
      id: `weird-${i}`,
      entityType: "manyWeird",
      title: `Weird ${i}`,
      description: `n${i}`,
    }));
    mockReadFile(buildMockDatabase(extras));

    const { getTypedEntities, getStrictFailStats } = await loadFreshTablebase();
    getTypedEntities();
    const stats = getStrictFailStats();

    expect(stats.byType.manyWeird?.count).toBe(8);
    expect(stats.byType.manyWeird?.samples.length).toBe(5);
  });

  it("getStrictFailStats returns a deep copy — caller mutations never leak back", async () => {
    mockReadFile(
      buildMockDatabase([
        { id: "weird-1", entityType: "weirdType", title: "Weird", description: "x" },
      ]),
    );

    const { getTypedEntities, getStrictFailStats } = await loadFreshTablebase();
    getTypedEntities();

    const a = getStrictFailStats();
    a.fallthroughCount = 999;
    if (a.byType.weirdType) {
      a.byType.weirdType.count = 999;
      a.byType.weirdType.samples.push({ id: "injected", fieldPath: "x", message: "x" });
      if (a.byType.weirdType.samples[0]) {
        a.byType.weirdType.samples[0].id = "MUTATED";
        a.byType.weirdType.samples[0].fieldPath = "MUTATED";
        a.byType.weirdType.samples[0].message = "MUTATED";
      }
    }

    const b = getStrictFailStats();
    expect(b.fallthroughCount).toBe(1);
    expect(b.byType.weirdType?.count).toBe(1);
    expect(b.byType.weirdType?.samples.length).toBe(1);
    expect(b.byType.weirdType?.samples[0]?.id).toBe("weird-1");
    expect(b.byType.weirdType?.samples[0]?.fieldPath).not.toBe("MUTATED");
    expect(b.byType.weirdType?.samples[0]?.message).not.toBe("MUTATED");
  });

  it("counts hardFailCount when even GenericEntityPassthroughSchema fails", async () => {
    mockReadFile(
      buildMockDatabase([
        // Missing required BaseEntity fields (id, title) → strict + generic both fail.
        { description: "no id, no title" },
      ]),
    );

    const { getTypedEntities, getStrictFailStats, STRICT_FAIL_UNKNOWN_LABEL } =
      await loadFreshTablebase();
    getTypedEntities();
    const stats = getStrictFailStats();

    expect(stats.fallthroughCount).toBe(1);
    expect(stats.hardFailCount).toBe(1);
    // The fall-through is bucketed under the unknown-label sentinel because
    // entityType is missing; sample message should reflect a base-field
    // validation failure (id/title required) rather than something accidental.
    const samples = stats.byType[STRICT_FAIL_UNKNOWN_LABEL]?.samples ?? [];
    expect(samples.length).toBe(1);
    expect(samples[0]?.id).toBe(STRICT_FAIL_UNKNOWN_LABEL);
    expect(samples[0]?.message.length).toBeGreaterThan(0);
  });

  it("_resetStrictFailStatsForTests throws outside test environments", async () => {
    const { _resetStrictFailStatsForTests } = await import("../tablebase");
    const env = process.env as Record<string, string | undefined>;
    const originalNodeEnv = env.NODE_ENV;
    const originalVitest = env.VITEST;
    try {
      env.NODE_ENV = "production";
      delete env.VITEST;
      expect(() => _resetStrictFailStatsForTests()).toThrow(
        /only callable in test environments/,
      );
    } finally {
      env.NODE_ENV = originalNodeEnv;
      if (originalVitest !== undefined) env.VITEST = originalVitest;
    }
  });
});
