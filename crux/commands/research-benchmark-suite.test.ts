/**
 * Tests for `crux tb benchmark-suite` (QUA-873).
 *
 * Pure helpers (median, p25, scoreSuite, computeAggregate, isValidTag) are
 * tested directly. Snapshot read/write is exercised against tmpdir. End-to-end
 * `takeSnapshot` is tested against the committed v1 8-entity policy suite +
 * real responses.yaml to confirm the integration path works.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import {
  buildSnapshot,
  computeAggregate,
  findSnapshotByTag,
  formatDiff,
  formatSnapshotSummary,
  isValidTag,
  listSnapshotsInDir,
  loadResponses,
  loadSuite,
  median,
  p25,
  scoreSuite,
  takeSnapshot,
  writeSnapshot,
  type PerEntityRecord,
  type SuiteEntry,
} from "./research-benchmark-suite.ts";
import type { PolicyEntity } from "../lib/research/gap-analyzer.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SUITE_YAML = path.join(ROOT, "crux/benchmarks/entity-suite.yaml");
const RESPONSES_YAML = path.join(ROOT, "data/entities/responses.yaml");

// ── fixtures ────────────────────────────────────────────────────────────────

function makeRecord(slug: string, score: number | null, expected?: number, status: PerEntityRecord["status"] = "scored"): PerEntityRecord {
  return {
    slug,
    type: "policy",
    coverage_score: score,
    components: {},
    facts_in_yaml: {},
    expected_min_coverage: expected,
    status,
  };
}

// ── isValidTag ──────────────────────────────────────────────────────────────

describe("isValidTag", () => {
  it("accepts typical labels", () => {
    expect(isValidTag("baseline")).toBe(true);
    expect(isValidTag("after-token-filter")).toBe(true);
    expect(isValidTag("pr-1234")).toBe(true);
    expect(isValidTag("v1.2.3")).toBe(true);
    expect(isValidTag("a_b.c-d")).toBe(true);
  });

  it("rejects path-traversal and shell metacharacters", () => {
    expect(isValidTag("../etc/passwd")).toBe(false);
    expect(isValidTag("foo/bar")).toBe(false);
    expect(isValidTag("foo bar")).toBe(false);
    expect(isValidTag("foo;rm")).toBe(false);
    expect(isValidTag("foo$(x)")).toBe(false);
  });

  it("rejects empty and oversized tags", () => {
    expect(isValidTag("")).toBe(false);
    expect(isValidTag("a".repeat(81))).toBe(false);
    expect(isValidTag("a".repeat(80))).toBe(true);
  });
});

// ── median ──────────────────────────────────────────────────────────────────

describe("median", () => {
  it("returns null for empty list", () => {
    expect(median([])).toBeNull();
  });
  it("handles single element", () => {
    expect(median([0.5])).toBe(0.5);
  });
  it("handles odd-length list", () => {
    expect(median([0.1, 0.5, 0.9])).toBe(0.5);
    expect(median([0.9, 0.1, 0.5])).toBe(0.5); // unsorted input
  });
  it("averages middle two for even-length list", () => {
    expect(median([0.2, 0.4, 0.6, 0.8])).toBeCloseTo(0.5, 10);
  });
});

// ── p25 ─────────────────────────────────────────────────────────────────────

describe("p25", () => {
  it("returns null for empty list", () => {
    expect(p25([])).toBeNull();
  });
  it("handles single element", () => {
    expect(p25([0.5])).toBe(0.5);
  });
  it("interpolates linearly between sorted values", () => {
    // 5 sorted values, idx = 0.25 * 4 = 1.0 → exact element index 1
    expect(p25([0.1, 0.2, 0.3, 0.4, 0.5])).toBeCloseTo(0.2, 10);
  });
  it("interpolates on non-integer index", () => {
    // 4 sorted values, idx = 0.25 * 3 = 0.75 → between values[0] and values[1]
    // linear: 0.1 + (0.2 - 0.1) * 0.75 = 0.175
    expect(p25([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.175, 10);
  });
});

// ── scoreSuite ──────────────────────────────────────────────────────────────

describe("scoreSuite", () => {
  const responses: PolicyEntity[] = [
    {
      id: "fisa-702",
      type: "policy",
      title: "FISA Section 702",
      description: "long description here",
      billNumber: "S.123",
      introduced: "2008",
      policyStatus: "enacted",
      author: "Author Name",
      jurisdiction: "United States",
      fullTextUrl: "https://example.com",
      provisions: Array.from({ length: 6 }, (_, i) => ({ title: `p${i}` })),
      stakeholders: Array.from({ length: 5 }, (_, i) => ({ name: `s${i}` })),
      tags: ["a", "b", "c"],
      relatedEntries: [{ id: "x", type: "policy" }, { id: "y", type: "policy" }, { id: "z", type: "policy" }],
    },
  ];

  it("scores supported policy entries", () => {
    const suite: SuiteEntry[] = [{ slug: "fisa-702", type: "policy", expected_min_coverage: 0.9 }];
    const records = scoreSuite(suite, responses);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("scored");
    expect(records[0].coverage_score).toBe(1);
    expect(records[0].expected_min_coverage).toBe(0.9);
  });

  it("marks unsupported types without erroring", () => {
    const suite: SuiteEntry[] = [{ slug: "openai", type: "organization" }];
    const records = scoreSuite(suite, responses);
    expect(records[0].status).toBe("unsupported_type");
    expect(records[0].coverage_score).toBeNull();
  });

  it("marks missing-entity entries", () => {
    const suite: SuiteEntry[] = [{ slug: "no-such-policy", type: "policy" }];
    const records = scoreSuite(suite, responses);
    expect(records[0].status).toBe("missing_entity");
    expect(records[0].coverage_score).toBeNull();
  });

  it("does not throw on a mixed suite", () => {
    const suite: SuiteEntry[] = [
      { slug: "fisa-702", type: "policy" },
      { slug: "openai", type: "organization" },
      { slug: "no-such-policy", type: "policy" },
    ];
    const records = scoreSuite(suite, responses);
    expect(records.map((r) => r.status)).toEqual([
      "scored",
      "unsupported_type",
      "missing_entity",
    ]);
  });
});

// ── computeAggregate ────────────────────────────────────────────────────────

describe("computeAggregate", () => {
  it("ignores unsupported and missing entries when computing percentiles", () => {
    const records: PerEntityRecord[] = [
      makeRecord("a", 0.9, 0.8),
      makeRecord("b", 0.5, 0.8),
      makeRecord("c", null, undefined, "unsupported_type"),
      makeRecord("d", null, undefined, "missing_entity"),
    ];
    const agg = computeAggregate(records);
    expect(agg.scored_count).toBe(2);
    expect(agg.unsupported_count).toBe(1);
    expect(agg.missing_count).toBe(1);
    expect(agg.median_coverage_score).toBeCloseTo(0.7, 10);
  });

  it("identifies entries below their expected minimum", () => {
    const records: PerEntityRecord[] = [
      makeRecord("ok", 0.95, 0.9),
      makeRecord("low", 0.5, 0.8),
      makeRecord("borderline", 0.8, 0.8), // not below — strict less-than
      makeRecord("no-min", 0.1, undefined),
    ];
    const agg = computeAggregate(records);
    expect(agg.count_below_min).toBe(1);
    expect(agg.below_min_slugs).toEqual(["low"]);
  });

  it("returns null medians when nothing is scored", () => {
    const records: PerEntityRecord[] = [
      makeRecord("a", null, undefined, "unsupported_type"),
    ];
    const agg = computeAggregate(records);
    expect(agg.median_coverage_score).toBeNull();
    expect(agg.p25_coverage_score).toBeNull();
    expect(agg.count_below_min).toBe(0);
    expect(agg.below_min_slugs).toEqual([]);
  });
});

// ── snapshot persistence (tmpdir) ───────────────────────────────────────────

describe("snapshot persistence", () => {
  it("round-trips a snapshot via writeSnapshot / listSnapshotsInDir / findSnapshotByTag", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const records: PerEntityRecord[] = [makeRecord("fisa-702", 1.0, 0.9)];
      const snap = buildSnapshot("baseline", records);
      const file = writeSnapshot(tmp, snap);
      expect(fs.existsSync(file)).toBe(true);

      const all = listSnapshotsInDir(tmp);
      expect(all).toHaveLength(1);
      expect(all[0].tag).toBe("baseline");

      const found = findSnapshotByTag(tmp, "baseline");
      expect(found).not.toBeNull();
      expect(found!.entities[0].slug).toBe("fisa-702");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("findSnapshotByTag returns null on missing dir", () => {
    expect(findSnapshotByTag(path.join(os.tmpdir(), "bench-suite-nonexistent-xyz"), "x")).toBeNull();
  });

  it("listSnapshotsInDir sorts by timestamp ascending", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const a = buildSnapshot("a", [makeRecord("x", 0.5)]);
      const b = buildSnapshot("b", [makeRecord("x", 0.5)]);
      // Force timestamps
      const aOld = { ...a, timestamp: "2025-01-01T00:00:00.000Z" };
      const bNew = { ...b, timestamp: "2026-01-01T00:00:00.000Z" };
      writeSnapshot(tmp, bNew);
      writeSnapshot(tmp, aOld);
      const list = listSnapshotsInDir(tmp);
      expect(list.map((s) => s.tag)).toEqual(["a", "b"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── takeSnapshot end-to-end (custom suite + tmpdir) ─────────────────────────

describe("takeSnapshot end-to-end", () => {
  it("rejects invalid tag before reading anything", () => {
    expect(() => takeSnapshot("../escape", {})).toThrow(/Invalid --tag/);
  });

  it("scores a tiny custom suite + writes a snapshot file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const suiteFile = path.join(tmp, "suite.yaml");
      fs.writeFileSync(
        suiteFile,
        yaml.dump([
          { slug: "tiny", type: "policy", expected_min_coverage: 0.5 },
        ]),
      );
      const responsesFile = path.join(tmp, "responses.yaml");
      fs.writeFileSync(
        responsesFile,
        yaml.dump([
          {
            id: "tiny",
            type: "policy",
            title: "Tiny",
            description: "abcd",
            provisions: [{ title: "p" }],
            stakeholders: [{ name: "s" }],
          },
        ]),
      );
      const { snap, file } = takeSnapshot("baseline", {
        suitePath: suiteFile,
        responsesPath: responsesFile,
        snapshotDir: tmp,
      });
      expect(snap.tag).toBe("baseline");
      expect(snap.entities).toHaveLength(1);
      expect(snap.entities[0].slug).toBe("tiny");
      expect(snap.entities[0].status).toBe("scored");
      expect(typeof snap.entities[0].coverage_score).toBe("number");
      expect(file.startsWith(tmp)).toBe(true);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── integration against the committed v1 suite ──────────────────────────────

describe("v1 entity-suite.yaml integration", () => {
  it("loads the committed suite", () => {
    const suite = loadSuite(SUITE_YAML);
    expect(suite.length).toBeGreaterThanOrEqual(8);
    for (const entry of suite) {
      expect(entry.slug).toBeTruthy();
      expect(entry.type).toBeTruthy();
    }
  });

  it("every committed slug exists in responses.yaml", () => {
    const suite = loadSuite(SUITE_YAML);
    const responses = loadResponses(RESPONSES_YAML);
    const ids = new Set(responses.map((r) => r.id));
    const missing = suite.filter((e) => e.type === "policy" && !ids.has(e.slug)).map((e) => e.slug);
    expect(missing).toEqual([]);
  });

  it("scoring + aggregation produces a sane snapshot for the v1 suite", () => {
    const suite = loadSuite(SUITE_YAML);
    const responses = loadResponses(RESPONSES_YAML);
    const records = scoreSuite(suite, responses);
    expect(records).toHaveLength(suite.length);
    const agg = computeAggregate(records);
    // v1 is policy-only, all 8 slugs exist, so expect 8 scored.
    expect(agg.scored_count).toBe(suite.length);
    expect(agg.median_coverage_score).not.toBeNull();
    expect(agg.median_coverage_score!).toBeGreaterThan(0);
    expect(agg.median_coverage_score!).toBeLessThanOrEqual(1);
  });
});

// ── formatters smoke-test ───────────────────────────────────────────────────

describe("formatters", () => {
  it("formatSnapshotSummary handles all-scored case", () => {
    const snap = buildSnapshot("baseline", [
      makeRecord("a", 0.9, 0.8),
      makeRecord("b", 1.0, 0.8),
    ]);
    const out = formatSnapshotSummary(snap);
    expect(out).toContain("baseline");
    expect(out).toContain("scored=2");
    expect(out).toContain("median=0.95");
  });

  it("formatDiff renders per-entity table + aggregate rows", () => {
    const before = buildSnapshot("a", [makeRecord("x", 0.5, 0.8)]);
    const after = buildSnapshot("b", [makeRecord("x", 0.9, 0.8)]);
    const out = formatDiff(before, after);
    expect(out).toContain("a → b");
    expect(out).toContain("x");
    expect(out).toContain("0.50");
    expect(out).toContain("0.90");
    expect(out).toContain("(+0.40)");
    expect(out).toContain("Aggregate:");
    expect(out).toContain("median");
  });

  it("formatDiff handles a slug present in only one snapshot", () => {
    const before = buildSnapshot("a", [makeRecord("x", 0.5)]);
    const after = buildSnapshot("b", [makeRecord("y", 0.5)]);
    const out = formatDiff(before, after);
    expect(out).toContain("x");
    expect(out).toContain("y");
    expect(out).toContain("(gone)");
    expect(out).toContain("(new)");
  });
});
