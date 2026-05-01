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

describe("strict-fail counter (QUA-953)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns an empty stats object before getTypedEntities is called", async () => {
    const { getStrictFailStats, _resetStrictFailStatsForTests } = await import(
      "../tablebase"
    );
    _resetStrictFailStatsForTests();
    const stats = getStrictFailStats();
    expect(stats.populated).toBe(false);
    expect(stats.fallthroughCount).toBe(0);
    expect(stats.hardFailCount).toBe(0);
    expect(stats.totalEntities).toBe(0);
    expect(stats.byType).toEqual({});
    expect(stats.populatedAt).toBeNull();
  });

  it("counts zero fall-throughs when all entities pass the strict schema", async () => {
    mockReadFile(buildMockDatabase());
    const {
      getTypedEntities,
      getStrictFailStats,
      _resetStrictFailStatsForTests,
    } = await import("../tablebase");
    _resetStrictFailStatsForTests();

    getTypedEntities();
    const stats = getStrictFailStats();

    expect(stats.populated).toBe(true);
    expect(stats.fallthroughCount).toBe(0);
    expect(stats.hardFailCount).toBe(0);
    expect(stats.totalEntities).toBe(1);
    expect(stats.byType).toEqual({});
    expect(stats.populatedAt).not.toBeNull();
  });

  it("increments fallthroughCount and bucketing by entityType for unknown types", async () => {
    mockReadFile(
      buildMockDatabase([
        // Unknown entity type → falls through to GenericEntityPassthroughSchema
        {
          id: "weird-1",
          entityType: "weirdType",
          title: "Weird One",
          description: "first",
        },
        {
          id: "weird-2",
          entityType: "weirdType",
          title: "Weird Two",
          description: "second",
        },
        {
          id: "other-1",
          entityType: "otherWeirdType",
          title: "Other Weird",
          description: "third",
        },
      ]),
    );

    const {
      getTypedEntities,
      getStrictFailStats,
      _resetStrictFailStatsForTests,
    } = await import("../tablebase");
    _resetStrictFailStatsForTests();

    getTypedEntities();
    const stats = getStrictFailStats();

    expect(stats.populated).toBe(true);
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

    const {
      getTypedEntities,
      getStrictFailStats,
      _resetStrictFailStatsForTests,
    } = await import("../tablebase");
    _resetStrictFailStatsForTests();

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

    const {
      getTypedEntities,
      getStrictFailStats,
      _resetStrictFailStatsForTests,
    } = await import("../tablebase");
    _resetStrictFailStatsForTests();

    getTypedEntities();
    const stats = getStrictFailStats();

    expect(stats.byType.manyWeird?.count).toBe(8);
    expect(stats.byType.manyWeird?.samples.length).toBe(5);
  });

  it("returns a defensive copy from getStrictFailStats (mutating the result does not affect internal state)", async () => {
    mockReadFile(
      buildMockDatabase([
        {
          id: "weird-1",
          entityType: "weirdType",
          title: "Weird",
          description: "x",
        },
      ]),
    );

    const {
      getTypedEntities,
      getStrictFailStats,
      _resetStrictFailStatsForTests,
    } = await import("../tablebase");
    _resetStrictFailStatsForTests();

    getTypedEntities();
    const a = getStrictFailStats();
    a.fallthroughCount = 999;
    a.byType.weirdType!.count = 999;
    a.byType.weirdType!.samples.push({
      id: "injected",
      fieldPath: "x",
      message: "x",
    });

    const b = getStrictFailStats();
    expect(b.fallthroughCount).toBe(1);
    expect(b.byType.weirdType?.count).toBe(1);
    expect(b.byType.weirdType?.samples.length).toBe(1);
  });

  it("counts hardFailCount when even GenericEntityPassthroughSchema fails", async () => {
    mockReadFile(
      buildMockDatabase([
        // Missing required base fields (id, entityType, title) → strict + generic both fail
        { description: "no id, no type, no title" },
      ]),
    );

    const {
      getTypedEntities,
      getStrictFailStats,
      _resetStrictFailStatsForTests,
    } = await import("../tablebase");
    _resetStrictFailStatsForTests();

    getTypedEntities();
    const stats = getStrictFailStats();

    expect(stats.fallthroughCount).toBe(1);
    expect(stats.hardFailCount).toBe(1);
  });
});
