/**
 * Tests for `crux tb improve-entity-suite` (QUA-882).
 *
 * Pure helpers (loadSuite, filterToSupportedTypes, computePerEntityCap,
 * median/p25, aggregateResult, computeAggregate) are tested directly. The
 * suite runner is tested with a mocked improver function injected via
 * SuiteRunOptions.improver — no LLM, no YAML writes, no network.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MIN_USEFUL_BUDGET_USD,
  aggregateResult,
  computeAggregate,
  computePerEntityCap,
  filterToSupportedTypes,
  isValidTag,
  loadSuite,
  median,
  p25,
  runSuite,
  type PerEntityRecord,
  type SuiteEntry,
} from "./research-improve-entity-suite.ts";
import type { ImproveResult, IterationMetrics } from "./research-improve-entity.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

function makeIter(overrides: Partial<IterationMetrics> = {}): IterationMetrics {
  return {
    iter: 1,
    gaps_identified: 3,
    sources_found: 5,
    claims_extracted: 10,
    claims_filtered_out: 2,
    claims_proposed: 8,
    claims_verified: 6,
    claims_partial: 1,
    claims_contradicted: 0,
    claims_unverifiable: 1,
    verified_rate: 7 / 8,
    applied_to_yaml: 5,
    cost_research_usd: 0.02,
    cost_extract_usd: 0.01,
    duration_s: 30,
    ...overrides,
  };
}

function makeResult(slug: string, overrides: Partial<ImproveResult> = {}): ImproveResult {
  const iterations = overrides.iterations ?? [makeIter()];
  return {
    entity_slug: slug,
    entity_id: slug,
    entity_type: "policy",
    iterations,
    final_coverage: 0.9,
    final_facts: { provisions: 6, stakeholders: 5 },
    total_cost_usd: iterations.reduce((s, m) => s + m.cost_research_usd + m.cost_extract_usd, 0),
    total_duration_s: iterations.reduce((s, m) => s + m.duration_s, 0),
    hit_target: true,
    reason: "target-hit",
    ...overrides,
  };
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

// ── loadSuite ──────────────────────────────────────────────────────────────

describe("loadSuite", () => {
  it("parses a valid suite YAML", () => {
    const dir = tmpdir("suite-yaml");
    const filePath = path.join(dir, "suite.yaml");
    fs.writeFileSync(
      filePath,
      `- slug: foo
  type: policy
  expected_min_coverage: 0.9
- slug: bar
  type: organization
`,
    );
    const entries = loadSuite(filePath);
    expect(entries).toEqual([
      { slug: "foo", type: "policy", expected_min_coverage: 0.9 },
      { slug: "bar", type: "organization" },
    ]);
  });

  it("rejects entries missing required fields", () => {
    const dir = tmpdir("suite-bad");
    const filePath = path.join(dir, "suite.yaml");
    fs.writeFileSync(filePath, `- slug: foo\n`); // missing `type`
    expect(() => loadSuite(filePath)).toThrow();
  });

  it("rejects an out-of-range expected_min_coverage", () => {
    const dir = tmpdir("suite-bad-cov");
    const filePath = path.join(dir, "suite.yaml");
    fs.writeFileSync(filePath, `- slug: foo\n  type: policy\n  expected_min_coverage: 1.5\n`);
    expect(() => loadSuite(filePath)).toThrow();
  });
});

// ── filterToSupportedTypes ─────────────────────────────────────────────────

describe("filterToSupportedTypes", () => {
  it("keeps only policy entries (v1)", () => {
    const entries: SuiteEntry[] = [
      { slug: "a", type: "policy" },
      { slug: "b", type: "organization" },
      { slug: "c", type: "policy" },
      { slug: "d", type: "person" },
    ];
    expect(filterToSupportedTypes(entries).map((e) => e.slug)).toEqual(["a", "c"]);
  });

  it("returns empty for an all-unsupported list", () => {
    const entries: SuiteEntry[] = [
      { slug: "a", type: "organization" },
      { slug: "b", type: "ai-model" },
    ];
    expect(filterToSupportedTypes(entries)).toEqual([]);
  });
});

// ── isValidTag ─────────────────────────────────────────────────────────────

describe("isValidTag", () => {
  it("accepts plain alphanumerics, dot, underscore, hyphen", () => {
    expect(isValidTag("baseline")).toBe(true);
    expect(isValidTag("after-token-filter")).toBe(true);
    expect(isValidTag("v1.0_run-2")).toBe(true);
    expect(isValidTag("ABC123")).toBe(true);
  });

  it("rejects path traversal sequences", () => {
    expect(isValidTag("../etc/passwd")).toBe(false);
    expect(isValidTag("..\\\\windows")).toBe(false);
    expect(isValidTag("foo/bar")).toBe(false);
    expect(isValidTag("foo\\bar")).toBe(false);
  });

  it("rejects shell/filesystem metacharacters", () => {
    expect(isValidTag("foo;rm -rf /")).toBe(false);
    expect(isValidTag("foo bar")).toBe(false); // space
    expect(isValidTag("foo$bar")).toBe(false);
    expect(isValidTag("foo`bar`")).toBe(false);
    expect(isValidTag("foo|bar")).toBe(false);
  });

  it("rejects empty and oversize tags", () => {
    expect(isValidTag("")).toBe(false);
    expect(isValidTag("a".repeat(81))).toBe(false);
    expect(isValidTag("a".repeat(80))).toBe(true);
  });

  it("rejects unicode-control / null bytes", () => {
    expect(isValidTag("foo\x00bar")).toBe(false);
    expect(isValidTag("foo\nbar")).toBe(false);
  });
});

// ── computePerEntityCap ────────────────────────────────────────────────────

describe("computePerEntityCap", () => {
  it("returns 2× the equal-share allocation", () => {
    expect(computePerEntityCap(10, 8)).toBeCloseTo(2.5, 6); // (10/8)*2
    expect(computePerEntityCap(5, 5)).toBeCloseTo(2.0, 6);
  });

  it("returns 0 on N=0 (no division by zero)", () => {
    expect(computePerEntityCap(10, 0)).toBe(0);
  });

  it("scales linearly with budget", () => {
    expect(computePerEntityCap(20, 8)).toBeCloseTo(5.0, 6);
  });
});

// ── median + p25 ───────────────────────────────────────────────────────────

describe("median", () => {
  it("returns 0 for an empty list", () => {
    expect(median([])).toBe(0);
  });

  it("handles a single element", () => {
    expect(median([0.5])).toBe(0.5);
  });

  it("averages middle two for even-length", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns the middle element for odd-length", () => {
    expect(median([5, 1, 3])).toBe(3); // sorted [1,3,5]
  });
});

describe("p25", () => {
  it("returns 0 for an empty list", () => {
    expect(p25([])).toBe(0);
  });

  it("handles a single element", () => {
    expect(p25([0.7])).toBe(0.7);
  });

  it("matches NumPy linear interpolation", () => {
    // NumPy: np.percentile([1,2,3,4,5], 25) → 2.0
    expect(p25([1, 2, 3, 4, 5])).toBeCloseTo(2.0, 6);
    // NumPy: np.percentile([10,20,30,40], 25) → 17.5
    expect(p25([10, 20, 30, 40])).toBeCloseTo(17.5, 6);
  });
});

// ── aggregateResult ────────────────────────────────────────────────────────

describe("aggregateResult", () => {
  it("sums per-iter counts and computes verified_rate", () => {
    const result = makeResult("foo", {
      iterations: [
        makeIter({ claims_proposed: 5, claims_verified: 4, claims_partial: 0, applied_to_yaml: 4 }),
        makeIter({ claims_proposed: 3, claims_verified: 2, claims_partial: 1, applied_to_yaml: 3 }),
      ],
    });
    const r = aggregateResult("foo", "policy", result);
    expect(r.claims_proposed).toBe(8);
    expect(r.claims_verified).toBe(6);
    expect(r.claims_partial).toBe(1);
    expect(r.applied_to_yaml).toBe(7);
    // verified+partial / proposed = 7/8
    expect(r.verified_rate).toBeCloseTo(7 / 8, 6);
    expect(r.status).toBe("completed");
  });

  it("reports verified_rate=0 when no claims proposed", () => {
    const result = makeResult("empty", {
      iterations: [makeIter({ claims_proposed: 0, claims_verified: 0, claims_partial: 0 })],
    });
    const r = aggregateResult("empty", "policy", result);
    expect(r.verified_rate).toBe(0);
  });
});

// ── computeAggregate ───────────────────────────────────────────────────────

describe("computeAggregate", () => {
  function recordWithRate(slug: string, rate: number, status: PerEntityRecord["status"] = "completed", cost = 0): PerEntityRecord {
    return {
      slug,
      type: "policy",
      status,
      iterations: [],
      claims_proposed: 0,
      claims_verified: 0,
      claims_partial: 0,
      claims_contradicted: 0,
      claims_unverifiable: 0,
      verified_rate: rate,
      applied_to_yaml: 0,
      cost_usd: cost,
      duration_s: 0,
    };
  }

  it("counts entities by status and computes percentiles over completed only", () => {
    const records: PerEntityRecord[] = [
      recordWithRate("a", 0.9, "completed", 0.04),
      recordWithRate("b", 0.85, "completed", 0.05),
      recordWithRate("c", 0.7, "completed", 0.03),
      recordWithRate("d", 0, "skipped_budget", 0),
      recordWithRate("e", 0, "failed", 0),
    ];
    const agg = computeAggregate(records);
    expect(agg.entities_completed).toBe(3);
    expect(agg.entities_skipped_budget).toBe(1);
    expect(agg.entities_failed).toBe(1);
    expect(agg.median_verified_rate).toBeCloseTo(0.85, 6);
    // p25 of [0.7, 0.85, 0.9] → 0.775 (linear interp at idx 0.5)
    expect(agg.p25_verified_rate).toBeCloseTo(0.775, 6);
    expect(agg.total_cost_usd).toBeCloseTo(0.12, 6);
  });

  it("returns zeros when no entities completed", () => {
    const records: PerEntityRecord[] = [recordWithRate("a", 0, "failed")];
    const agg = computeAggregate(records);
    expect(agg.median_verified_rate).toBe(0);
    expect(agg.p25_verified_rate).toBe(0);
    expect(agg.entities_completed).toBe(0);
  });
});

// ── runSuite (integration with mocked improver) ────────────────────────────

function writeFixtureSuite(...entries: Array<{ slug: string; type: string }>): {
  suitePath: string;
  snapshotDir: string;
} {
  const dir = tmpdir("suite-run");
  const suitePath = path.join(dir, "suite.yaml");
  const lines = entries.map((e) => `- slug: ${e.slug}\n  type: ${e.type}`).join("\n");
  fs.writeFileSync(suitePath, lines + "\n");
  return { suitePath, snapshotDir: path.join(dir, "snapshots") };
}

describe("runSuite", () => {
  it("happy path: runs improver once per supported entity, writes snapshot", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite(
      { slug: "alpha", type: "policy" },
      { slug: "beta", type: "policy" },
    );
    const calls: string[] = [];
    const improver = async ({ slug }: { slug: string }) => {
      calls.push(slug);
      return makeResult(slug, {
        iterations: [makeIter({ cost_research_usd: 0.02, cost_extract_usd: 0.01 })],
      });
    };
    const snap = await runSuite({
      tag: "happy",
      totalBudgetUsd: 4.0,
      maxIters: 2,
      suitePath,
      snapshotDir,
      improver,
    });
    expect(calls).toEqual(["alpha", "beta"]);
    expect(snap.entities).toHaveLength(2);
    expect(snap.entities.every((r) => r.status === "completed")).toBe(true);
    expect(snap.aggregate.entities_completed).toBe(2);
    expect(snap.aggregate.entities_skipped_budget).toBe(0);
    expect(snap.aggregate.entities_failed).toBe(0);
    expect(snap.tag).toBe("happy");
    expect(snap.budget_usd).toBe(4.0);
    expect(snap.per_entity_cap_usd).toBeCloseTo(4.0, 6); // (4/2)*2

    // Snapshot file written.
    const written = fs.readdirSync(snapshotDir);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/__happy\.json$/);
    const onDisk = JSON.parse(fs.readFileSync(path.join(snapshotDir, written[0]), "utf8"));
    expect(onDisk.tag).toBe("happy");
    expect(onDisk.entities.map((e: { slug: string }) => e.slug)).toEqual(["alpha", "beta"]);
  });

  it("filters out unsupported types before running", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite(
      { slug: "alpha", type: "policy" },
      { slug: "beta", type: "organization" }, // unsupported in v1
      { slug: "gamma", type: "policy" },
    );
    const calls: string[] = [];
    const improver = async ({ slug }: { slug: string }) => {
      calls.push(slug);
      return makeResult(slug);
    };
    const snap = await runSuite({
      tag: "filter",
      totalBudgetUsd: 2.0,
      maxIters: 1,
      suitePath,
      snapshotDir,
      improver,
    });
    expect(calls).toEqual(["alpha", "gamma"]);
    expect(snap.entities.map((r) => r.slug)).toEqual(["alpha", "gamma"]);
  });

  it("halts early and marks remaining entities skipped_budget when total budget exhausted", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite(
      { slug: "spendthrift", type: "policy" },
      { slug: "second", type: "policy" },
      { slug: "third", type: "policy" },
    );
    const calls: string[] = [];
    const improver = async ({ slug, budgetUsd }: { slug: string; budgetUsd?: number }) => {
      calls.push(slug);
      // Entity 1 burns its entire budget allocation.
      const cost = slug === "spendthrift" ? (budgetUsd ?? 0) : 0.01;
      return makeResult(slug, {
        iterations: [makeIter({ cost_research_usd: cost, cost_extract_usd: 0 })],
      });
    };
    // Total = 0.10, per-entity cap = (0.10/3)*2 = 0.0667. spendthrift burns 0.0667.
    // Remaining after entity 1 = 0.10 - 0.0667 = 0.0333, which is below
    // MIN_USEFUL_BUDGET_USD ($0.05) → halt.
    const snap = await runSuite({
      tag: "halt",
      totalBudgetUsd: 0.1,
      maxIters: 1,
      suitePath,
      snapshotDir,
      improver,
    });
    expect(calls).toEqual(["spendthrift"]);
    expect(snap.entities[0].status).toBe("completed");
    expect(snap.entities[1].status).toBe("skipped_budget");
    expect(snap.entities[2].status).toBe("skipped_budget");
    expect(snap.aggregate.entities_completed).toBe(1);
    expect(snap.aggregate.entities_skipped_budget).toBe(2);
  });

  it("passes the per-entity cap as the inner budget; never exceeds remaining", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite(
      { slug: "a", type: "policy" },
      { slug: "b", type: "policy" },
    );
    const budgetsSeen: Array<{ slug: string; budget: number }> = [];
    const improver = async ({ slug, budgetUsd }: { slug: string; budgetUsd?: number }) => {
      budgetsSeen.push({ slug, budget: budgetUsd ?? -1 });
      // Spend nothing so subsequent entities still see plenty of remaining budget.
      return makeResult(slug, { iterations: [makeIter({ cost_research_usd: 0, cost_extract_usd: 0 })] });
    };
    // Total=$2, N=2 → per-entity cap = $2.
    await runSuite({
      tag: "cap",
      totalBudgetUsd: 2.0,
      maxIters: 1,
      suitePath,
      snapshotDir,
      improver,
    });
    expect(budgetsSeen).toEqual([
      { slug: "a", budget: 2.0 },
      { slug: "b", budget: 2.0 },
    ]);
  });

  it("records failures without aborting subsequent entities", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite(
      { slug: "boom", type: "policy" },
      { slug: "ok", type: "policy" },
    );
    const improver = async ({ slug }: { slug: string }) => {
      if (slug === "boom") throw new Error("synthetic blast");
      return makeResult(slug);
    };
    const snap = await runSuite({
      tag: "fail",
      totalBudgetUsd: 4.0,
      maxIters: 1,
      suitePath,
      snapshotDir,
      improver,
    });
    expect(snap.entities[0].status).toBe("failed");
    expect(snap.entities[0].error).toContain("synthetic blast");
    expect(snap.entities[1].status).toBe("completed");
    expect(snap.aggregate.entities_failed).toBe(1);
    expect(snap.aggregate.entities_completed).toBe(1);
  });

  it("returns a snapshot with empty entities when the suite has no supported types", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite({ slug: "x", type: "organization" });
    let calls = 0;
    const improver = async () => {
      calls++;
      return makeResult("never-called");
    };
    const snap = await runSuite({
      tag: "empty",
      totalBudgetUsd: 1.0,
      maxIters: 1,
      suitePath,
      snapshotDir,
      improver,
    });
    expect(calls).toBe(0);
    expect(snap.entities).toEqual([]);
    expect(snap.aggregate.entities_completed).toBe(0);
    // per_entity_cap_usd is 0 when N=0.
    expect(snap.per_entity_cap_usd).toBe(0);
  });

  it("rejects an invalid tag before doing any work", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite({ slug: "alpha", type: "policy" });
    let calls = 0;
    const improver = async () => {
      calls++;
      return makeResult("alpha");
    };
    await expect(
      runSuite({
        tag: "../etc/passwd",
        totalBudgetUsd: 4.0,
        maxIters: 1,
        suitePath,
        snapshotDir,
        improver,
      }),
    ).rejects.toThrow(/Invalid --tag/);
    expect(calls).toBe(0);
    // No snapshot file written.
    expect(fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir) : []).toEqual([]);
  });
});

// ── exported constant sanity ───────────────────────────────────────────────

describe("constants", () => {
  it("MIN_USEFUL_BUDGET_USD matches the inner-loop floor in research-improve-entity", () => {
    // Mirrors the `budgetRemaining <= 0.05` guard in research-improve-entity.ts.
    expect(MIN_USEFUL_BUDGET_USD).toBe(0.05);
  });
});
