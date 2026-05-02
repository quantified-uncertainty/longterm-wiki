/**
 * Tests for `crux tb pipeline-regression-check` (QUA-871).
 *
 * Pure decision logic is tested directly via `decide()`. PR-body parsing has
 * its own block (it's the override mechanism — must be both robust against
 * malformed input and not too eager to match unrelated comments). The CLI
 * `run()` is exercised against tmpdir snapshot files for the I/O wiring.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  decide,
  formatComment,
  parseBenchmarkSkip,
  run,
  type RegressionDecision,
} from "./research-pipeline-regression-check.ts";
import type { SuiteSnapshot as CoverageSnapshot } from "./research-benchmark-suite.ts";
import type { SuiteSnapshot as ImproveSnapshot } from "./research-improve-entity-suite.ts";

// ── Snapshot fixtures ───────────────────────────────────────────────────────

function makeCov(median: number, p25 = median - 0.05, sha = "abc1234"): CoverageSnapshot {
  return {
    tag: "fixture",
    timestamp: "2026-05-02T00:00:00.000Z",
    git_sha: sha,
    suite_size: 2,
    entities: [
      {
        slug: "fisa-702",
        type: "policy",
        coverage_score: median + 0.05,
        components: {},
        facts_in_yaml: {},
        expected_min_coverage: 0.9,
        status: "scored",
      },
      {
        slug: "eu-ai-act",
        type: "policy",
        coverage_score: median - 0.05,
        components: {},
        facts_in_yaml: {},
        expected_min_coverage: 0.9,
        status: "scored",
      },
    ],
    aggregate: {
      scored_count: 2,
      unsupported_count: 0,
      missing_count: 0,
      type_mismatch_count: 0,
      median_coverage_score: median,
      p25_coverage_score: p25,
      count_below_min: 0,
      below_min_slugs: [],
    },
  };
}

function makeImprove(verified: number, sha = "abc1234", cost = 0.32): ImproveSnapshot {
  return {
    tag: "fixture",
    git_sha: sha,
    started_at: "2026-05-02T00:00:00.000Z",
    ended_at: "2026-05-02T00:05:00.000Z",
    budget_usd: 5,
    per_entity_cap_usd: 1.25,
    max_iters: 1,
    dry_run: false,
    entities: [
      {
        slug: "fisa-702",
        type: "policy",
        status: "completed",
        iterations: [],
        claims_proposed: 10,
        claims_verified: 9,
        claims_partial: 0,
        claims_contradicted: 0,
        claims_unverifiable: 1,
        verified_rate: verified + 0.02,
        applied_to_yaml: 9,
        cost_usd: 0.16,
        duration_s: 60,
      },
      {
        slug: "eu-ai-act",
        type: "policy",
        status: "completed",
        iterations: [],
        claims_proposed: 10,
        claims_verified: 8,
        claims_partial: 0,
        claims_contradicted: 0,
        claims_unverifiable: 2,
        verified_rate: verified - 0.02,
        applied_to_yaml: 8,
        cost_usd: 0.16,
        duration_s: 60,
      },
    ],
    aggregate: {
      median_verified_rate: verified,
      p25_verified_rate: verified - 0.05,
      total_cost_usd: cost,
      total_duration_s: 120,
      entities_completed: 2,
      entities_skipped_budget: 0,
      entities_failed: 0,
    },
  };
}

const THRESH = { coverage: 0.05, verified: 0.05 };

// ── parseBenchmarkSkip ──────────────────────────────────────────────────────

describe("parseBenchmarkSkip", () => {
  it("returns null on empty body", () => {
    expect(parseBenchmarkSkip("")).toBeNull();
  });

  it("returns null when the marker is absent", () => {
    expect(
      parseBenchmarkSkip("## Summary\nNothing to see here, just a normal PR."),
    ).toBeNull();
  });

  it("extracts the reason verbatim", () => {
    const out = parseBenchmarkSkip(
      "Body text.\n<!-- benchmark-skip: stricter pre-filter, intentional drop -->\nMore text.",
    );
    expect(out).toEqual({ reason: "stricter pre-filter, intentional drop" });
  });

  it("trims whitespace inside the marker", () => {
    expect(parseBenchmarkSkip("<!--   benchmark-skip:   token-fix    -->"))
      .toEqual({ reason: "token-fix" });
  });

  it("returns null when reason is empty", () => {
    expect(parseBenchmarkSkip("<!-- benchmark-skip:  -->")).toBeNull();
    expect(parseBenchmarkSkip("<!-- benchmark-skip: -->")).toBeNull();
  });

  it("matches case-insensitively on the keyword", () => {
    expect(parseBenchmarkSkip("<!-- BENCHMARK-SKIP: foo -->"))
      .toEqual({ reason: "foo" });
  });

  it("ignores unrelated HTML comments", () => {
    expect(
      parseBenchmarkSkip("<!-- benchmark-other: blah -->\n<!-- ci-skip -->"),
    ).toBeNull();
  });

  it("does not match across lines (avoids capturing the rest of the body)", () => {
    expect(
      parseBenchmarkSkip("<!-- benchmark-skip:\nsneaky multi-line -->"),
    ).toBeNull();
  });
});

// ── decide() — pure threshold logic ─────────────────────────────────────────

describe("decide", () => {
  it("passes when both medians are stable", () => {
    const d = decide(makeCov(0.85), makeCov(0.85), makeImprove(0.92), makeImprove(0.92), null, THRESH);
    expect(d.verdict).toBe("pass");
    expect(d.reasons).toEqual([]);
  });

  it("passes when candidate is better", () => {
    const d = decide(makeCov(0.80), makeCov(0.90), makeImprove(0.85), makeImprove(0.95), null, THRESH);
    expect(d.verdict).toBe("pass");
  });

  it("fails on a coverage_score regression beyond threshold", () => {
    // 0.85 → 0.75 = drop 0.10 > 0.05 threshold
    const d = decide(makeCov(0.85), makeCov(0.75), makeImprove(0.92), makeImprove(0.92), null, THRESH);
    expect(d.verdict).toBe("fail");
    expect(d.reasons).toHaveLength(1);
    expect(d.reasons[0]).toMatch(/coverage_score/);
    expect(d.reasons[0]).toMatch(/0\.100/);
  });

  it("fails on a verified_rate regression beyond threshold", () => {
    // 0.92 → 0.80 = drop 0.12 > 0.05 (12pts > 5pts)
    const d = decide(makeCov(0.85), makeCov(0.85), makeImprove(0.92), makeImprove(0.80), null, THRESH);
    expect(d.verdict).toBe("fail");
    expect(d.reasons).toHaveLength(1);
    expect(d.reasons[0]).toMatch(/verified_rate/);
    expect(d.reasons[0]).toMatch(/12\.0pts/);
  });

  it("fails with both reasons when both metrics regress", () => {
    const d = decide(makeCov(0.90), makeCov(0.70), makeImprove(0.95), makeImprove(0.70), null, THRESH);
    expect(d.verdict).toBe("fail");
    expect(d.reasons).toHaveLength(2);
  });

  it("passes when the regression is exactly at the threshold (jitter tolerance)", () => {
    // drop == 0.05, NOT > 0.05 — no breach
    const d = decide(makeCov(0.85), makeCov(0.80), makeImprove(0.92), makeImprove(0.87), null, THRESH);
    expect(d.verdict).toBe("pass");
  });

  it("returns advisory when baseline coverage is missing", () => {
    const d = decide(null, makeCov(0.85), makeImprove(0.92), makeImprove(0.92), null, THRESH);
    expect(d.verdict).toBe("advisory");
    expect(d.summary).toMatch(/No baseline snapshots/);
  });

  it("returns advisory when baseline improve is missing", () => {
    const d = decide(makeCov(0.85), makeCov(0.85), null, makeImprove(0.92), null, THRESH);
    expect(d.verdict).toBe("advisory");
  });

  it("override flips fail to override but preserves reasons", () => {
    const d = decide(
      makeCov(0.85),
      makeCov(0.70),
      makeImprove(0.92),
      makeImprove(0.70),
      { reason: "stricter pre-filter, intentional drop" },
      THRESH,
    );
    expect(d.verdict).toBe("override");
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.summary).toMatch(/stricter pre-filter/);
  });

  it("override on a clean run does NOT change the verdict to override", () => {
    // No regression detected — override is irrelevant; report pass.
    const d = decide(
      makeCov(0.85),
      makeCov(0.85),
      makeImprove(0.92),
      makeImprove(0.92),
      { reason: "intentional something" },
      THRESH,
    );
    expect(d.verdict).toBe("pass");
  });

  it("handles null medians gracefully (zero scored entities)", () => {
    const empty = makeCov(0);
    empty.aggregate.median_coverage_score = null;
    empty.aggregate.p25_coverage_score = null;
    empty.aggregate.scored_count = 0;
    const d = decide(empty, empty, makeImprove(0.92), makeImprove(0.92), null, THRESH);
    expect(d.verdict).toBe("pass");
    expect(d.delta.median_coverage_score).toBeNull();
  });

  it("custom thresholds are respected", () => {
    // drop 0.06 with threshold 0.10 — passes
    const d = decide(makeCov(0.85), makeCov(0.79), makeImprove(0.92), makeImprove(0.92), null, {
      coverage: 0.10,
      verified: 0.05,
    });
    expect(d.verdict).toBe("pass");
  });
});

// ── formatComment ───────────────────────────────────────────────────────────

describe("formatComment", () => {
  it("includes the upsert marker on every output", () => {
    const d: RegressionDecision = decide(
      makeCov(0.85),
      makeCov(0.85),
      makeImprove(0.92),
      makeImprove(0.92),
      null,
      THRESH,
    );
    const md = formatComment(d, makeCov(0.85), makeCov(0.85), makeImprove(0.92), makeImprove(0.92));
    expect(md).toContain("<!-- improve-pipeline-benchmark:comment-marker -->");
  });

  it("renders per-entity rows for both baseline and candidate", () => {
    const d = decide(makeCov(0.85), makeCov(0.85), makeImprove(0.92), makeImprove(0.92), null, THRESH);
    const md = formatComment(d, makeCov(0.85), makeCov(0.85), makeImprove(0.92), makeImprove(0.92));
    expect(md).toContain("`fisa-702`");
    expect(md).toContain("`eu-ai-act`");
  });

  it("only shows the override-howto on fail, not on pass", () => {
    const pass = decide(makeCov(0.85), makeCov(0.85), makeImprove(0.92), makeImprove(0.92), null, THRESH);
    const passMd = formatComment(pass, makeCov(0.85), makeCov(0.85), makeImprove(0.92), makeImprove(0.92));
    expect(passMd).not.toContain("<!-- benchmark-skip:");

    const fail = decide(makeCov(0.85), makeCov(0.70), makeImprove(0.92), makeImprove(0.92), null, THRESH);
    const failMd = formatComment(fail, makeCov(0.85), makeCov(0.70), makeImprove(0.92), makeImprove(0.92));
    expect(failMd).toContain("<!-- benchmark-skip:");
  });

  it("renders the override section on override verdict", () => {
    const ovr = decide(
      makeCov(0.85),
      makeCov(0.70),
      makeImprove(0.92),
      makeImprove(0.92),
      { reason: "stricter pre-filter" },
      THRESH,
    );
    const md = formatComment(ovr, makeCov(0.85), makeCov(0.70), makeImprove(0.92), makeImprove(0.92));
    expect(md).toContain("### Override");
    expect(md).toContain("stricter pre-filter");
  });

  it("renders advisory mode without crashing on null baselines", () => {
    const adv = decide(null, makeCov(0.85), null, makeImprove(0.92), null, THRESH);
    const md = formatComment(adv, null, makeCov(0.85), null, makeImprove(0.92));
    expect(md).toContain("No baseline snapshots");
    expect(md).toMatch(/`fisa-702`/);
  });
});

// ── run() — end-to-end CLI wiring ───────────────────────────────────────────

describe("run", () => {
  async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-regression-"));
    try {
      return await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function writeJson(filePath: string, obj: unknown) {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
  }

  it("exits 2 when candidate snapshots are missing", async () => {
    const r = await run([], {});
    expect(r.exitCode).toBe(2);
    expect(r.output).toMatch(/Usage:/);
  });

  it("exits 2 when candidate file does not exist", async () => {
    const r = await run([], {
      candidateCoverage: "/nonexistent/cov.json",
      candidateImprove: "/nonexistent/imp.json",
    });
    expect(r.exitCode).toBe(2);
    expect(r.output).toMatch(/Candidate coverage snapshot not found/);
  });

  it("exits 0 in advisory mode when baseline files are missing", async () => {
    return withTmpDir(async (dir) => {
      const candCov = path.join(dir, "cand-cov.json");
      const candImp = path.join(dir, "cand-imp.json");
      const commentOut = path.join(dir, "comment.md");
      writeJson(candCov, makeCov(0.85));
      writeJson(candImp, makeImprove(0.92));

      const r = await run([], {
        candidateCoverage: candCov,
        candidateImprove: candImp,
        writeCommentFile: commentOut,
      });
      expect(r.exitCode).toBe(0);
      const md = fs.readFileSync(commentOut, "utf8");
      expect(md).toContain("No baseline snapshots");
    });
  });

  it("exits 1 on a real regression and writes the comment file", async () => {
    return withTmpDir(async (dir) => {
      const baseCov = path.join(dir, "base-cov.json");
      const baseImp = path.join(dir, "base-imp.json");
      const candCov = path.join(dir, "cand-cov.json");
      const candImp = path.join(dir, "cand-imp.json");
      const commentOut = path.join(dir, "comment.md");
      writeJson(baseCov, makeCov(0.85));
      writeJson(baseImp, makeImprove(0.92));
      writeJson(candCov, makeCov(0.70)); // 0.15 drop
      writeJson(candImp, makeImprove(0.70)); // 22pt drop

      const r = await run([], {
        baselineCoverage: baseCov,
        baselineImprove: baseImp,
        candidateCoverage: candCov,
        candidateImprove: candImp,
        writeCommentFile: commentOut,
      });
      expect(r.exitCode).toBe(1);
      const md = fs.readFileSync(commentOut, "utf8");
      expect(md).toContain("Regression detected");
    });
  });

  it("exits 0 with override when PR body contains benchmark-skip marker", async () => {
    return withTmpDir(async (dir) => {
      const baseCov = path.join(dir, "base-cov.json");
      const baseImp = path.join(dir, "base-imp.json");
      const candCov = path.join(dir, "cand-cov.json");
      const candImp = path.join(dir, "cand-imp.json");
      const prBody = path.join(dir, "pr-body.txt");
      writeJson(baseCov, makeCov(0.85));
      writeJson(baseImp, makeImprove(0.92));
      writeJson(candCov, makeCov(0.70));
      writeJson(candImp, makeImprove(0.70));
      fs.writeFileSync(
        prBody,
        "## Summary\n<!-- benchmark-skip: stricter pre-filter -->\n",
      );

      const r = await run([], {
        baselineCoverage: baseCov,
        baselineImprove: baseImp,
        candidateCoverage: candCov,
        candidateImprove: candImp,
        prBodyFile: prBody,
      });
      expect(r.exitCode).toBe(0);
    });
  });

  it("rejects out-of-range thresholds", async () => {
    return withTmpDir(async (dir) => {
      const candCov = path.join(dir, "cand-cov.json");
      const candImp = path.join(dir, "cand-imp.json");
      writeJson(candCov, makeCov(0.85));
      writeJson(candImp, makeImprove(0.92));

      const r = await run([], {
        candidateCoverage: candCov,
        candidateImprove: candImp,
        verifiedThreshold: "5",
      });
      expect(r.exitCode).toBe(2);
      expect(r.output).toMatch(/verified-threshold/);
    });
  });

  it("respects custom thresholds when set", async () => {
    return withTmpDir(async (dir) => {
      const baseCov = path.join(dir, "base-cov.json");
      const baseImp = path.join(dir, "base-imp.json");
      const candCov = path.join(dir, "cand-cov.json");
      const candImp = path.join(dir, "cand-imp.json");
      writeJson(baseCov, makeCov(0.85));
      writeJson(baseImp, makeImprove(0.92));
      // 0.07 drop — fails default 0.05 threshold, passes custom 0.10
      writeJson(candCov, makeCov(0.78));
      writeJson(candImp, makeImprove(0.92));

      const fail = await run([], {
        baselineCoverage: baseCov,
        baselineImprove: baseImp,
        candidateCoverage: candCov,
        candidateImprove: candImp,
      });
      expect(fail.exitCode).toBe(1);

      const pass = await run([], {
        baselineCoverage: baseCov,
        baselineImprove: baseImp,
        candidateCoverage: candCov,
        candidateImprove: candImp,
        coverageThreshold: "0.10",
      });
      expect(pass.exitCode).toBe(0);
    });
  });
});
