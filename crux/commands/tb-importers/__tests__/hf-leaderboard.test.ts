import { describe, it, expect } from "vitest";
import {
  buildRowsUrl,
  fetchLeaderboardSnapshot,
  lookupRow,
  buildProposals,
  importTargets,
  parseTargetsArg,
  validateScore,
  DEFAULT_BENCHMARK_COLUMNS,
  type HfLeaderboardRow,
  type HfLeaderboardTarget,
} from "../hf-leaderboard.ts";

const TARGET: HfLeaderboardTarget = {
  modelSlug: "meta-llama-3-70b-instruct",
  modelDisplayName: "Meta-Llama-3-70B-Instruct",
  evalName: "meta-llama/Meta-Llama-3-70B-Instruct",
};

const SAMPLE_ROW: HfLeaderboardRow = {
  eval_name: "meta-llama/Meta-Llama-3-70B-Instruct",
  IFEval: 80.5,
  BBH: 50.1,
  "MATH Lvl 5": 23.4,
  GPQA: 11.0,
  MUSR: 17.3,
  "MMLU-PRO": 41.2,
};

function pageFetch(pages: Array<{ status?: number; rows: Array<{ row: HfLeaderboardRow }> }>): typeof fetch {
  let i = 0;
  return (async () => {
    const page = pages[i++] ?? { rows: [] };
    return {
      ok: (page.status ?? 200) >= 200 && (page.status ?? 200) < 300,
      status: page.status ?? 200,
      async json() {
        return { rows: page.rows };
      },
    };
  }) as unknown as typeof fetch;
}

describe("buildRowsUrl", () => {
  it("constructs a valid datasets-server URL", () => {
    const url = buildRowsUrl(0, 100);
    expect(url).toContain("dataset=open-llm-leaderboard%2Fcontents");
    expect(url).toContain("offset=0");
    expect(url).toContain("length=100");
    expect(url).toContain("split=train");
  });
});

describe("fetchLeaderboardSnapshot", () => {
  it("paginates until a short page", async () => {
    const fetchImpl = pageFetch([
      { rows: Array.from({ length: 100 }, (_, i) => ({ row: { eval_name: `m${i}`, IFEval: i } })) },
      { rows: Array.from({ length: 50 }, (_, i) => ({ row: { eval_name: `m${100 + i}`, IFEval: i } })) },
    ]);
    const snap = await fetchLeaderboardSnapshot({ fetchImpl, pageSize: 100 });
    expect(snap.byEvalName.size).toBe(150);
  });

  it("builds the fullname index in addition to eval_name", async () => {
    const fetchImpl = pageFetch([
      { rows: [{ row: { eval_name: "x", fullname: "long/name" } }] },
    ]);
    const snap = await fetchLeaderboardSnapshot({ fetchImpl });
    expect(snap.byEvalName.has("x")).toBe(true);
    expect(snap.byFullname.has("long/name")).toBe(true);
  });

  it("stops at maxRows even if pages keep coming", async () => {
    const fullPage = { rows: Array.from({ length: 100 }, (_, i) => ({ row: { eval_name: `m${i}`, IFEval: i } })) };
    const fetchImpl = pageFetch([fullPage, fullPage, fullPage]);
    const snap = await fetchLeaderboardSnapshot({ fetchImpl, pageSize: 100, maxRows: 100 });
    expect(snap.byEvalName.size).toBe(100);
  });

  it("clamps pageSize to 100 (datasets-server limit)", async () => {
    const captured: string[] = [];
    const fetchImpl = (async (url: string) => {
      captured.push(String(url));
      return { ok: true, status: 200, async json() { return { rows: [] }; } };
    }) as unknown as typeof fetch;
    await fetchLeaderboardSnapshot({ fetchImpl, pageSize: 500 });
    expect(captured[0]).toContain("length=100");
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(fetchLeaderboardSnapshot({ fetchImpl })).rejects.toThrow(/HTTP 503/);
  });

  it("ignores rows missing eval_name", async () => {
    const fetchImpl = pageFetch([
      { rows: [{ row: { eval_name: "good" } }, { row: {} as HfLeaderboardRow }] },
    ]);
    const snap = await fetchLeaderboardSnapshot({ fetchImpl, pageSize: 100 });
    expect(snap.byEvalName.size).toBe(1);
  });

  it("tolerates malformed rows wrapper (no .rows field)", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      async json() { return {}; },
    })) as unknown as typeof fetch;
    const snap = await fetchLeaderboardSnapshot({ fetchImpl });
    expect(snap.byEvalName.size).toBe(0);
  });
});

