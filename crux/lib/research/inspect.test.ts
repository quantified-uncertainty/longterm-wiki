/**
 * Tests for inspect.ts (QUA-1034) — true zero-cost pre-flight for the
 * improve-entity loop.
 *
 * Pure functions are tested directly. Adversarial cases focus on:
 *   - Numeric edge cases (Drizzle returns numeric() as string; null vs 0)
 *   - Filter correctness (only `committed` runs, only matching entityId)
 *   - Empty inputs (empty suites, empty history, no gaps)
 *   - That the LLM client module is NEVER imported by the inspect path —
 *     this is the load-bearing acceptance criterion (zero LLM calls).
 */

import { describe, it, expect, vi } from "vitest";

import {
  buildInspectionReport,
  COST_RANGE_SPREAD,
  estimateEntityCost,
  formatInspectionHeader,
  formatInspectionLine,
  formatInspectionSuite,
  inspectGaps,
  type InspectionReport,
} from "./inspect.ts";
import type { PipelineRunRow } from "../wiki-server/pipeline-runs.ts";
import type { EntityWithType } from "./entity-loader.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<EntityWithType> = {}): EntityWithType {
  return {
    id: "fisa-702",
    type: "policy",
    title: "FISA Section 702",
    stableId: "sid_n7K9yVNCtg",
    provisions: [
      { title: "p1" },
      { title: "p2" },
    ],
    stakeholders: [{ name: "ACLU", position: "oppose" }],
    ...overrides,
  } as EntityWithType;
}

function makeOrg(overrides: Partial<EntityWithType> = {}): EntityWithType {
  return {
    id: "anthropic",
    type: "organization",
    title: "Anthropic",
    stableId: "sid_anthropic1",
    products: [{ name: "Claude" }],
    keyPeople: ["dario-amodei"],
    keyDates: [],
    ...overrides,
  } as EntityWithType;
}

