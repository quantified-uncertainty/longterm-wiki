/**
 * Tests for `crux tb improve-entity-suite` (QUA-882).
 *
 * Pure helpers (loadSuite, filterToSupportedTypes, computePerEntityCap,
 * median/p25, aggregateResult, computeAggregate) are tested directly. The
 * suite runner is tested with a mocked improver function injected via
 * SuiteRunOptions.improver — no LLM, no YAML writes, no network.
 */

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// QUA-1032: the suite now wraps its body in `withPipelineRun` to register
// itself as a `pipeline_runs` row. Mock the lifecycle helper at the module
// level so tests don't hit the wiki-server. The real wrapper has
// `allowOffline: true` so production survives outages, but in tests we get
// faster, quieter runs by short-circuiting the wrapper entirely.
vi.mock("../lib/pipeline-runs/lifecycle.ts", () => ({
  withPipelineRun: vi.fn((_options: unknown, body: (ctx: unknown) => Promise<unknown>) =>
    body({
      runId: "test-run",
      offline: true,
      markStatus: vi.fn(),
      markFollowup: vi.fn(),
    }),
  ),
}));

import {
  DEFAULT_PER_ENTITY_BUDGET_USD,
  MIN_USEFUL_BUDGET_USD,
  aggregateResult,
  computeAggregate,
  computeDefaultTotalBudgetUsd,
  computePerEntityCap,
  filterToSupportedTypes,
  inspectSuite,
  isValidTag,
  loadSuite,
  median,
  p25,
  runSuite,
  type PerEntityRecord,
  type SuiteEntry,
} from "./research-improve-entity-suite.ts";
import type { EntityWithType } from "../lib/research/entity-loader.ts";
import type { PipelineRunRow } from "../lib/wiki-server/pipeline-runs.ts";
import { BudgetExhaustedError } from "./research-improve-entity.ts";
import type { ImproveResult, IterationMetrics } from "./research-improve-entity.ts";
import {
  IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
  ImproveEntityMutexError,
} from "../lib/improve-entity/mutex.ts";
import type { CheckMutexOptions } from "../lib/improve-entity/mutex.ts";

// QUA-1032: every runSuite call needs an injected mutex `list` to avoid
// network calls to `/api/pipeline-runs`. This default returns "no running
// rows" so the suite proceeds normally.
function noopMutexOverrides(): Pick<CheckMutexOptions, "list" | "nowMs"> {
  return {
    list: vi.fn().mockResolvedValue({ ok: true, data: { runs: [], count: 0 } }),
    nowMs: () => Date.parse("2026-05-01T20:00:00.000Z"),
  };
}

