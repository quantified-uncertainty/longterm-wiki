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
  formatDiff,
  formatList,
  formatSnapshotSummary,
  run,
  type SuiteSnapshot,
  type SuiteSnapshotEntity,
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

  it("rejects tags with a leading dot (no hidden-dot files)", async () => {
    const r1 = await run([], { tag: ".hidden" });
    expect(r1.exitCode).toBe(1);
    expect(r1.output).toContain("Tag must match");
    const r2 = await run([], { tag: "..foo" });
    expect(r2.exitCode).toBe(1);
    expect(r2.output).toContain("Tag must match");
  });

  it("snapshot file is well-formed JSON ending with a newline", async () => {
    const tag = nextTag("newline");
    await run([], { tag });
    const file = path.join(SNAPSHOT_DIR, `${tag}.json`);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("written snapshots include schema_version", async () => {
    const tag = nextTag("schema");
    await run([], { tag });
    const file = path.join(SNAPSHOT_DIR, `${tag}.json`);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.schema_version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Formatter unit tests — exercise rendering branches that the live 8-entity
// suite doesn't naturally hit (added/removed entities, below-min flag,
// empty-list output). Use hand-built SuiteSnapshot fixtures so the test
// doesn't depend on ambient YAML state.
// ---------------------------------------------------------------------------

function fakeEntity(
  slug: string,
  score: number,
  min: number,
): SuiteSnapshotEntity {
  return {
    slug,
    type: "policy",
    coverage_score: score,
    expected_min_coverage: min,
    components: { top_level: 0, provisions: 0, stakeholders: 0, tags: 0, relatedEntries: 0 },
    facts_in_yaml: {
      provisions: 0,
      stakeholders: 0,
      tags: 0,
      relatedEntries: 0,
      top_level_filled: 0,
    },
  };
}

function fakeSnapshot(tag: string, entities: SuiteSnapshotEntity[]): SuiteSnapshot {
  const below = entities.filter((e) => e.coverage_score < e.expected_min_coverage);
  return {
    schema_version: 1,
    tag,
    timestamp: "2026-01-01T00:00:00.000Z",
    git_sha: "deadbeef",
    suite_size: entities.length,
    entities,
    aggregate: {
      count: entities.length,
      median_coverage_score: 0.5,
      p25_coverage_score: 0.25,
      count_below_min: below.length,
      below_min_slugs: below.map((e) => e.slug),
    },
  };
}

describe("formatList", () => {
  it("returns the empty-state message when no snapshots exist", () => {
    expect(formatList([])).toContain("No suite snapshots");
  });

  it("renders one row per snapshot with size + aggregate columns", () => {
    const snaps = [
      fakeSnapshot("baseline", [fakeEntity("a", 0.9, 0.5)]),
      fakeSnapshot("after", [fakeEntity("a", 0.8, 0.5)]),
    ];
    const out = formatList(snaps);
    expect(out).toContain("baseline");
    expect(out).toContain("after");
    expect(out).toContain("size=1");
    expect(out).toContain("median=");
    expect(out).toContain("p25=");
    expect(out).toContain("below=");
  });
});

describe("formatSnapshotSummary", () => {
  it("flags entries below their expected_min_coverage", () => {
    // 0.4 vs floor 0.5 → should appear with "✗ below min".
    const snap = fakeSnapshot("low", [fakeEntity("thin-policy", 0.4, 0.5)]);
    const out = formatSnapshotSummary(snap);
    expect(out).toContain("thin-policy");
    expect(out).toContain("✗ below min");
  });

  it("does not flag entries at or above the floor", () => {
    const snap = fakeSnapshot("ok", [
      fakeEntity("equal", 0.5, 0.5),
      fakeEntity("above", 0.9, 0.5),
    ]);
    const out = formatSnapshotSummary(snap);
    expect(out).not.toContain("✗ below min");
  });

  it("only lists below_min_slugs when there are any", () => {
    const empty = fakeSnapshot("empty", [fakeEntity("a", 0.9, 0.5)]);
    expect(formatSnapshotSummary(empty)).not.toContain("below_min_slugs:");
    const withBelow = fakeSnapshot("with", [fakeEntity("bad", 0.1, 0.5)]);
    expect(formatSnapshotSummary(withBelow)).toContain("below_min_slugs:");
  });
});

describe("formatDiff", () => {
  it("marks entities added between snapshots", () => {
    const before = fakeSnapshot("a", [fakeEntity("only-before", 0.9, 0.5)]);
    const after = fakeSnapshot("b", [
      fakeEntity("only-before", 0.9, 0.5),
      fakeEntity("only-after", 0.8, 0.5),
    ]);
    const out = formatDiff(before, after);
    expect(out).toContain("only-after");
    expect(out).toContain("(added)");
  });

  it("marks entities removed between snapshots", () => {
    const before = fakeSnapshot("a", [
      fakeEntity("only-before", 0.9, 0.5),
      fakeEntity("dropped", 0.8, 0.5),
    ]);
    const after = fakeSnapshot("b", [fakeEntity("only-before", 0.9, 0.5)]);
    const out = formatDiff(before, after);
    expect(out).toContain("dropped");
    expect(out).toContain("(removed)");
  });

  it("reports newly-below-min slugs but not pre-existing ones", () => {
    const before = fakeSnapshot("a", [
      fakeEntity("preexisting-below", 0.4, 0.5),
      fakeEntity("regressed", 0.9, 0.5),
    ]);
    const after = fakeSnapshot("b", [
      fakeEntity("preexisting-below", 0.4, 0.5),
      fakeEntity("regressed", 0.4, 0.5),
    ]);
    const out = formatDiff(before, after);
    expect(out).toContain("newly below min:");
    expect(out).toContain("regressed");
    // preexisting-below was already below; should NOT be listed as newly below.
    const newlyBelowLine =
      out.split("\n").find((l) => l.includes("newly below min:")) ?? "";
    expect(newlyBelowLine).not.toContain("preexisting-below");
  });

  it("reports recovered slugs (below before, above after)", () => {
    const before = fakeSnapshot("a", [fakeEntity("recovered", 0.4, 0.5)]);
    const after = fakeSnapshot("b", [fakeEntity("recovered", 0.9, 0.5)]);
    const out = formatDiff(before, after);
    expect(out).toContain("recovered:");
    expect(out).toContain("recovered");
  });

  it("zero-delta rendering does not include a stray sign character", () => {
    const before = fakeSnapshot("a", [fakeEntity("steady", 0.5, 0.5)]);
    const after = fakeSnapshot("b", [fakeEntity("steady", 0.5, 0.5)]);
    const out = formatDiff(before, after);
    // Zero deltas should be `( 0.00)` width-aligned without a "+" prefix.
    // The current rule: `+` only on positive deltas; nothing prepended for
    // zero or negative. So the parens contents must be exactly "0.00".
    expect(out).toMatch(/\(0\.00\)/);
    expect(out).not.toMatch(/\(\+0\.00\)/);
  });
});