describe("lookupRow", () => {
  it("returns direct hit by eval_name from a snapshot", () => {
    const snap = {
      byEvalName: new Map([["a", { eval_name: "a" }]]),
      byFullname: new Map(),
    };
    expect(lookupRow(snap, "a")?.eval_name).toBe("a");
  });
  it("falls back to fullname index (O(1), not scan)", () => {
    const snap = {
      byEvalName: new Map(),
      byFullname: new Map([["long-name", { eval_name: "x", fullname: "long-name" }]]),
    };
    expect(lookupRow(snap, "long-name")?.eval_name).toBe("x");
  });
  it("returns null when not found", () => {
    expect(lookupRow({ byEvalName: new Map(), byFullname: new Map() }, "missing")).toBeNull();
  });
});

describe("validateScore", () => {
  it("accepts 0", () => {
    expect(validateScore(0, "%")).toBeNull();
  });
  it("accepts boundary score 100 with unit=%", () => {
    expect(validateScore(100, "%")).toBeNull();
  });
  it("rejects negative", () => {
    expect(validateScore(-1, "%")).toMatch(/negative/);
  });
  it("rejects > 100 with unit=%", () => {
    expect(validateScore(150, "%")).toMatch(/> 100/);
  });
  it("accepts > 100 with non-percent unit", () => {
    expect(validateScore(150, "score")).toBeNull();
  });
  it("rejects NaN and Infinity", () => {
    expect(validateScore(NaN, "%")).toMatch(/finite/);
    expect(validateScore(Infinity, "%")).toMatch(/finite/);
  });
});