// Wrap runSuite to inject the no-op mutex override by default. Tests that
// want to exercise the mutex pass `mutexCheckOverrides` themselves.
// Spread `opts` first so a caller-supplied mutexCheckOverrides wins; otherwise
// fall back to the no-op.
async function runSuiteForTest(
  opts: Parameters<typeof runSuite>[0],
): Promise<Awaited<ReturnType<typeof runSuite>>> {
  return runSuite({
    ...opts,
    mutexCheckOverrides: opts.mutexCheckOverrides ?? noopMutexOverrides(),
  });
}

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
    const snap = await runSuiteForTest({
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
    const snap = await runSuiteForTest({
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
    const snap = await runSuiteForTest({
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
    await runSuiteForTest({
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

  it("production path: result.reason='budget-exhausted' from improveSingleEntity is recorded as skipped_budget and stops dispatch (QUA-1017)", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite(
      { slug: "first", type: "policy" },
      { slug: "burner", type: "policy" },
      { slug: "third", type: "policy" },
      { slug: "fourth", type: "policy" },
    );
    const calls: string[] = [];
    const improver = async ({ slug }: { slug: string }) => {
      calls.push(slug);
      if (slug === "first") return makeResult(slug);
      if (slug === "burner") {
        return makeResult(slug, {
          reason: "budget-exhausted",
          hit_target: false,
          iterations: [],
          total_cost_usd: 1.85,
        });
      }
      throw new Error(`improver should not have been called for ${slug}`);
    };
    const snap = await runSuiteForTest({
      tag: "budget-stop",
      totalBudgetUsd: 8.0,
      maxIters: 1,
      suitePath,
      snapshotDir,
      improver,
    });
    expect(calls).toEqual(["first", "burner"]);
    expect(snap.entities).toHaveLength(4);
    expect(snap.entities[0].status).toBe("completed");
    expect(snap.entities[1].status).toBe("skipped_budget");
    expect(snap.entities[1].error).toMatch(/spent \$1\.8500 of \$/);
    expect(snap.entities[2].status).toBe("skipped_budget");
    expect(snap.entities[2].error).toBeUndefined();
    expect(snap.entities[3].status).toBe("skipped_budget");
    expect(snap.entities[3].error).toBeUndefined();
    expect(snap.aggregate.entities_completed).toBe(1);
    expect(snap.aggregate.entities_skipped_budget).toBe(3);
    expect(snap.aggregate.entities_failed).toBe(0);
  });

  it("defensive path: BudgetExhaustedError thrown out of improveSingleEntity is also caught and treated as skipped_budget (QUA-1017)", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite(
      { slug: "first", type: "policy" },
      { slug: "burner", type: "policy" },
      { slug: "third", type: "policy" },
    );
    const calls: string[] = [];
    const improver = async ({ slug }: { slug: string }) => {
      calls.push(slug);
      if (slug === "first") return makeResult(slug);
      if (slug === "burner") throw new BudgetExhaustedError(2.5, 1.0);
      throw new Error(`improver should not have been called for ${slug}`);
    };
    const snap = await runSuiteForTest({
      tag: "budget-rethrow",
      totalBudgetUsd: 8.0,
      maxIters: 1,
      suitePath,
      snapshotDir,
      improver,
    });
    expect(calls).toEqual(["first", "burner"]);
    expect(snap.entities[1].status).toBe("skipped_budget");
    expect(snap.entities[1].error).toMatch(/Spent \$2\.5000 of \$1\.00 budget/);
    expect(snap.entities[2].status).toBe("skipped_budget");
    expect(snap.aggregate.entities_skipped_budget).toBe(2);
    expect(snap.aggregate.entities_failed).toBe(0);
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
    const snap = await runSuiteForTest({
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
    const snap = await runSuiteForTest({
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
      runSuiteForTest({
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

  // ── QUA-1032 mutex wiring ────────────────────────────────────────────────

  it("refuses to start when another improve-entity-suite run is in flight", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite({ slug: "alpha", type: "policy" });
    const NOW = Date.parse("2026-05-01T20:00:00.000Z");
    const fakeRunningRow = {
      runId: "other-suite",
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      agentSessionId: 17,
      status: "running",
      startedAt: new Date(NOW - 60_000).toISOString(),
      heartbeatAt: new Date(NOW - 30_000).toISOString(),
    };
    const list = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { runs: [fakeRunningRow], count: 1 } });
    let improverCalled = 0;
    const improver = async () => {
      improverCalled++;
      return makeResult("alpha");
    };
    await expect(
      runSuiteForTest({
        tag: "blocked",
        totalBudgetUsd: 2.0,
        maxIters: 1,
        suitePath,
        snapshotDir,
        improver,
        mutexCheckOverrides: { list, nowMs: () => NOW },
      }),
    ).rejects.toBeInstanceOf(ImproveEntityMutexError);
    expect(improverCalled).toBe(0);
    // No snapshot — refused before the loop started.
    expect(fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir) : []).toEqual([]);
  });

  it("--force bypasses the suite-level mutex check", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite(
      { slug: "alpha", type: "policy" },
      { slug: "beta", type: "policy" },
    );
    const NOW = Date.parse("2026-05-01T20:00:00.000Z");
    // Fresh suite-level conflict that --force should bypass.
    const fakeRunningRow = {
      runId: "other-suite",
      pipelineName: IMPROVE_ENTITY_SUITE_PIPELINE_NAME,
      agentSessionId: 1,
      status: "running",
      startedAt: new Date(NOW).toISOString(),
      heartbeatAt: new Date(NOW).toISOString(),
    };
    const list = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { runs: [fakeRunningRow], count: 1 } });
    const improver = async ({ slug }: { slug: string }) => makeResult(slug);
    const snap = await runSuiteForTest({
      tag: "force",
      totalBudgetUsd: 4.0,
      maxIters: 1,
      suitePath,
      snapshotDir,
      improver,
      force: true,
      mutexCheckOverrides: { list, nowMs: () => NOW },
    });
    // Both entities ran; suite-level check was short-circuited by --force.
    expect(snap.entities.map((r) => r.status)).toEqual(["completed", "completed"]);
    // The list mock should not have been called: --force short-circuits
    // before the API request.
    expect(list).not.toHaveBeenCalled();
  });

  it("forwards force=true to per-entity calls unconditionally (avoids self-conflict on suite's own running row)", async () => {
    const { suitePath, snapshotDir } = writeFixtureSuite(
      { slug: "alpha", type: "policy" },
      { slug: "beta", type: "policy" },
    );
    const forceSeenByImprover: boolean[] = [];
    const improver = async ({ force, slug }: { slug: string; force?: boolean }) => {
      forceSeenByImprover.push(force === true);
      return makeResult(slug);
    };
    // No --force at the suite level (the `runSuiteForTest` no-op mutex
    // returns no conflicts so the suite proceeds).
    await runSuiteForTest({
      tag: "no-suite-force",
      totalBudgetUsd: 4.0,
      maxIters: 1,
      suitePath,
      snapshotDir,
      improver,
    });
    // Even without --force at the suite level, per-entity calls still get
    // force=true. The suite already owns the family-level lock; without
    // this, the per-entity check would self-conflict on the suite's own
    // `improve-entity-suite` running row.
    expect(forceSeenByImprover).toEqual([true, true]);
  });
});

// ── exported constant sanity ───────────────────────────────────────────────

describe("constants", () => {
  it("MIN_USEFUL_BUDGET_USD matches the inner-loop floor in research-improve-entity", () => {
    // Mirrors the `budgetRemaining <= 0.05` guard in research-improve-entity.ts.
    expect(MIN_USEFUL_BUDGET_USD).toBe(0.05);
  });

  it("DEFAULT_PER_ENTITY_BUDGET_USD is $2 per QUA-1033 spec", () => {
    // QUA-1033 specifies $2 per supported entity as the suite default. Changing
    // this constant changes the default total budget for all suite invocations
    // — keep the test in sync with the constant if we ever revisit the value.
    expect(DEFAULT_PER_ENTITY_BUDGET_USD).toBe(2.0);
  });

  it("DEFAULT_PER_ENTITY_BUDGET_USD × N propagates through runSuite as totalBudgetUsd", async () => {
    // The CLI's default-budget computation passes `DEFAULT_PER_ENTITY_BUDGET_USD * supported.length`
    // as `totalBudgetUsd`. This test verifies the per-entity inner-budget math
    // that follows: per-entity cap = (total / N) × 2 = $2 × 2 = $4 with this default.
    const { suitePath, snapshotDir } = writeFixtureSuite(
      { slug: "alpha", type: "policy" },
      { slug: "beta", type: "policy" },
    );
    const supportedCount = 2;
    const defaultTotalBudget = DEFAULT_PER_ENTITY_BUDGET_USD * supportedCount;
    const budgetsSeen: number[] = [];
    const improver = async ({ budgetUsd }: { budgetUsd?: number }) => {
      budgetsSeen.push(budgetUsd ?? -1);
      return makeResult("x", { iterations: [makeIter({ cost_research_usd: 0, cost_extract_usd: 0 })] });
    };
    const snap = await runSuite({
      tag: "default-budget",
      totalBudgetUsd: defaultTotalBudget,
      maxIters: 1,
      suitePath,
      snapshotDir,
      improver,
    });
    expect(snap.budget_usd).toBe(4.0);
    expect(snap.per_entity_cap_usd).toBeCloseTo(4.0, 6); // (4/2)*2
    expect(budgetsSeen).toEqual([4.0, 4.0]);
  });
});

// ── computeDefaultTotalBudgetUsd (CLI default-budget path) ──────────────────

describe("computeDefaultTotalBudgetUsd", () => {
  it("multiplies DEFAULT_PER_ENTITY_BUDGET_USD by the count of supported entities only", () => {
    // 3 policies + 1 organization (organization is not supported in v1).
    const { suitePath } = writeFixtureSuite(
      { slug: "p1", type: "policy" },
      { slug: "p2", type: "policy" },
      { slug: "p3", type: "policy" },
      { slug: "org", type: "organization" },
    );
    const r = computeDefaultTotalBudgetUsd(suitePath);
    expect(r.supportedCount).toBe(3);
    expect(r.totalBudgetUsd).toBeCloseTo(DEFAULT_PER_ENTITY_BUDGET_USD * 3, 6);
  });

  it("returns 0 supported and 0 total when the suite has no supported types", () => {
    // CLI uses the supportedCount=0 signal to return a friendly error rather
    // than a misleading "--budget must be a positive number".
    const { suitePath } = writeFixtureSuite({ slug: "x", type: "organization" });
    const r = computeDefaultTotalBudgetUsd(suitePath);
    expect(r.supportedCount).toBe(0);
    expect(r.totalBudgetUsd).toBe(0);
  });

  it("propagates loadSuite errors (e.g. missing file)", () => {
    expect(() => computeDefaultTotalBudgetUsd("/nonexistent/path/suite.yaml")).toThrow();
  });
});

// ── inspectSuite (QUA-1034) ────────────────────────────────────────────────

describe("inspectSuite", () => {
  function writeSuite(entries: SuiteEntry[]): string {
    const dir = tmpdir("inspect-suite");
    const filePath = path.join(dir, "suite.yaml");
    fs.writeFileSync(
      filePath,
      entries
        .map((e) =>
          `- slug: ${e.slug}\n  type: ${e.type}` +
          (e.expected_min_coverage != null ? `\n  expected_min_coverage: ${e.expected_min_coverage}` : "") +
          "\n",
        )
        .join(""),
    );
    return filePath;
  }

  it("returns one report per supported entity, with cost from injected history", async () => {
    const suitePath = writeSuite([
      { slug: "a-policy", type: "policy" },
      { slug: "b-policy", type: "policy" },
      { slug: "c-org", type: "organization" }, // filtered out (v1: policy-only)
    ]);
    const entitiesById: Record<string, EntityWithType> = {
      "a-policy": { id: "a-policy", type: "policy", title: "A", stableId: "sid_a" },
      "b-policy": { id: "b-policy", type: "policy", title: "B", stableId: "sid_b" },
    };
    const fakeRuns = [
      { runId: "r1", pipelineName: "improve-entity", entityId: "sid_a", status: "committed", costUsd: "0.80" },
    ] as unknown as PipelineRunRow[];
    const { reports, notFound } = await inspectSuite({
      suitePath,
      loadEntityFn: vi.fn((slug: string) => entitiesById[slug] ?? null),
      fetchHistoryFn: vi.fn(async () => fakeRuns),
    });
    expect(notFound).toEqual([]);
    expect(reports).toHaveLength(2);
    expect(reports[0].slug).toBe("a-policy");
    expect(reports[0].costSource).toBe("history"); // matched the fake run
    expect(reports[1].slug).toBe("b-policy");
    expect(reports[1].costSource).toBe("fallback"); // no matching history
  });

  it("collects slugs that are in the suite YAML but missing from data/entities/", async () => {
    const suitePath = writeSuite([
      { slug: "present", type: "policy" },
      { slug: "missing", type: "policy" },
    ]);
    const { reports, notFound } = await inspectSuite({
      suitePath,
      loadEntityFn: vi.fn((slug: string) =>
        slug === "present"
          ? ({ id: "present", type: "policy", stableId: "sid_p" } as EntityWithType)
          : null,
      ),
      fetchHistoryFn: vi.fn(async () => []),
    });
    expect(reports.map((r) => r.slug)).toEqual(["present"]);
    expect(notFound).toEqual(["missing"]);
  });

  it("uses fallback estimates when fetchHistory returns []", async () => {
    const suitePath = writeSuite([{ slug: "a", type: "policy" }]);
    const { reports } = await inspectSuite({
      suitePath,
      loadEntityFn: vi.fn(() => ({ id: "a", type: "policy", stableId: "sid_a" } as EntityWithType)),
      fetchHistoryFn: vi.fn(async () => []),
    });
    expect(reports[0].costSource).toBe("fallback");
    expect(reports[0].historicalRunCount).toBe(0);
  });

  it("makes ZERO calls to the real improver — inspect path is LLM-free", async () => {
    // The CLI inspect short-circuit means improveSingleEntity should never be
    // called. inspectSuite() does not take an improver — that's the point.
    // This test verifies the function signature does not regress: its only
    // injectables are loadEntityFn + fetchHistoryFn, both of which are
    // read-only. If a future change adds an `improver?:` to `InspectSuiteOptions`,
    // this test won't catch it directly, but the static-source check in
    // inspect.test.ts (`expect(source).not.toMatch(/createLlmClient/)`) will.
    const suitePath = writeSuite([{ slug: "a", type: "policy" }]);
    const loadEntityFn = vi.fn(() => ({ id: "a", type: "policy", stableId: "sid_a" } as EntityWithType));
    const fetchHistoryFn = vi.fn(async () => [] as PipelineRunRow[]);
    await inspectSuite({ suitePath, loadEntityFn, fetchHistoryFn });
    // Sanity: only the two injected hooks were invoked.
    expect(loadEntityFn).toHaveBeenCalledTimes(1);
    expect(fetchHistoryFn).toHaveBeenCalledTimes(1);
  });
});
