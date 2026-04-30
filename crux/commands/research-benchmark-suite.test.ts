// Integration test: exercise the v1 8-entity policy suite end-to-end.
//
// Uses a unique tag prefix (`itest-<pid>-<rand>`) so concurrent runs and
// developer-local snapshots don't collide; each test cleans up its own files.
// .claude/snapshots/ is gitignored, so leftover files (if a test crashes
// between write and cleanup) don't pollute git status.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  buildSnapshot,
  run,
} from "./research-benchmark-suite.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SNAPSHOT_DIR = path.join(ROOT, ".claude/snapshots/benchmark-suite");

const TAG_PREFIX = `itest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let tagCounter = 0;
const usedTags: string[] = [];
function nextTag(label: string): string {
  const tag = `${TAG_PREFIX}-${tagCounter++}-${label}`;
  usedTags.push(tag);
  return tag;
}

afterEach(() => {
  for (const tag of usedTags.splice(0)) {
    const p = path.join(SNAPSHOT_DIR, `${tag}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

describe("buildSnapshot — v1 policy suite", () => {
  it("loads the committed suite + scores all 8 entities under 30s", () => {
    const start = Date.now();
    const snap = buildSnapshot("itest-build");
    const elapsed = Date.now() - start;

    expect(snap.tag).toBe("itest-build");
    expect(snap.suite_size).toBe(8);
    expect(snap.entities).toHaveLength(8);
    // Pure-read budget per the ticket's acceptance criteria.
    expect(elapsed).toBeLessThan(30_000);
  });

  it("includes the canonical policy slugs from the suite YAML", () => {
    const snap = buildSnapshot("itest-slugs");
    const slugs = snap.entities.map((e) => e.slug).sort();
    expect(slugs).toEqual([
      "california-sb1047",
      "california-sb53",
      "china-ai-regulations",
      "colorado-ai-act",
      "eu-ai-act",
      "fisa-702",
      "trump-ai-framework-2026",
      "us-executive-order",
    ]);
  });

  it("every entity has a numeric coverage_score in [0, 1] and matching expected_min_coverage", () => {
    const snap = buildSnapshot("itest-bounds");
    for (const e of snap.entities) {
      expect(e.type).toBe("policy");
      expect(typeof e.coverage_score).toBe("number");
      expect(e.coverage_score).toBeGreaterThanOrEqual(0);
      expect(e.coverage_score).toBeLessThanOrEqual(1);
      expect(typeof e.expected_min_coverage).toBe("number");
      expect(e.expected_min_coverage).toBeGreaterThanOrEqual(0);
      expect(e.expected_min_coverage).toBeLessThanOrEqual(1);
      expect(e.facts_in_yaml).toMatchObject({
        provisions: expect.any(Number),
        stakeholders: expect.any(Number),
        tags: expect.any(Number),
        relatedEntries: expect.any(Number),
        top_level_filled: expect.any(Number),
      });
    }
  });

  it("computes aggregate fields with sane shapes", () => {
    const snap = buildSnapshot("itest-aggregate");
    const a = snap.aggregate;
    expect(a.count).toBe(8);
    expect(a.median_coverage_score).toBeGreaterThanOrEqual(0);
    expect(a.median_coverage_score).toBeLessThanOrEqual(1);
    expect(a.p25_coverage_score).toBeGreaterThanOrEqual(0);
    expect(a.p25_coverage_score).toBeLessThanOrEqual(a.median_coverage_score);
    expect(a.count_below_min).toBe(a.below_min_slugs.length);
    // Every "below min" slug must be a real suite slug.
    const suiteSlugs = new Set(snap.entities.map((e) => e.slug));
    for (const s of a.below_min_slugs) expect(suiteSlugs.has(s)).toBe(true);
  });

  it("each suite entry's expected_min_coverage is set conservatively (≤ current coverage)", () => {
    // The ticket calls out that thresholds should be set so normal pipeline
    // noise doesn't immediately flip count_below_min. If this test fails on
    // a fresh checkout, edit crux/benchmarks/entity-suite.yaml to lower the
    // floor for the offending slug — don't loosen the assertion.
    const snap = buildSnapshot("itest-thresholds");
    for (const e of snap.entities) {
      expect(e.coverage_score).toBeGreaterThanOrEqual(e.expected_min_coverage);
    }
  });
});

describe("run — CLI surface", () => {
  it("--tag persists a snapshot file and prints the summary", async () => {
    const tag = nextTag("tag");
    const result = await run([], { tag });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`Snapshot saved: ${tag}`);
    expect(result.output).toContain("aggregate:");
    const file = path.join(SNAPSHOT_DIR, `${tag}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.tag).toBe(tag);
    expect(onDisk.entities).toHaveLength(8);
    expect(onDisk.aggregate).toMatchObject({
      count: 8,
      count_below_min: expect.any(Number),
      below_min_slugs: expect.any(Array),
    });
  });

  it("--list includes a snapshot we just wrote", async () => {
    const tag = nextTag("list");
    await run([], { tag });
    const result = await run([], { list: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(tag);
    expect(result.output).toContain("size=8");
  });

  it("--diff prints per-entity table + aggregate diff for two existing tags", async () => {
    const a = nextTag("diff-a");
    const b = nextTag("diff-b");
    await run([], { tag: a });
    await run([], { tag: b });
    const result = await run([], { diff: `${a},${b}` });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`suite diff: ${a} → ${b}`);
    expect(result.output).toContain("Per-entity coverage:");
    expect(result.output).toContain("Aggregate:");
    expect(result.output).toContain("median");
    expect(result.output).toContain("p25");
    expect(result.output).toContain("count_below_min");
    // All 8 suite slugs should appear in the diff body.
    for (const slug of [
      "fisa-702",
      "eu-ai-act",
      "california-sb1047",
      "us-executive-order",
      "colorado-ai-act",
      "california-sb53",
      "trump-ai-framework-2026",
      "china-ai-regulations",
    ]) {
      expect(result.output).toContain(slug);
    }
  });

  it("--diff exits 1 when a referenced tag is missing", async () => {
    const result = await run([], { diff: `does-not-exist-1,does-not-exist-2` });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No suite snapshot tagged");
  });

  it("--diff with malformed value returns usage error", async () => {
    const result = await run([], { diff: "only-one" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Usage: --diff");
  });

  it("rejects path-unsafe tags", async () => {
    const result = await run([], { tag: "../escape" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Tag must match");
  });

  it("prints usage when called with no flags", async () => {
    const result = await run([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Provide");
  });
});