describe("buildProposals", () => {
  it("emits one proposal per (target, benchmark) intersection that has a numeric score", () => {
    const snap = {
      byEvalName: new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]),
      byFullname: new Map(),
    };
    const { proposals, misses } = buildProposals([TARGET], snap);
    expect(misses).toHaveLength(0);
    expect(proposals).toHaveLength(DEFAULT_BENCHMARK_COLUMNS.length);
    expect(proposals.every((p) => p.tier === "T1")).toBe(true);
    expect(proposals.every((p) => p.recordType === "benchmark-results")).toBe(true);
  });

  it("records a miss when target eval_name is absent", () => {
    const snap = { byEvalName: new Map(), byFullname: new Map() };
    const { proposals, misses } = buildProposals([TARGET], snap);
    expect(proposals).toEqual([]);
    expect(misses).toHaveLength(1);
    expect(misses[0].reason).toContain("not in snapshot");
  });

  it("emits a proposal when score is exactly 0 (not treated as missing)", () => {
    const row: HfLeaderboardRow = { eval_name: TARGET.evalName, IFEval: 0 };
    const snap = { byEvalName: new Map([[TARGET.evalName, row]]), byFullname: new Map() };
    const { proposals } = buildProposals([TARGET], snap);
    const ifeval = proposals.find((p) => p.source.endsWith(":IFEval"));
    expect(ifeval).toBeDefined();
    expect(ifeval?.record.score).toBe(0);
  });

  it("rejects a proposal when score is negative (records as miss)", () => {
    const row: HfLeaderboardRow = { eval_name: TARGET.evalName, IFEval: -1 };
    const snap = { byEvalName: new Map([[TARGET.evalName, row]]), byFullname: new Map() };
    const { proposals, misses } = buildProposals([TARGET], snap);
    expect(proposals.find((p) => p.source.endsWith(":IFEval"))).toBeUndefined();
    expect(misses.find((m) => m.reason.includes("IFEval"))).toBeDefined();
  });

  it("rejects > 100 scores with unit=% (records as miss)", () => {
    const row: HfLeaderboardRow = { eval_name: TARGET.evalName, IFEval: 150 };
    const snap = { byEvalName: new Map([[TARGET.evalName, row]]), byFullname: new Map() };
    const { proposals, misses } = buildProposals([TARGET], snap);
    expect(proposals).toHaveLength(0);
    expect(misses.length).toBeGreaterThanOrEqual(1);
  });

  it("skips columns with non-numeric / NaN scores without recording miss", () => {
    const partialRow: HfLeaderboardRow = {
      eval_name: TARGET.evalName,
      IFEval: 80,
      BBH: undefined,
      GPQA: NaN,
    };
    const snap = { byEvalName: new Map([[TARGET.evalName, partialRow]]), byFullname: new Map() };
    const { proposals, misses } = buildProposals([TARGET], snap);
    // Only IFEval should produce a proposal.
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe(`hf-leaderboard:${TARGET.evalName}:IFEval`);
    // BBH=undefined → skipped silently. GPQA=NaN → recorded as miss.
    expect(misses.find((m) => m.reason.includes("GPQA"))).toBeDefined();
    expect(misses.find((m) => m.reason.includes("BBH"))).toBeUndefined();
  });

  it("hashes deterministically per (target, column, score)", () => {
    const snap = { byEvalName: new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]), byFullname: new Map() };
    const a = buildProposals([TARGET], snap).proposals;
    const b = buildProposals([TARGET], snap).proposals;
    a.forEach((p, i) => expect(p.responseHash).toBe(b[i].responseHash));
  });

  it("entityRefs carries model + benchmark slugs for resolution", () => {
    const snap = { byEvalName: new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]), byFullname: new Map() };
    const { proposals } = buildProposals([TARGET], snap);
    const ifeval = proposals.find((p) => p.source.endsWith(":IFEval"));
    expect(ifeval?.entityRefs?.model).toBe("meta-llama-3-70b-instruct");
    expect(ifeval?.entityRefs?.benchmark).toBe("ifeval");
  });

  it("uses the provided scoredAt date", () => {
    const snap = { byEvalName: new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]), byFullname: new Map() };
    const { proposals } = buildProposals([TARGET], snap, { scoredAt: "2026-04-19" });
    expect(proposals[0].record.date).toBe("2026-04-19");
  });

  it("respects custom benchmarkColumns mapping", () => {
    const snap = { byEvalName: new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]), byFullname: new Map() };
    const { proposals } = buildProposals([TARGET], snap, {
      benchmarkColumns: [{ column: "BBH", benchmarkSlug: "bbh", unit: "%" }],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe(`hf-leaderboard:${TARGET.evalName}:BBH`);
  });

  it("includes modelDisplayName in notes for evidence", () => {
    const snap = { byEvalName: new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]), byFullname: new Map() };
    const { proposals } = buildProposals([TARGET], snap);
    expect(String(proposals[0].record.notes)).toContain(TARGET.modelDisplayName);
  });
});

describe("importTargets", () => {
  it("end-to-end fetches + builds proposals", async () => {
    const fetchImpl = pageFetch([
      { rows: [{ row: SAMPLE_ROW }] },
    ]);
    const { proposals, misses } = await importTargets([TARGET], { fetchImpl, pageSize: 100 });
    expect(misses).toHaveLength(0);
    expect(proposals.length).toBe(DEFAULT_BENCHMARK_COLUMNS.length);
  });
});

describe("parseTargetsArg", () => {
  it("parses single target with three segments", () => {
    expect(parseTargetsArg(["--target=slug:Display:eval/name"])).toEqual([
      { modelSlug: "slug", modelDisplayName: "Display", evalName: "eval/name" },
    ]);
  });

  it("preserves colons in evalName beyond the second", () => {
    const out = parseTargetsArg(["--target=s:D:org/model:variant"]);
    expect(out[0].evalName).toBe("org/model:variant");
  });

  it("throws on missing segments", () => {
    expect(() => parseTargetsArg(["--target=slug"])).toThrow(/modelSlug:displayName:evalName/);
    expect(() => parseTargetsArg(["--target=slug:onlyone"])).toThrow(
      /modelSlug:displayName:evalName/
    );
  });

  it("throws on empty segment", () => {
    expect(() => parseTargetsArg(["--target=:Display:eval"])).toThrow(/empty segment/);
    expect(() => parseTargetsArg(["--target=slug::eval"])).toThrow(/empty segment/);
  });
});
