import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  FLI_WAVES,
  findWave,
  validateWaveFile,
  extractWaveFromCache,
} from "../fli.ts";
import type { FliWaveFile } from "../fli.ts";
import type { CallClaudeResult } from "../../../anthropic.ts";

describe("FLI_WAVES", () => {
  it("declares 3 waves with unique slugs in chronological order", () => {
    const slugs = FLI_WAVES.map((w) => w.waveSlug);
    expect(slugs.length).toBeGreaterThanOrEqual(3);
    expect(new Set(slugs).size).toBe(slugs.length);
    const dates = FLI_WAVES.map((w) => w.publishedAt);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  it("each wave has the required config fields", () => {
    for (const w of FLI_WAVES) {
      expect(w.waveSlug).toMatch(/^[a-z0-9-]+$/);
      expect(w.waveLabel).toBeTruthy();
      expect(w.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(w.sourceUrl).toMatch(/^https:\/\//);
      expect(["page.html", "report.pdf"]).toContain(w.cacheFile);
    }
  });
});

describe("findWave", () => {
  it("returns the wave config for a known slug", () => {
    const w = findWave("summer-2025");
    expect(w.waveLabel).toBe("Summer 2025");
  });

  it("throws with the known slug list when given an unknown slug", () => {
    expect(() => findWave("never-released-1985")).toThrow(/Known waves/);
  });
});

describe("validateWaveFile", () => {
  const valid: FliWaveFile = {
    publishedAt: "2025-07-17",
    waveLabel: "Summer 2025",
    sourceUrl: "https://futureoflife.org/ai-safety-index-summer-2025/",
    methodologyUrl: null,
    license: null,
    notes: null,
    dimensions: [
      { slug: "risk-assessment", label: "Risk Assessment" },
      { slug: "current-harms", label: "Current Harms" },
    ],
    grades: [
      {
        org: "Anthropic",
        scores: { overall: "C+", "risk-assessment": "C+", "current-harms": "B-" },
      },
    ],
  };

  it("accepts a valid wave file", () => {
    expect(() => validateWaveFile(valid, "fli/summer-2025")).not.toThrow();
  });

  it("rejects bad publishedAt format", () => {
    expect(() =>
      validateWaveFile({ ...valid, publishedAt: "July 2025" }, "ctx"),
    ).toThrow(/publishedAt/);
  });

  it("rejects empty dimensions[]", () => {
    expect(() => validateWaveFile({ ...valid, dimensions: [] }, "ctx")).toThrow(
      /dimensions/,
    );
  });

  it("rejects empty grades[]", () => {
    expect(() => validateWaveFile({ ...valid, grades: [] }, "ctx")).toThrow(
      /grades/,
    );
  });

  it("rejects an org with a score for an unknown dimension", () => {
    const bad: FliWaveFile = {
      ...valid,
      grades: [
        {
          org: "Anthropic",
          scores: {
            overall: "C+",
            "risk-assessment": "C",
            "made-up": "F", // not in dimensions
          },
        },
      ],
    };
    expect(() => validateWaveFile(bad, "ctx")).toThrow(/unknown dimension/);
  });

  it("rejects an org missing the overall score", () => {
    const bad = {
      ...valid,
      grades: [
        { org: "Anthropic", scores: { "risk-assessment": "C" } },
      ],
    } as unknown as FliWaveFile;
    expect(() => validateWaveFile(bad, "ctx")).toThrow(/overall/);
  });

  it("rejects a non-kebab-case dimension slug", () => {
    const bad: FliWaveFile = {
      ...valid,
      dimensions: [{ slug: "RiskAssessment", label: "Risk Assessment" }],
      grades: [{ org: "Anthropic", scores: { overall: "C+", RiskAssessment: "C" } }],
    };
    expect(() => validateWaveFile(bad, "ctx")).toThrow(/kebab-case/);
  });

  it("rejects non-object input", () => {
    expect(() => validateWaveFile(null, "ctx")).toThrow(/non-object/);
  });
});

describe("extractWaveFromCache", () => {
  let dir: string;
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(waveSlug: string = "winter-2025") {
    dir = mkdtempSync(join(tmpdir(), "fli-extract-"));
    mkdirSync(join(dir, waveSlug), { recursive: true });
    const wave = findWave(waveSlug);
    const cachePath = join(dir, waveSlug, wave.cacheFile);
    // Stub bytes are fine — the LLM call is mocked, the file just needs to exist.
    writeFileSync(
      cachePath,
      wave.cacheFile === "page.html"
        ? `<html><body><div class="row"><span>Anthropic</span><span class="grade">C+</span></div></body></html>`
        : Buffer.from("%PDF-1.7\n% stub\n", "utf8"),
    );
    return { dir, wave: waveSlug };
  }

  it("runs the LLM, validates, and writes grades.json", async () => {
    // Use the latest wave so isLatest=true round-trips.
    const latest = FLI_WAVES[FLI_WAVES.length - 1];
    const { dir, wave } = setup(latest.waveSlug);
    const fake: CallClaudeResult = {
      text: JSON.stringify({
        publishedAt: latest.publishedAt,
        waveLabel: latest.waveLabel,
        sourceUrl: latest.sourceUrl,
        methodologyUrl: null,
        license: null,
        notes: null,
        dimensions: [{ slug: "risk-assessment", label: "Risk Assessment" }],
        grades: [
          { org: "Anthropic", scores: { overall: "C+", "risk-assessment": "C+" } },
        ],
      }),
      usage: { input_tokens: 100, output_tokens: 50 },
      model: "claude-sonnet",
    };
    let called = 0;
    const r = await extractWaveFromCache(wave, dir, async () => {
      called++;
      return fake;
    });
    expect(called).toBe(1);
    expect(r.outputPath).toBe(join(dir, wave, "grades.json"));
    expect(r.orgs).toBe(1);
    expect(r.dimensions).toBe(1);
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 50 });

    // Persisted file is parseable + still passes validation.
    const written = JSON.parse(readFileSync(r.outputPath, "utf8")) as FliWaveFile;
    expect(written.grades[0].org).toBe("Anthropic");
    expect(written.isLatest).toBe(true); // matches FLI_WAVES[last]
    validateWaveFile(written, "round-trip");
  });

  it("marks isLatest=false for non-latest waves", async () => {
    const { dir, wave } = setup("2024-12"); // oldest, not latest
    const fake: CallClaudeResult = {
      text: JSON.stringify({
        publishedAt: "2024-12-11",
        waveLabel: "December 2024",
        sourceUrl: "x",
        dimensions: [{ slug: "a", label: "A" }],
        grades: [{ org: "X", scores: { overall: "C" } }],
      }),
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "x",
    };
    const r = await extractWaveFromCache(wave, dir, async () => fake);
    const written = JSON.parse(readFileSync(r.outputPath, "utf8")) as FliWaveFile;
    expect(written.isLatest).toBe(false);
  });

  it("throws if the cached source file is missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "fli-extract-"));
    await expect(
      extractWaveFromCache("summer-2025", dir, async () => {
        throw new Error("should not be called");
      }),
    ).rejects.toThrow(/Cached source missing/);
  });

  it("propagates validator errors when the LLM returns malformed JSON", async () => {
    const { dir, wave } = setup();
    const fake: CallClaudeResult = {
      text: JSON.stringify({
        publishedAt: "Summer 2025", // bad
        waveLabel: "Summer 2025",
        sourceUrl: "x",
        dimensions: [{ slug: "a", label: "A" }],
        grades: [{ org: "X", scores: { overall: "A" } }],
      }),
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-sonnet",
    };
    await expect(
      extractWaveFromCache(wave, dir, async () => fake),
    ).rejects.toThrow(/publishedAt/);
  });

  it("strips the cached HTML before sending to the LLM", async () => {
    const { dir, wave } = setup();
    let captured = "";
    const fake: CallClaudeResult = {
      text: JSON.stringify({
        publishedAt: "2025-07-17",
        waveLabel: "Summer 2025",
        sourceUrl: "x",
        dimensions: [{ slug: "a", label: "A" }],
        grades: [{ org: "X", scores: { overall: "A" } }],
      }),
      usage: { input_tokens: 1, output_tokens: 1 },
      model: "claude-sonnet",
    };
    // Inject heavy HTML into the cache; check the LLM never sees the script tag.
    writeFileSync(
      join(dir, wave, "page.html"),
      `<html><head><title>x</title></head><body><script>alert(1)</script><p>Anthropic</p></body></html>`,
    );
    await extractWaveFromCache(wave, dir, async (_sys, user) => {
      captured = user;
      return fake;
    });
    expect(captured).not.toMatch(/alert\(1\)/);
    expect(captured).not.toMatch(/<script/);
    expect(captured).toMatch(/Anthropic/);
  });
});
