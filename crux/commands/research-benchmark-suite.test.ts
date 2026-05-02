/**
 * Tests for `crux tb benchmark-suite` (QUA-873, extended in QUA-936).
 *
 * Pure helpers (median, p25, scoreSuite, computeAggregate, isValidTag) are
 * tested directly. Snapshot read/write is exercised against tmpdir. End-to-end
 * `takeSnapshot` is tested against the committed v1 entity suite + the real
 * `data/entities/` directory to confirm the integration path works.
 */

import { describe, it, expect, vi } from "vitest";
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
  loadAllEntities,
  loadSuite,
  median,
  p25,
  scoreSuite,
  SNAPSHOT_SCHEMA_VERSION,
  takeSnapshot,
  writeSnapshot,
  type PerEntityRecord,
  type SuiteEntry,
} from "./research-benchmark-suite.ts";
import type { EntityWithType } from "../lib/research/entity-loader.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SUITE_YAML = path.join(ROOT, "crux/benchmarks/entity-suite.yaml");
const ENTITIES_DIR = path.join(ROOT, "data/entities");

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
  const entities: EntityWithType[] = [
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
    {
      id: "anthropic",
      type: "organization",
      title: "Anthropic",
      description: "AI safety lab",
      website: "https://anthropic.com",
      orgType: "frontier-lab",
      founded: "2021",
      headquarters: "San Francisco",
      employees: "500+",
      products: [
        { name: "Claude" },
        { name: "Claude API" },
        { name: "Claude Code" },
      ],
      keyPeople: ["dario-amodei", "daniela-amodei", "jared-kaplan"],
      keyDates: [
        { date: "2021-05", description: "founded" },
        { date: "2023-03", description: "Series C" },
      ],
      tags: ["frontier-lab", "safety", "us"],
      relatedEntries: [
        { id: "openai", type: "organization", relationship: "competitor" },
        { id: "deepmind", type: "organization", relationship: "competitor" },
        { id: "anthropic-pbc", type: "organization", relationship: "parent" },
      ],
    },
  ];

  it("scores supported policy entries", () => {
    const suite: SuiteEntry[] = [{ slug: "fisa-702", type: "policy", expected_min_coverage: 0.9 }];
    const records = scoreSuite(suite, entities);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("scored");
    expect(records[0].coverage_score).toBe(1);
    expect(records[0].expected_min_coverage).toBe(0.9);
  });

  it("scores supported organization entries (QUA-936)", () => {
    const suite: SuiteEntry[] = [
      { slug: "anthropic", type: "organization", expected_min_coverage: 0.7 },
    ];
    const records = scoreSuite(suite, entities);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("scored");
    // Org scorer caps factbase at 0; full top_level + products + keyPeople + keyDates → ~0.9.
    expect(records[0].coverage_score).toBeGreaterThan(0.7);
    expect(records[0].coverage_score).toBeLessThanOrEqual(1);
    // Org-shaped components surface so diff/list work without re-lookup.
    expect(records[0].components).toHaveProperty("top_level");
    expect(records[0].components).toHaveProperty("products");
    expect(records[0].components).toHaveProperty("keyPeople");
    expect(records[0].components).toHaveProperty("keyDates");
  });

  it("marks unsupported types without erroring", () => {
    const suite: SuiteEntry[] = [{ slug: "fisa-702", type: "person" }];
    const records = scoreSuite(suite, entities);
    expect(records[0].status).toBe("unsupported_type");
    expect(records[0].coverage_score).toBeNull();
  });

  it("marks missing-entity entries", () => {
    const suite: SuiteEntry[] = [{ slug: "no-such-policy", type: "policy" }];
    const records = scoreSuite(suite, entities);
    expect(records[0].status).toBe("missing_entity");
    expect(records[0].coverage_score).toBeNull();
  });

  it("flags suite/entity type disagreement as type_mismatch (QUA-936)", () => {
    // Suite says fisa-702 is an organization, but the YAML says policy.
    // Surfacing this as `type_mismatch` instead of `missing_entity` makes
    // schema drift visible in `--list` / `--diff` rather than masking it.
    const suite: SuiteEntry[] = [{ slug: "fisa-702", type: "organization" }];
    const records = scoreSuite(suite, entities);
    expect(records[0].status).toBe("type_mismatch");
    expect(records[0].coverage_score).toBeNull();
  });

  it("does not throw on a mixed suite", () => {
    const suite: SuiteEntry[] = [
      { slug: "fisa-702", type: "policy" },
      { slug: "anthropic", type: "organization" },
      { slug: "no-such-policy", type: "policy" },
      { slug: "anything", type: "person" },
      { slug: "fisa-702", type: "organization" }, // type drift
    ];
    const records = scoreSuite(suite, entities);
    expect(records.map((r) => r.status)).toEqual([
      "scored",
      "scored",
      "missing_entity",
      "unsupported_type",
      "type_mismatch",
    ]);
  });
});

