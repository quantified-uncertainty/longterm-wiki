import { describe, it, expect, beforeEach } from "vitest";
import { createBaseMockSql } from "./test-utils.js";
import { resolveResourceIds } from "../routes/shared/resolve-resource-id.js";

interface ResourceRow {
  id: string;
  stable_id: string | null;
}
let resourcesStore: Map<string, ResourceRow>;

function resetStore() {
  resourcesStore = new Map();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  if (q.includes("from resources") && q.includes("where id = any") && q.includes("stable_id = any")) {
    // Each ${unique} interpolation produces a separate bind parameter.
    const idSet = new Set(params[0] as string[]);
    const stableSet = new Set(params[1] as string[]);
    const out: ResourceRow[] = [];
    for (const row of resourcesStore.values()) {
      if (idSet.has(row.id) || (row.stable_id != null && stableSet.has(row.stable_id))) {
        out.push(row);
      }
    }
    return out;
  }

  throw new Error(`Unmatched query in test dispatcher: ${query}`);
}

const mockSql = createBaseMockSql(dispatch);

describe("resolveResourceIds", () => {
  beforeEach(() => {
    resetStore();
  });

  it("returns empty missing list on empty input", async () => {
    const result = await resolveResourceIds(mockSql, []);
    expect(result.missing).toEqual([]);
  });

  it("translates hex16 → canonical stable_id", async () => {
    resourcesStore.set("deadbeef00000001", {
      id: "deadbeef00000001",
      stable_id: "sid_AbCdEfGhIj",
    });

    const result = await resolveResourceIds(mockSql, ["deadbeef00000001"]);
    expect(result.missing).toEqual([]);
    expect(result.resolve("deadbeef00000001")).toBe("sid_AbCdEfGhIj");
  });

  it("passes sid_ through unchanged", async () => {
    resourcesStore.set("deadbeef00000002", {
      id: "deadbeef00000002",
      stable_id: "sid_KlMnOpQrSt",
    });

    const result = await resolveResourceIds(mockSql, ["sid_KlMnOpQrSt"]);
    expect(result.missing).toEqual([]);
    expect(result.resolve("sid_KlMnOpQrSt")).toBe("sid_KlMnOpQrSt");
  });

  it("resolves both hex16 and sid_ forms to the same canonical stable_id", async () => {
    resourcesStore.set("deadbeef00000003", {
      id: "deadbeef00000003",
      stable_id: "sid_UvWxYz0123",
    });

    const result = await resolveResourceIds(mockSql, ["deadbeef00000003"]);
    expect(result.resolve("deadbeef00000003")).toBe("sid_UvWxYz0123");
    expect(result.resolve("sid_UvWxYz0123")).toBe("sid_UvWxYz0123");
  });

  it("lists unresolved inputs under `missing` and passes them through", async () => {
    resourcesStore.set("deadbeef00000004", {
      id: "deadbeef00000004",
      stable_id: "sid_aaaaaaaaaa",
    });

    const result = await resolveResourceIds(mockSql, [
      "deadbeef00000004",
      "nonexistent000000",
      "sid_ghostXXXXX",
    ]);
    expect(result.missing.sort()).toEqual(["nonexistent000000", "sid_ghostXXXXX"]);
    expect(result.resolve("nonexistent000000")).toBe("nonexistent000000");
    expect(result.resolve("sid_ghostXXXXX")).toBe("sid_ghostXXXXX");
  });

  it("treats resources without stable_id as missing (no canonical form)", async () => {
    resourcesStore.set("legacyrow00000005", {
      id: "legacyrow00000005",
      stable_id: null,
    });

    const result = await resolveResourceIds(mockSql, ["legacyrow00000005"]);
    expect(result.missing).toEqual(["legacyrow00000005"]);
    expect(result.resolve("legacyrow00000005")).toBe("legacyrow00000005");
  });

  it("dedups repeated inputs", async () => {
    resourcesStore.set("deadbeef00000006", {
      id: "deadbeef00000006",
      stable_id: "sid_dupxxxxxxx",
    });

    const result = await resolveResourceIds(mockSql, [
      "deadbeef00000006",
      "deadbeef00000006",
      "deadbeef00000006",
    ]);
    expect(result.missing).toEqual([]);
    expect(result.resolve("deadbeef00000006")).toBe("sid_dupxxxxxxx");
  });

  it("handles mixed hex16, sid_, and unknown inputs in one batch", async () => {
    resourcesStore.set("deadbeef00000007", {
      id: "deadbeef00000007",
      stable_id: "sid_bbbbbbbbbb",
    });
    resourcesStore.set("deadbeef00000008", {
      id: "deadbeef00000008",
      stable_id: "sid_cccccccccc",
    });

    const result = await resolveResourceIds(mockSql, [
      "deadbeef00000007",
      "sid_cccccccccc",
      "unknown0000xxxxx",
    ]);
    expect(result.missing).toEqual(["unknown0000xxxxx"]);
    expect(result.resolve("deadbeef00000007")).toBe("sid_bbbbbbbbbb");
    expect(result.resolve("sid_cccccccccc")).toBe("sid_cccccccccc");
    expect(result.resolve("unknown0000xxxxx")).toBe("unknown0000xxxxx");
  });
});
