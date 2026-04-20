import { describe, it, expect } from "vitest";
import {
  buildRowsUrl,
  fetchLeaderboardSnapshot,
  lookupRow,
  buildProposals,
  importTargets,
  parseTargetsArg,
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
    expect(snap.size).toBe(150);
  });

  it("stops at maxRows even if pages keep coming", async () => {
    const fullPage = { rows: Array.from({ length: 100 }, (_, i) => ({ row: { eval_name: `m${i}`, IFEval: i } })) };
    const fetchImpl = pageFetch([fullPage, fullPage, fullPage]);
    const snap = await fetchLeaderboardSnapshot({ fetchImpl, pageSize: 100, maxRows: 100 });
    expect(snap.size).toBe(100);
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
    expect(snap.size).toBe(1);
  });
});

describe("lookupRow", () => {
  it("returns direct hit by eval_name", () => {
    const snap = new Map([["a", { eval_name: "a" }]]);
    expect(lookupRow(snap, "a")?.eval_name).toBe("a");
  });
  it("falls back to fullname scan", () => {
    const snap = new Map([["x", { eval_name: "x", fullname: "long-name" }]]);
    expect(lookupRow(snap, "long-name")?.eval_name).toBe("x");
  });
  it("returns null when not found", () => {
    expect(lookupRow(new Map(), "missing")).toBeNull();
  });
});

describe("buildProposals", () => {
  it("emits one proposal per (target, benchmark) intersection that has a numeric score", () => {
    const snap = new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]);
    const { proposals, misses } = buildProposals([TARGET], snap);
    expect(misses).toHaveLength(0);
    expect(proposals).toHaveLength(DEFAULT_BENCHMARK_COLUMNS.length);
    expect(proposals.every((p) => p.tier === "T1")).toBe(true);
    expect(proposals.every((p) => p.recordType === "benchmark-result")).toBe(true);
  });

  it("records a miss when target eval_name is absent", () => {
    const snap = new Map<string, HfLeaderboardRow>();
    const { proposals, misses } = buildProposals([TARGET], snap);
    expect(proposals).toEqual([]);
    expect(misses).toHaveLength(1);
    expect(misses[0].reason).toContain("not in snapshot");
  });

  it("skips benchmark columns with non-numeric scores", () => {
    const partialRow: HfLeaderboardRow = {
      eval_name: TARGET.evalName,
      IFEval: 80,
      BBH: undefined,
      GPQA: NaN, // exercise the runtime guard for non-finite (NaN is a number type)
    };
    const snap = new Map([[TARGET.evalName, partialRow]]);
    const { proposals } = buildProposals([TARGET], snap);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe(`hf-leaderboard:${TARGET.evalName}:IFEval`);
  });

  it("hashes deterministically per (target, column, score)", () => {
    const snap = new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]);
    const a = buildProposals([TARGET], snap).proposals;
    const b = buildProposals([TARGET], snap).proposals;
    a.forEach((p, i) => expect(p.responseHash).toBe(b[i].responseHash));
  });

  it("entityRefs carries model + benchmark slugs for resolution", () => {
    const snap = new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]);
    const { proposals } = buildProposals([TARGET], snap);
    const ifeval = proposals.find((p) => p.source.endsWith(":IFEval"));
    expect(ifeval?.entityRefs?.model).toBe("meta-llama-3-70b-instruct");
    expect(ifeval?.entityRefs?.benchmark).toBe("ifeval");
  });

  it("uses the provided scoredAt date", () => {
    const snap = new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]);
    const { proposals } = buildProposals([TARGET], snap, { scoredAt: "2026-04-19" });
    expect(proposals[0].record.date).toBe("2026-04-19");
  });

  it("respects custom benchmarkColumns mapping", () => {
    const snap = new Map([[SAMPLE_ROW.eval_name, SAMPLE_ROW]]);
    const { proposals } = buildProposals([TARGET], snap, {
      benchmarkColumns: [{ column: "BBH", benchmarkId: "bbh", benchmarkSlug: "bbh", unit: "%" }],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe(`hf-leaderboard:${TARGET.evalName}:BBH`);
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