// ── computeAggregate ────────────────────────────────────────────────────────

describe("computeAggregate", () => {
  it("ignores unsupported, missing, and type-mismatched entries when computing percentiles", () => {
    const records: PerEntityRecord[] = [
      makeRecord("a", 0.9, 0.8),
      makeRecord("b", 0.5, 0.8),
      makeRecord("c", null, undefined, "unsupported_type"),
      makeRecord("d", null, undefined, "missing_entity"),
      makeRecord("e", null, undefined, "type_mismatch"),
    ];
    const agg = computeAggregate(records);
    expect(agg.scored_count).toBe(2);
    expect(agg.unsupported_count).toBe(1);
    expect(agg.missing_count).toBe(1);
    expect(agg.type_mismatch_count).toBe(1);
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

  it("filters out non-finite coverage_score values defensively", () => {
    const records: PerEntityRecord[] = [
      makeRecord("a", 0.5),
      // NaN is a valid `number` per TS but should not poison the median.
      { ...makeRecord("b", 0.0), coverage_score: NaN },
    ];
    const agg = computeAggregate(records);
    expect(agg.scored_count).toBe(1);
    expect(agg.median_coverage_score).toBe(0.5);
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

  it("findSnapshotByTag returns the latest snapshot when multiple share a tag", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const old = { ...buildSnapshot("baseline", [makeRecord("x", 0.5)]), timestamp: "2025-01-01T00:00:00.000Z" };
      const recent = { ...buildSnapshot("baseline", [makeRecord("x", 0.9)]), timestamp: "2026-01-01T00:00:00.000Z" };
      writeSnapshot(tmp, old);
      writeSnapshot(tmp, recent);
      const found = findSnapshotByTag(tmp, "baseline");
      expect(found?.timestamp).toBe("2026-01-01T00:00:00.000Z");
      expect(found?.entities[0].coverage_score).toBe(0.9);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("listSnapshotsInDir skips malformed JSON files instead of crashing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const good = buildSnapshot("good", [makeRecord("x", 0.5)]);
      writeSnapshot(tmp, good);
      fs.writeFileSync(path.join(tmp, "bad__broken.json"), "{not json");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const list = listSnapshotsInDir(tmp);
        expect(list).toHaveLength(1);
        expect(list[0].tag).toBe("good");
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writeSnapshot appends a numeric suffix on filename collision", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const ts = "2026-01-01T00:00:00.000Z";
      const a = { ...buildSnapshot("baseline", [makeRecord("x", 0.5)]), timestamp: ts };
      const b = { ...buildSnapshot("baseline", [makeRecord("x", 0.7)]), timestamp: ts };
      const fileA = writeSnapshot(tmp, a);
      const fileB = writeSnapshot(tmp, b);
      expect(fileA).not.toBe(fileB);
      expect(fs.existsSync(fileA)).toBe(true);
      expect(fs.existsSync(fileB)).toBe(true);
      expect(fileB).toMatch(/__1\.json$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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

  // QUA-890: schema_version + atomic-write protocol.
  it("buildSnapshot stamps the current SNAPSHOT_SCHEMA_VERSION", () => {
    const snap = buildSnapshot("baseline", [makeRecord("x", 0.5)]);
    expect(snap.schema_version).toBe(SNAPSHOT_SCHEMA_VERSION);
  });

  it("writeSnapshot leaves no .tmp artifacts in the snapshot dir on success", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const snap = buildSnapshot("baseline", [makeRecord("x", 0.5)]);
      writeSnapshot(tmp, snap);
      const remaining = fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp"));
      expect(remaining).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writeSnapshot leaves no .tmp artifacts when the suffix loop retries", () => {
    // Pre-existing file at the un-suffixed destination → existsSync probe
    // skips it and the loop steps to `__1.json`. The per-PID tmp must be
    // gone after rename succeeds.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const snap = buildSnapshot("baseline", [makeRecord("x", 0.5)]);
      const baseFile = path.join(tmp, snap.timestamp.replace(/[:.]/g, "-") + "__baseline.json");
      fs.writeFileSync(baseFile, "{}");
      const written = writeSnapshot(tmp, snap);
      expect(written).toMatch(/__1\.json$/);
      const tmpFiles = fs.readdirSync(tmp).filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writeSnapshot cleans up tmp + propagates on renameSync failure", () => {
    // QUA-890: the catch branch must (a) unlink the tmp file so we don't
    // leak `.tmp` artifacts into the snapshot dir, and (b) propagate the
    // original error (not a secondary failure from the cleanup itself).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const snap = buildSnapshot("baseline", [makeRecord("x", 0.5)]);
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        const err = new Error("simulated EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });
      try {
        expect(() => writeSnapshot(tmp, snap)).toThrow(/simulated EPERM/);
        // No `.tmp` artifacts left behind despite the failure.
        const remaining = fs.readdirSync(tmp);
        expect(remaining).toEqual([]);
      } finally {
        renameSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writeSnapshot writes valid JSON containing schema_version", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const snap = buildSnapshot("baseline", [makeRecord("x", 0.5)]);
      const file = writeSnapshot(tmp, snap);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(parsed.schema_version).toBe(SNAPSHOT_SCHEMA_VERSION);
      expect(parsed.tag).toBe("baseline");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("listSnapshotsInDir reads pre-QUA-890 snapshots without schema_version", () => {
    // Backwards-compat: snapshots written before QUA-890 lack schema_version.
    // listSnapshotsInDir must still parse them — `schema_version` is optional.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const legacy = {
        tag: "legacy",
        timestamp: "2026-01-01T00:00:00.000Z",
        git_sha: null,
        suite_size: 1,
        entities: [makeRecord("x", 0.5)],
        aggregate: {
          scored_count: 1,
          unsupported_count: 0,
          missing_count: 0,
          type_mismatch_count: 0,
          median_coverage_score: 0.5,
          p25_coverage_score: 0.5,
          count_below_min: 0,
          below_min_slugs: [],
        },
      };
      fs.writeFileSync(
        path.join(tmp, "2026-01-01T00-00-00-000Z__legacy.json"),
        JSON.stringify(legacy, null, 2),
      );
      const list = listSnapshotsInDir(tmp);
      expect(list).toHaveLength(1);
      expect(list[0].tag).toBe("legacy");
      expect(list[0].schema_version).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── loadAllEntities ─────────────────────────────────────────────────────────

describe("loadAllEntities", () => {
  it("loads entities from every *.yaml file in the dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "responses.yaml"),
        yaml.dump([{ id: "p1", type: "policy" }]),
      );
      fs.writeFileSync(
        path.join(tmp, "organizations.yaml"),
        yaml.dump([{ id: "o1", type: "organization" }]),
      );
      const all = loadAllEntities(tmp);
      const ids = all.map((e) => e.id).sort();
      expect(ids).toEqual(["o1", "p1"]);
      const types = new Set(all.map((e) => e.type));
      expect(types).toEqual(new Set(["policy", "organization"]));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips non-array YAML files instead of crashing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fs.writeFileSync(path.join(tmp, "bad.yaml"), yaml.dump({ id: "not-an-array" }));
      fs.writeFileSync(
        path.join(tmp, "ok.yaml"),
        yaml.dump([{ id: "p1", type: "policy" }]),
      );
      const all = loadAllEntities(tmp);
      expect(all.map((e) => e.id)).toEqual(["p1"]);
    } finally {
      warn.mockRestore();
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
      const entitiesDir = path.join(tmp, "entities");
      fs.mkdirSync(entitiesDir);
      fs.writeFileSync(
        path.join(entitiesDir, "responses.yaml"),
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
        entitiesDir,
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

  it("scores a mixed-type suite (policy + organization) end-to-end (QUA-936)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));
    try {
      const suiteFile = path.join(tmp, "suite.yaml");
      fs.writeFileSync(
        suiteFile,
        yaml.dump([
          { slug: "tiny-policy", type: "policy" },
          { slug: "tiny-org", type: "organization" },
        ]),
      );
      const entitiesDir = path.join(tmp, "entities");
      fs.mkdirSync(entitiesDir);
      fs.writeFileSync(
        path.join(entitiesDir, "responses.yaml"),
        yaml.dump([
          {
            id: "tiny-policy",
            type: "policy",
            title: "Tiny Policy",
            description: "abcd",
            provisions: [{ title: "p" }],
            stakeholders: [{ name: "s" }],
          },
        ]),
      );
      fs.writeFileSync(
        path.join(entitiesDir, "organizations.yaml"),
        yaml.dump([
          {
            id: "tiny-org",
            type: "organization",
            title: "Tiny Org",
            description: "an org",
            website: "https://example.com",
            orgType: "frontier-lab",
            founded: "2020",
            headquarters: "SF",
            products: [{ name: "Product A" }],
            keyPeople: ["alice"],
            keyDates: [{ date: "2020", description: "founded" }],
          },
        ]),
      );
      const { snap } = takeSnapshot("baseline", {
        suitePath: suiteFile,
        entitiesDir,
        snapshotDir: tmp,
      });
      expect(snap.entities).toHaveLength(2);
      const byType = Object.fromEntries(snap.entities.map((e) => [e.type, e]));
      expect(byType.policy.status).toBe("scored");
      expect(byType.organization.status).toBe("scored");
      expect(byType.organization.components).toHaveProperty("products");
      expect(snap.aggregate.scored_count).toBe(2);
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

  it("every committed slug exists in some data/entities/*.yaml file", () => {
    const suite = loadSuite(SUITE_YAML);
    const entities = loadAllEntities(ENTITIES_DIR);
    const ids = new Set(entities.map((e) => e.id));
    const missing = suite.filter((e) => !ids.has(e.slug)).map((e) => e.slug);
    expect(missing).toEqual([]);
  });

  it("scoring + aggregation produces a sane snapshot for the v1 suite", () => {
    const suite = loadSuite(SUITE_YAML);
    const entities = loadAllEntities(ENTITIES_DIR);
    const records = scoreSuite(suite, entities);
    expect(records).toHaveLength(suite.length);
    const agg = computeAggregate(records);
    // Every committed suite entry should land in `scored` (since QUA-936
    // expanded supported types to include organization). If a future suite
    // entry is added with an unsupported type, the assertion will fail loudly.
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
    // QUA-936: type_mismatch must always appear so schema drift is visible.
    expect(out).toContain("type_mismatch=0");
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

  it("formatSnapshotSummary renders em-dash for an all-unsupported suite", () => {
    const snap = buildSnapshot("baseline", [
      makeRecord("only-org", null, undefined, "unsupported_type"),
    ]);
    const out = formatSnapshotSummary(snap);
    expect(out).toContain("median=—");
    expect(out).toContain("p25=—");
    expect(out).toContain("scored=0");
    expect(out).toContain("unsupported=1");
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