function makeRun(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
  // PipelineRunRow's exact shape comes from InferResponseType — only the
  // fields the inspector reads matter. Cast to PipelineRunRow at the end.
  return {
    runId: "run-1",
    pipelineName: "improve-entity",
    entityId: "sid_n7K9yVNCtg",
    status: "committed",
    costUsd: "0.50",
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as PipelineRunRow;
}

// ── inspectGaps ─────────────────────────────────────────────────────────────

describe("inspectGaps", () => {
  it("returns gaps + populated counts for a policy entity", () => {
    const r = inspectGaps(makePolicy());
    // Default policy targets: minProvisions=6, minStakeholders=5 → both should
    // appear in gaps because we're below target (2 provisions, 1 stakeholder).
    const gapKeys = r.gaps.map((g) => g.key);
    expect(gapKeys).toContain("provisions");
    expect(gapKeys).toContain("stakeholders");
    expect(r.populated).toMatchObject({
      provisions: 2,
      stakeholders: 1,
      tags: 0,
      relatedEntries: 0,
    });
  });

  it("returns gaps + populated counts for an organization entity", () => {
    const r = inspectGaps(makeOrg());
    const gapKeys = r.gaps.map((g) => g.key);
    // Default org targets: minProducts=3, minKeyPeople=3, minKeyDates=2.
    expect(gapKeys).toContain("products");
    expect(gapKeys).toContain("keyPeople");
    expect(gapKeys).toContain("keyDates");
    // factbase.* gaps are always emitted by the org analyzer.
    expect(gapKeys).toContain("factbase.revenue");
    expect(r.populated).toMatchObject({
      products: 1,
      keyPeople: 1,
      keyDates: 0,
    });
  });

  it("returns empty gaps + populated for unsupported types", () => {
    const r = inspectGaps({ id: "x", type: "person" } as EntityWithType);
    expect(r.gaps).toEqual([]);
    expect(r.populated).toEqual({});
  });

  it("treats undefined arrays as 0-count (no NPE)", () => {
    const e = { id: "p", type: "policy" } as EntityWithType;
    const r = inspectGaps(e);
    expect(r.populated.provisions).toBe(0);
    expect(r.populated.stakeholders).toBe(0);
  });
});

// ── estimateEntityCost ──────────────────────────────────────────────────────

describe("estimateEntityCost", () => {
  it("returns the median of matching committed runs with positive costUsd", () => {
    const e = makePolicy();
    const runs = [
      makeRun({ costUsd: "0.50" }),
      makeRun({ runId: "r2", costUsd: "1.00" }),
      makeRun({ runId: "r3", costUsd: "2.00" }),
    ];
    const r = estimateEntityCost(e, runs);
    expect(r.costSource).toBe("history");
    expect(r.historicalRunCount).toBe(3);
    expect(r.estimatedCostUsd).toBe(1.0); // median of 0.5, 1.0, 2.0
  });

  it("filters out runs for OTHER entities", () => {
    const e = makePolicy();
    const runs = [
      makeRun({ entityId: "sid_other", costUsd: "10.00" }),
      makeRun({ runId: "r2", entityId: "sid_n7K9yVNCtg", costUsd: "0.30" }),
    ];
    const r = estimateEntityCost(e, runs);
    expect(r.historicalRunCount).toBe(1);
    expect(r.estimatedCostUsd).toBe(0.3);
  });

  it("filters out non-committed runs (aborted, oscillation, partial_failure, running)", () => {
    const e = makePolicy();
    const runs = [
      makeRun({ status: "aborted", costUsd: "5.00" }),
      makeRun({ runId: "r2", status: "oscillation", costUsd: "5.00" }),
      makeRun({ runId: "r3", status: "partial_failure", costUsd: "5.00" }),
      makeRun({ runId: "r4", status: "running", costUsd: "5.00" }),
      makeRun({ runId: "r5", status: "committed", costUsd: "0.40" }),
    ];
    const r = estimateEntityCost(e, runs);
    expect(r.historicalRunCount).toBe(1);
    expect(r.estimatedCostUsd).toBe(0.4);
  });

  it("filters out runs with null or zero costUsd", () => {
    const e = makePolicy();
    const runs = [
      makeRun({ costUsd: null }),
      makeRun({ runId: "r2", costUsd: "0" }),
      makeRun({ runId: "r3", costUsd: "-1.00" }), // negative is also invalid
      makeRun({ runId: "r4", costUsd: "0.75" }),
    ];
    const r = estimateEntityCost(e, runs);
    expect(r.historicalRunCount).toBe(1);
    expect(r.estimatedCostUsd).toBe(0.75);
  });

  it("falls back to type-based estimate when entity has no matching history", () => {
    const policy = makePolicy();
    const org = makeOrg();
    const noHistoryRuns: PipelineRunRow[] = [];

    const policyEst = estimateEntityCost(policy, noHistoryRuns);
    expect(policyEst.costSource).toBe("fallback");
    expect(policyEst.historicalRunCount).toBe(0);
    expect(policyEst.estimatedCostUsd).toBeGreaterThan(0);

    const orgEst = estimateEntityCost(org, noHistoryRuns);
    expect(orgEst.costSource).toBe("fallback");
    expect(orgEst.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("falls back to default when entity type is unknown", () => {
    const unknown = { id: "x", type: "ai-model", stableId: "sid_x" } as EntityWithType;
    const r = estimateEntityCost(unknown, []);
    expect(r.costSource).toBe("fallback");
    expect(r.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("uses entity.id when stableId is absent", () => {
    const e = { id: "fisa-702", type: "policy" } as EntityWithType;
    const runs = [makeRun({ entityId: "fisa-702", costUsd: "0.99" })];
    const r = estimateEntityCost(e, runs);
    expect(r.historicalRunCount).toBe(1);
    expect(r.estimatedCostUsd).toBe(0.99);
  });

  it("handles numeric costUsd (not string) as well as string (Drizzle vs JSON path)", () => {
    const e = makePolicy();
    const runs = [
      // Simulate a hypothetical path that returns number rather than string.
      makeRun({ costUsd: 1.25 as unknown as string }),
      makeRun({ runId: "r2", costUsd: "0.75" }),
    ];
    const r = estimateEntityCost(e, runs);
    expect(r.historicalRunCount).toBe(2);
    expect(r.estimatedCostUsd).toBe(1.0); // median of 0.75, 1.25
  });
});

// ── buildInspectionReport ───────────────────────────────────────────────────

describe("buildInspectionReport", () => {
  it("composes gaps + populated + cost into a single report", () => {
    const e = makePolicy();
    const r = buildInspectionReport(e, [
      makeRun({ costUsd: "0.50" }),
      makeRun({ runId: "r2", costUsd: "1.50" }),
    ]);
    expect(r.slug).toBe("fisa-702");
    expect(r.entityId).toBe("sid_n7K9yVNCtg");
    expect(r.type).toBe("policy");
    expect(r.title).toBe("FISA Section 702");
    expect(r.populated.provisions).toBe(2);
    expect(r.gaps.length).toBeGreaterThan(0);
    expect(r.estimatedCostUsd).toBe(1.0); // median of 0.5, 1.5
    expect(r.costSource).toBe("history");
    expect(r.historicalRunCount).toBe(2);
  });

  it("falls back to entity.id when title is missing or non-string", () => {
    const noTitle = { id: "p1", type: "policy" } as EntityWithType;
    const r = buildInspectionReport(noTitle, []);
    expect(r.title).toBe("p1");

    const badTitle = { id: "p2", type: "policy", title: 123 } as unknown as EntityWithType;
    const r2 = buildInspectionReport(badTitle, []);
    expect(r2.title).toBe("p2");
  });
});

// ── Format helpers ──────────────────────────────────────────────────────────

describe("formatInspectionLine", () => {
  function makeReport(overrides: Partial<InspectionReport> = {}): InspectionReport {
    return {
      slug: "fisa-702",
      entityId: "sid_n7K9yVNCtg",
      type: "policy",
      title: "FISA 702",
      populated: { provisions: 2, stakeholders: 1, tags: 0, relatedEntries: 0 },
      gaps: [
        { key: "scalar.description", description: "", target: "scalar", priority: 100, researchTopic: "" },
        { key: "provisions", description: "", target: "provision", priority: 95, researchTopic: "" },
      ],
      estimatedCostUsd: 1.5,
      costSource: "history",
      historicalRunCount: 3,
      ...overrides,
    };
  }

  it("includes slug, entityId, populated counts, gaps, and cost", () => {
    const out = formatInspectionLine(makeReport());
    expect(out).toContain("fisa-702");
    expect(out).toContain("sid_n7K9yVNCtg");
    expect(out).toContain("2 provisions");
    expect(out).toContain("1 stakeholders");
    expect(out).toContain("scalar.description");
    expect(out).toContain("provisions");
    expect(out).toContain("$1.50");
    expect(out).toContain("3 prior runs");
  });

  it("singularizes 'prior run' for n=1", () => {
    const out = formatInspectionLine(makeReport({ historicalRunCount: 1 }));
    expect(out).toContain("1 prior run");
    expect(out).not.toContain("1 prior runs");
  });

  it("says 'fallback est' when no history was used", () => {
    const out = formatInspectionLine(
      makeReport({ costSource: "fallback", historicalRunCount: 0 }),
    );
    expect(out).toContain("fallback est");
  });

  it("renders 'empty' when nothing is populated", () => {
    const out = formatInspectionLine(makeReport({ populated: { provisions: 0, stakeholders: 0 } }));
    expect(out).toContain("empty");
  });

  it("renders 'none' when there are no gaps", () => {
    const out = formatInspectionLine(makeReport({ gaps: [] }));
    expect(out).toContain("Gaps: none");
  });
});

describe("formatInspectionHeader", () => {
  it("renders count + estimated total range using COST_RANGE_SPREAD", () => {
    const reports: InspectionReport[] = [
      {
        slug: "a",
        entityId: "sid_a",
        type: "policy",
        title: "A",
        populated: {},
        gaps: [],
        estimatedCostUsd: 2.0,
        costSource: "fallback",
        historicalRunCount: 0,
      },
      {
        slug: "b",
        entityId: "sid_b",
        type: "policy",
        title: "B",
        populated: {},
        gaps: [],
        estimatedCostUsd: 4.0,
        costSource: "history",
        historicalRunCount: 5,
      },
    ];
    const out = formatInspectionHeader(reports);
    // total = 6.0, range = 0.5x..1.5x = $3.00..$9.00
    expect(out).toContain("2 entities");
    expect(out).toContain("$3.00");
    expect(out).toContain("$9.00");
    expect(out).toContain("$6.00"); // point estimate
    // Sanity: COST_RANGE_SPREAD is in (0, 1)
    expect(COST_RANGE_SPREAD).toBeGreaterThan(0);
    expect(COST_RANGE_SPREAD).toBeLessThan(1);
  });

  it("singularizes 'entity' for n=1", () => {
    const out = formatInspectionHeader([
      {
        slug: "a",
        entityId: "sid_a",
        type: "policy",
        title: "A",
        populated: {},
        gaps: [],
        estimatedCostUsd: 1.0,
        costSource: "fallback",
        historicalRunCount: 0,
      },
    ]);
    expect(out).toContain("1 entity");
    expect(out).not.toContain("1 entities");
  });

  it("handles empty report list (range $0.00..$0.00)", () => {
    const out = formatInspectionHeader([]);
    expect(out).toContain("0 entities");
    expect(out).toContain("$0.00");
  });
});

describe("formatInspectionSuite", () => {
  it("emits header followed by one line per report", () => {
    const out = formatInspectionSuite([
      {
        slug: "fisa-702",
        entityId: "sid_n7K9yVNCtg",
        type: "policy",
        title: "FISA 702",
        populated: { provisions: 2, stakeholders: 1 },
        gaps: [],
        estimatedCostUsd: 0.5,
        costSource: "history",
        historicalRunCount: 1,
      },
      {
        slug: "eu-ai-act",
        entityId: "sid_euaiact",
        type: "policy",
        title: "EU AI Act",
        populated: { provisions: 8, stakeholders: 4 },
        gaps: [],
        estimatedCostUsd: 1.5,
        costSource: "fallback",
        historicalRunCount: 0,
      },
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3); // header + 2 entity lines
    expect(lines[0]).toContain("2 entities");
    expect(lines[1]).toContain("fisa-702");
    expect(lines[2]).toContain("eu-ai-act");
  });
});

// ── Acceptance: inspect path imports zero LLM-side modules ──────────────────

describe("acceptance: zero-LLM-cost guarantee", () => {
  it("inspect.ts does NOT statically import anything from ../llm.ts", async () => {
    // Static-import check: read the file source and assert it never references
    // the llm.ts module. A future refactor that pulled `createLlmClient` in
    // (e.g. for "smart" cost estimation) would fail this test loudly.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "./inspect.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from ['"][^'"]*\/llm['"]/);
    expect(source).not.toMatch(/createLlmClient/);
    expect(source).not.toMatch(/streamingCreate/);
    // Match only imports / identifier refs (e.g. `from "@anthropic-ai/sdk"`,
    // `Anthropic.something`), NOT prose like "zero Anthropic API calls".
    expect(source).not.toMatch(/from ['"][^'"]*anthropic/i);
    expect(source).not.toMatch(/\bAnthropic\b\./);
  });

  it("inspect path makes zero network calls when history is injected as []", async () => {
    // buildInspectionReport with an empty injected runs array exercises the
    // full inspection logic without hitting the wiki-server. fetch should
    // never be called.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const r = buildInspectionReport(makePolicy(), []);
      expect(r.costSource).toBe("fallback");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
