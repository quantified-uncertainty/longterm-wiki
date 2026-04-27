/**
 * Per-source adapter tests (QUA-698).
 *
 * Each adapter is exercised against fixture wave files in
 * `__tests__/fixtures/`. Fixtures are copied into a temp directory laid
 * out as `data/scorecards/raw/<source>/<wave-slug>/grades.json`, and the
 * adapter's `createXxxAdapter(rawDir)` factory is pointed at the temp
 * dir so we never touch real data.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createFliAdapter, letterToGpa } from "../sources/fli.ts";
import {
  createSaferaiAdapter,
  parsePercent,
  percentToBand,
} from "../sources/saferai.ts";
import { createAiLabWatchAdapter } from "../sources/ailabwatch.ts";
import { createSeoulAdapter, verdictToNumeric } from "../sources/seoul.ts";

const FIXTURES = join(__dirname, "fixtures");

/**
 * Build a temp `data/scorecards/raw/<source>/...` layout populated with
 * the named fixture files. Returns the path to the source's raw dir.
 */
function setupRawDir(
  fixtureMappings: Array<{ wave: string; fixture: string }>,
): { rawDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "scorecard-test-"));
  for (const { wave, fixture } of fixtureMappings) {
    const waveDir = join(root, wave);
    mkdirSync(waveDir, { recursive: true });
    copyFileSync(join(FIXTURES, fixture), join(waveDir, "grades.json"));
  }
  return {
    rawDir: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("letterToGpa", () => {
  it("maps A+ to 4.3 and F to 0", () => {
    expect(letterToGpa("A+")).toBe(4.3);
    expect(letterToGpa("A")).toBe(4);
    expect(letterToGpa("A-")).toBeCloseTo(3.7);
    expect(letterToGpa("B+")).toBeCloseTo(3.3);
    expect(letterToGpa("C")).toBe(2);
    expect(letterToGpa("D-")).toBeCloseTo(0.7);
    expect(letterToGpa("F")).toBe(0);
  });

  it("returns null for unparseable strings", () => {
    expect(letterToGpa("Pending")).toBeNull();
    expect(letterToGpa("N/A")).toBeNull();
    expect(letterToGpa("")).toBeNull();
    expect(letterToGpa("Z")).toBeNull();
  });

  it("clamps F- to 0 (not -0.3)", () => {
    expect(letterToGpa("F-")).toBe(0);
  });
});

describe("parsePercent", () => {
  it("parses standard percent strings", () => {
    expect(parsePercent("73%")).toBe(73);
    expect(parsePercent("0%")).toBe(0);
    expect(parsePercent("100%")).toBe(100);
    expect(parsePercent("12.5%")).toBe(12.5);
    expect(parsePercent("  42%  ")).toBe(42);
  });

  it("accepts bare numbers without %", () => {
    expect(parsePercent("73")).toBe(73);
  });

  it("returns null for unparseable strings", () => {
    expect(parsePercent("N/A")).toBeNull();
    expect(parsePercent("—")).toBeNull();
    expect(parsePercent("Pending")).toBeNull();
    expect(parsePercent("")).toBeNull();
  });
});

describe("percentToBand", () => {
  it("partitions 0-100 into 4 bands at quartile boundaries", () => {
    expect(percentToBand(0)).toBe("Very Weak");
    expect(percentToBand(24)).toBe("Very Weak");
    expect(percentToBand(25)).toBe("Weak");
    expect(percentToBand(49)).toBe("Weak");
    expect(percentToBand(50)).toBe("Moderate");
    expect(percentToBand(74)).toBe("Moderate");
    expect(percentToBand(75)).toBe("Strong");
    expect(percentToBand(100)).toBe("Strong");
  });

  it("returns null for null input", () => {
    expect(percentToBand(null)).toBeNull();
  });
});

describe("verdictToNumeric", () => {
  it("maps the three Seoul verdicts to 0 / 0.5 / 1", () => {
    expect(verdictToNumeric("Fulfilled")).toBe(1);
    expect(verdictToNumeric("Partial")).toBe(0.5);
    expect(verdictToNumeric("Unfulfilled")).toBe(0);
    expect(verdictToNumeric("Partially Fulfilled")).toBe(0.5);
    expect(verdictToNumeric("Not Fulfilled")).toBe(0);
    expect(verdictToNumeric("FULFILLED")).toBe(1);
  });

  it("returns null for unrecognized verdicts", () => {
    expect(verdictToNumeric("Not Applicable")).toBeNull();
    expect(verdictToNumeric("Pending")).toBeNull();
    expect(verdictToNumeric("")).toBeNull();
  });
});

describe("FLI adapter", () => {
  let setup: ReturnType<typeof setupRawDir>;
  beforeEach(() => {
    setup = setupRawDir([
      { wave: "summer-2025", fixture: "fli-summer-2025.json" },
      { wave: "winter-2025", fixture: "fli-winter-2025.json" },
    ]);
  });
  afterEach(() => setup.cleanup());

  it("returns one snapshot per wave with deterministic IDs", () => {
    const adapter = createFliAdapter(setup.rawDir);
    const snaps = adapter.listSnapshots();
    expect(snaps).toHaveLength(2);
    const ids = snaps.map((s) => s.id);
    expect(ids).toContain("fli_index-summer-2025");
    expect(ids).toContain("fli_index-winter-2025");
  });

  it("marks the most recent wave isLatest=true (and exactly one)", () => {
    const adapter = createFliAdapter(setup.rawDir);
    const snaps = adapter.listSnapshots();
    const latest = snaps.filter((s) => s.isLatest);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe("fli_index-summer-2025");
    expect(latest[0].publishedAt).toBe("2025-07-15");
  });

  it("emits an `overall` row per org plus one row per dimension", () => {
    const adapter = createFliAdapter(setup.rawDir);
    const snap = adapter
      .listSnapshots()
      .find((s) => s.id === "fli_index-summer-2025")!;
    const grades = adapter.parseGrades(snap);
    // 3 orgs × (overall + 6 dimensions) = 21
    expect(grades).toHaveLength(21);
    const anthropicGrades = grades.filter((g) => g.orgName === "Anthropic");
    expect(anthropicGrades.map((g) => g.dimensionSlug).sort()).toEqual(
      [
        "current-harms",
        "existential-safety",
        "governance",
        "info-sharing",
        "overall",
        "risk-assessment",
        "safety-frameworks",
      ],
    );
  });

  it("populates scoreLetter / scoreRaw / scoreNumeric for letter grades", () => {
    const adapter = createFliAdapter(setup.rawDir);
    const snap = adapter
      .listSnapshots()
      .find((s) => s.id === "fli_index-summer-2025")!;
    const grades = adapter.parseGrades(snap);
    const overallA = grades.find(
      (g) => g.orgName === "Anthropic" && g.dimensionSlug === "overall",
    )!;
    expect(overallA.scoreLetter).toBe("C+");
    expect(overallA.scoreRaw).toBe("C+");
    expect(overallA.scoreNumeric).toBeCloseTo(2.3);
    expect(overallA.dimensionLabel).toBe("Overall");
    expect(overallA.dimensionWeight).toBeNull();
  });

  it("returns [] when raw dir does not exist", () => {
    const adapter = createFliAdapter("/nonexistent/path");
    expect(adapter.listSnapshots()).toEqual([]);
  });

  it("rejects waves with unknown dimensions", () => {
    const broken = setupRawDir([
      { wave: "broken", fixture: "fli-summer-2025.json" },
    ]);
    // Tamper: write a wave file that references an unknown dimension.
    const tampered = JSON.stringify({
      publishedAt: "2025-01-01",
      waveLabel: "Tampered",
      sourceUrl: "https://example.org",
      dimensions: [{ slug: "x", label: "X" }],
      grades: [
        {
          org: "Anthropic",
          scores: { overall: "B", "x": "A", "unknown-dim": "C" },
        },
      ],
    });
    rmSync(join(broken.rawDir, "broken", "grades.json"));
    require("fs").writeFileSync(
      join(broken.rawDir, "broken", "grades.json"),
      tampered,
    );
    const adapter = createFliAdapter(broken.rawDir);
    expect(() => adapter.listSnapshots()).toThrow(/unknown dimension/);
    broken.cleanup();
  });

  it("rejects waves missing the overall score for any org", () => {
    const broken = setupRawDir([
      { wave: "broken", fixture: "fli-summer-2025.json" },
    ]);
    const tampered = JSON.stringify({
      publishedAt: "2025-01-01",
      waveLabel: "Missing overall",
      sourceUrl: "https://example.org",
      dimensions: [{ slug: "a", label: "A" }],
      grades: [{ org: "Anthropic", scores: { a: "B" } }],
    });
    rmSync(join(broken.rawDir, "broken", "grades.json"));
    require("fs").writeFileSync(
      join(broken.rawDir, "broken", "grades.json"),
      tampered,
    );
    const adapter = createFliAdapter(broken.rawDir);
    expect(() => adapter.listSnapshots()).toThrow(/missing overall/);
    broken.cleanup();
  });
});

describe("SaferAI adapter", () => {
  let setup: ReturnType<typeof setupRawDir>;
  beforeEach(() => {
    setup = setupRawDir([
      { wave: "2026-04", fixture: "saferai-2026-04.json" },
    ]);
  });
  afterEach(() => setup.cleanup());

  it("derives scoreLetter band from percent", () => {
    const adapter = createSaferaiAdapter(setup.rawDir);
    const snap = adapter.listSnapshots()[0];
    const grades = adapter.parseGrades(snap);
    const overallA = grades.find(
      (g) => g.orgName === "Anthropic" && g.dimensionSlug === "overall",
    )!;
    expect(overallA.scoreNumeric).toBe(73);
    expect(overallA.scoreLetter).toBe("Moderate");
    expect(overallA.scoreRaw).toBe("73%");
  });

  it("preserves verbatim raw for unparseable cells (N/A)", () => {
    const adapter = createSaferaiAdapter(setup.rawDir);
    const snap = adapter.listSnapshots()[0];
    const grades = adapter.parseGrades(snap);
    const mistralAnalysis = grades.find(
      (g) => g.orgName === "Mistral AI" && g.dimensionSlug === "risk-analysis",
    )!;
    expect(mistralAnalysis.scoreRaw).toBe("N/A");
    expect(mistralAnalysis.scoreNumeric).toBeNull();
    expect(mistralAnalysis.scoreLetter).toBeNull();
  });

  it("propagates dimension weights into RawGrade", () => {
    const adapter = createSaferaiAdapter(setup.rawDir);
    const snap = adapter.listSnapshots()[0];
    const grades = adapter.parseGrades(snap);
    const dim = grades.find(
      (g) =>
        g.orgName === "Anthropic" && g.dimensionSlug === "risk-identification",
    )!;
    expect(dim.dimensionWeight).toBe(0.25);
    // Overall row carries a null weight.
    const overall = grades.find(
      (g) => g.orgName === "Anthropic" && g.dimensionSlug === "overall",
    )!;
    expect(overall.dimensionWeight).toBeNull();
  });
});

describe("AI Lab Watch adapter", () => {
  let setup: ReturnType<typeof setupRawDir>;
  beforeEach(() => {
    setup = setupRawDir([
      { wave: "2025-09", fixture: "ailabwatch-2025-09.json" },
    ]);
  });
  afterEach(() => setup.cleanup());

  it("forces sourceActive=false on every snapshot (frozen source)", () => {
    const adapter = createAiLabWatchAdapter(setup.rawDir);
    const snap = adapter.listSnapshots()[0];
    expect(snap.sourceActive).toBe(false);
  });

  it("attaches the freeze-notice when notes is unset on the wave", () => {
    const adapter = createAiLabWatchAdapter(setup.rawDir);
    const snap = adapter.listSnapshots()[0];
    expect(snap.notes).toMatch(/frozen/i);
    expect(snap.notes).toMatch(/September 2025/);
  });
});

describe("Seoul Tracker adapter", () => {
  let setup: ReturnType<typeof setupRawDir>;
  beforeEach(() => {
    setup = setupRawDir([
      { wave: "2025-09", fixture: "seoul-2025-09.json" },
    ]);
  });
  afterEach(() => setup.cleanup());

  it("preserves verbatim categorical verdicts in scoreRaw + scoreLetter", () => {
    const adapter = createSeoulAdapter(setup.rawDir);
    const snap = adapter.listSnapshots()[0];
    const grades = adapter.parseGrades(snap);
    const overallA = grades.find(
      (g) => g.orgName === "Anthropic" && g.dimensionSlug === "overall",
    )!;
    expect(overallA.scoreRaw).toBe("Fulfilled");
    expect(overallA.scoreLetter).toBe("Fulfilled");
    expect(overallA.scoreNumeric).toBe(1);
  });

  it("emits Partial cells with numeric 0.5", () => {
    const adapter = createSeoulAdapter(setup.rawDir);
    const snap = adapter.listSnapshots()[0];
    const grades = adapter.parseGrades(snap);
    const transA = grades.find(
      (g) => g.orgName === "Anthropic" && g.dimensionSlug === "transparency",
    )!;
    expect(transA.scoreRaw).toBe("Partial");
    expect(transA.scoreNumeric).toBe(0.5);
  });
});

describe("idempotent rerun", () => {
  it("returns identical snapshot + grade payloads across reruns (FLI)", () => {
    const setup = setupRawDir([
      { wave: "summer-2025", fixture: "fli-summer-2025.json" },
    ]);
    try {
      const adapter = createFliAdapter(setup.rawDir);
      const snap1 = adapter.listSnapshots();
      const snap2 = adapter.listSnapshots();
      expect(snap2).toEqual(snap1);
      const grades1 = adapter.parseGrades(snap1[0]);
      const grades2 = adapter.parseGrades(snap1[0]);
      expect(grades2).toEqual(grades1);
    } finally {
      setup.cleanup();
    }
  });
});
