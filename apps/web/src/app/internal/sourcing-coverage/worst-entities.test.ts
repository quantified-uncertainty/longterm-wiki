import { describe, expect, it } from "vitest";
import type { RpcEntitySummaryRow } from "@lib/wiki-server";
import {
  computeNonGreenCount,
  computeWorstEntities,
  type EntityResolver,
  type WorstEntityRow,
} from "./worst-entities";

function row(overrides: Partial<RpcEntitySummaryRow> = {}): RpcEntitySummaryRow {
  return {
    entityId: "anthropic",
    confirmed: 0,
    contradicted: 0,
    outdated: 0,
    partial: 0,
    unverifiable: 0,
    unchecked: 0,
    totalVerdicts: 0,
    avgConfidence: 0,
    totalRecords: 0,
    ...overrides,
  };
}

/** Resolver that returns a canned display for known IDs, raw ID otherwise. */
function makeResolver(
  table: Record<string, { name: string; href: string }> = {},
): EntityResolver {
  return (entityId) =>
    table[entityId] ?? { name: entityId, href: `/wiki/${entityId}` };
}

const fallbackResolver = makeResolver();

describe("computeNonGreenCount", () => {
  it("sums contradicted + outdated + partial + unverifiable + unchecked", () => {
    expect(
      computeNonGreenCount(
        row({
          confirmed: 100,
          contradicted: 2,
          outdated: 3,
          partial: 1,
          unverifiable: 4,
          unchecked: 5,
        }),
      ),
    ).toBe(15);
  });

  it("returns 0 when every record is confirmed", () => {
    expect(computeNonGreenCount(row({ confirmed: 50 }))).toBe(0);
  });

  it("ignores confirmed in the tally", () => {
    // A bug that double-counted confirmed would return 10 here, not 5.
    expect(
      computeNonGreenCount(
        row({ confirmed: 5, contradicted: 3, outdated: 2 }),
      ),
    ).toBe(5);
  });
});

describe("computeWorstEntities", () => {
  it("drops entities with zero non-green verdicts", () => {
    const summaries = [
      row({ entityId: "clean-corp", confirmed: 10 }),
      row({ entityId: "dirty-corp", contradicted: 3 }),
    ];
    const result = computeWorstEntities(summaries, fallbackResolver);
    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe("dirty-corp");
  });

  it("sorts by nonGreenCount descending", () => {
    const summaries = [
      row({ entityId: "a", contradicted: 5 }), // 5
      row({ entityId: "b", outdated: 12 }), // 12
      row({ entityId: "c", unchecked: 8 }), // 8
    ];
    const result = computeWorstEntities(summaries, fallbackResolver);
    expect(result.map((r) => r.entityId)).toEqual(["b", "c", "a"]);
    expect(result.map((r) => r.nonGreenCount)).toEqual([12, 8, 5]);
  });

  it("breaks ties by totalRecords descending (bigger entities rank higher)", () => {
    const summaries = [
      row({ entityId: "tiny", contradicted: 3, totalRecords: 5 }),
      row({ entityId: "huge", contradicted: 3, totalRecords: 500 }),
      row({ entityId: "mid", contradicted: 3, totalRecords: 50 }),
    ];
    const result = computeWorstEntities(summaries, fallbackResolver);
    expect(result.map((r) => r.entityId)).toEqual(["huge", "mid", "tiny"]);
  });

  it("caps the output at the requested limit", () => {
    const summaries = Array.from({ length: 30 }, (_, i) =>
      row({ entityId: `e${i}`, contradicted: i + 1 }),
    );
    const result = computeWorstEntities(summaries, fallbackResolver, 5);
    expect(result).toHaveLength(5);
    // Top 5 should be the 5 highest contradicted counts: e29, e28, e27, e26, e25
    expect(result.map((r) => r.entityId)).toEqual(["e29", "e28", "e27", "e26", "e25"]);
  });

  it("defaults the limit to 20", () => {
    const summaries = Array.from({ length: 25 }, (_, i) =>
      row({ entityId: `e${i}`, contradicted: i + 1 }),
    );
    const result = computeWorstEntities(summaries, fallbackResolver);
    expect(result).toHaveLength(20);
  });

  it("resolves display name and href from the resolver when known", () => {
    const summaries = [row({ entityId: "anthropic", contradicted: 1 })];
    const result = computeWorstEntities(
      summaries,
      makeResolver({
        anthropic: { name: "Anthropic", href: "/wiki/E42" },
      }),
    );
    expect(result[0].displayName).toBe("Anthropic");
    expect(result[0].href).toBe("/wiki/E42");
  });

  it("falls back to resolver's default for unknown IDs", () => {
    const summaries = [row({ entityId: "mystery-entity", contradicted: 1 })];
    const result = computeWorstEntities(summaries, fallbackResolver);
    expect(result[0].displayName).toBe("mystery-entity");
    expect(result[0].href).toBe("/wiki/mystery-entity");
  });

  it("renders every row even when no IDs resolve to a friendly name", () => {
    // Guards against a past shape where missing lookups returned no row at all.
    const summaries = [
      row({ entityId: "x1", contradicted: 5 }),
      row({ entityId: "x2", contradicted: 3 }),
    ];
    const result = computeWorstEntities(summaries, fallbackResolver);
    expect(result).toHaveLength(2);
    expect(result[0].displayName).toBe("x1");
    expect(result[1].displayName).toBe("x2");
  });

  it("limit=0 returns an empty array (documented behavior)", () => {
    const summaries = [row({ entityId: "a", contradicted: 1 })];
    expect(computeWorstEntities(summaries, fallbackResolver, 0)).toEqual([]);
  });

  it("keeps the full per-verdict breakdown on each row", () => {
    const summaries = [
      row({
        entityId: "acme",
        contradicted: 2,
        outdated: 3,
        partial: 1,
        unverifiable: 4,
        unchecked: 5,
        totalVerdicts: 15,
        totalRecords: 100,
      }),
    ];
    const result = computeWorstEntities(summaries, fallbackResolver);
    const r: WorstEntityRow = result[0];
    expect(r.contradicted).toBe(2);
    expect(r.outdated).toBe(3);
    expect(r.partial).toBe(1);
    expect(r.unverifiable).toBe(4);
    expect(r.unchecked).toBe(5);
    expect(r.totalVerdicts).toBe(15);
    expect(r.totalRecords).toBe(100);
    expect(r.nonGreenCount).toBe(15);
  });

  it("returns an empty array for empty input", () => {
    expect(computeWorstEntities([], fallbackResolver)).toEqual([]);
  });

  it("works with only unchecked verdicts (no contradicted)", () => {
    // A previously-speculated bug: ranking ignored unchecked records.
    const summaries = [
      row({ entityId: "all-unchecked", unchecked: 7 }),
      row({ entityId: "mix", contradicted: 5 }),
    ];
    const result = computeWorstEntities(summaries, fallbackResolver);
    expect(result.map((r) => r.entityId)).toEqual(["all-unchecked", "mix"]);
  });
});
