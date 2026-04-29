/**
 * Tests for the Seoul Commitment Tracker scraper (QUA-752).
 *
 * Uses a hand-rolled minimal page-chunk fixture that mimics the
 * structure of the real `_next/static/chunks/app/page-<hash>.js` —
 * three minified JS literals (companies array, dimensions array,
 * and a per-(company, dimension) score table). The scraper looks for
 * three needle strings to anchor itself, so the fixture only needs the
 * relevant patterns; full Next.js bundle chrome is unnecessary.
 */

import { describe, it, expect } from "vitest";
import {
  computeOverallVerdict,
  findPageChunkUrl,
  numericToVerdict,
  scrapeSeoul,
} from "../sources/seoul-scraper.ts";

const COMPANIES = [
  { id: "amazon", name: "Amazon" },
  { id: "anthropic", name: "Anthropic" },
  { id: "cohere", name: "Cohere" },
  { id: "google", name: "Google" },
  { id: "g42", name: "G42" },
  { id: "ibm", name: "IBM" },
  { id: "inflection", name: "Inflection AI" },
  { id: "meta", name: "Meta" },
  { id: "microsoft", name: "Microsoft" },
  { id: "mistral", name: "Mistral AI" },
  { id: "naver", name: "Naver" },
  { id: "openai", name: "OpenAI" },
  { id: "samsung", name: "Samsung Electronics" },
  { id: "tii", name: "Technology Innovation Institute" },
  { id: "xai", name: "xAI" },
  { id: "zhipu", name: "Zhipu.ai" },
];

const DIMENSIONS = [
  { id: "risk-evaluations", name: "Risk Evaluation" },
  { id: "risk-thresholds", name: "Risk Thresholds" },
  { id: "risk-mitigations", name: "Risk Mitigations" },
  { id: "halting-procedures", name: "Halting Procedures" },
  { id: "safety-investment", name: "Safety Investment" },
];

/** Build the per-(company, dimension) score table, defaulting to all 1s. */
function buildScores(
  overrides: Record<string, Record<string, number>> = {},
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const c of COMPANIES) {
    out[c.id] = {};
    for (const d of DIMENSIONS) {
      out[c.id][d.id] = overrides[c.id]?.[d.id] ?? 1;
    }
  }
  return out;
}

/** Render the three data literals into a fake minified chunk. */
function buildChunk(
  companies = COMPANIES,
  dimensions = DIMENSIONS,
  scores = buildScores(),
): string {
  const ujs = `[${companies.map((c) => `{id:"${c.id}",name:"${c.name}"}`).join(",")}]`;
  const fjs = `[${dimensions.map((d) => `{id:"${d.id}",name:"${d.name}"}`).join(",")}]`;
  const yjs = `{${Object.entries(scores)
    .map(
      ([cid, s]) =>
        `${cid}:{${Object.entries(s)
          .map(([did, n]) => `"${did}":${n}`)
          .join(",")}}`,
    )
    .join(",")}}`;
  return `var x=1;let u=${ujs},f=${fjs};var y=${yjs};console.log("noise");`;
}

function buildHtml(deadline = "Feb 10, 2025"): string {
  return `<!doctype html><html><body>
    <p>Welcome</p>
    <span>Deadline: ${deadline}</span>
    <script src="/_next/static/chunks/app/page-abc123.js"></script>
  </body></html>`;
}

describe("findPageChunkUrl", () => {
  it("extracts the page-chunk path from the index HTML", () => {
    expect(findPageChunkUrl(buildHtml())).toBe("/_next/static/chunks/app/page-abc123.js");
  });

  it("returns null when no page chunk is present", () => {
    expect(findPageChunkUrl("<html><body>no script tags</body></html>")).toBeNull();
  });
});

describe("numericToVerdict", () => {
  it("maps 1 → Unfulfilled, 2 → Partial, 3 and 4 → Fulfilled", () => {
    expect(numericToVerdict(1)).toBe("Unfulfilled");
    expect(numericToVerdict(2)).toBe("Partial");
    expect(numericToVerdict(3)).toBe("Fulfilled");
    expect(numericToVerdict(4)).toBe("Fulfilled");
  });

  it("throws on unknown numeric verdicts", () => {
    expect(() => numericToVerdict(0)).toThrow(/unknown numeric verdict 0/);
    expect(() => numericToVerdict(5)).toThrow(/unknown numeric verdict 5/);
  });
});

describe("computeOverallVerdict", () => {
  it("returns Fulfilled when every dimension is at least 2", () => {
    expect(
      computeOverallVerdict({
        a: 2,
        b: 3,
        c: 4,
        d: 2,
        e: 3,
      }),
    ).toBe("Fulfilled");
  });

  it("returns Unfulfilled when every dimension is 1", () => {
    expect(computeOverallVerdict({ a: 1, b: 1, c: 1, d: 1, e: 1 })).toBe("Unfulfilled");
  });

  it("returns Partial when there is at least one 1 and at least one ≥2", () => {
    expect(computeOverallVerdict({ a: 2, b: 1, c: 2, d: 1, e: 3 })).toBe("Partial");
    expect(computeOverallVerdict({ a: 3, b: 3, c: 1, d: 2, e: 2 })).toBe("Partial");
  });

  it("throws when given an empty score map", () => {
    expect(() => computeOverallVerdict({})).toThrow(/no scores/);
  });
});

describe("scrapeSeoul", () => {
  it("extracts companies, dimensions, and per-cell verdicts", () => {
    const wave = scrapeSeoul(buildHtml(), buildChunk(), {});

    expect(wave.publishedAt).toBe("2025-02-10");
    expect(wave.waveLabel).toBe("February 2025");
    expect(wave.sourceUrl).toBe("https://www.seoul-tracker.org");
    expect(wave.dimensions).toEqual([
      { slug: "risk-evaluations", label: "Risk Evaluation" },
      { slug: "risk-thresholds", label: "Risk Thresholds" },
      { slug: "risk-mitigations", label: "Risk Mitigations" },
      { slug: "halting-procedures", label: "Halting Procedures" },
      { slug: "safety-investment", label: "Safety Investment" },
    ]);
    expect(wave.grades).toHaveLength(16);

    // Default fixture has all-1 scores, so every overall is Unfulfilled.
    for (const g of wave.grades) {
      expect(g.scores.overall).toBe("Unfulfilled");
      for (const d of DIMENSIONS) {
        expect(g.scores[d.id]).toBe("Unfulfilled");
      }
    }
  });

  it("computes the verified visual classification for the real Feb-2025 wave", () => {
    // Score rows captured verbatim from the live tracker chunk on
    // 2026-04-28. The expected overall verdicts come from the colored
    // company-list buttons in the static HTML (green/yellow/red).
    const realScores = buildScores({
      amazon: { "risk-evaluations": 2, "risk-thresholds": 2, "risk-mitigations": 2, "halting-procedures": 2, "safety-investment": 3 },
      anthropic: { "risk-evaluations": 2, "risk-thresholds": 3, "risk-mitigations": 3, "halting-procedures": 4, "safety-investment": 4 },
      cohere: { "risk-evaluations": 2, "risk-thresholds": 1, "risk-mitigations": 2, "halting-procedures": 1, "safety-investment": 3 },
      google: { "risk-evaluations": 2, "risk-thresholds": 3, "risk-mitigations": 3, "halting-procedures": 2, "safety-investment": 2 },
      g42: { "risk-evaluations": 3, "risk-thresholds": 2, "risk-mitigations": 2, "halting-procedures": 2, "safety-investment": 3 },
      ibm: { "risk-evaluations": 1, "risk-thresholds": 1, "risk-mitigations": 1, "halting-procedures": 1, "safety-investment": 1 },
      inflection: { "risk-evaluations": 1, "risk-thresholds": 1, "risk-mitigations": 1, "halting-procedures": 1, "safety-investment": 1 },
      meta: { "risk-evaluations": 2, "risk-thresholds": 2, "risk-mitigations": 1, "halting-procedures": 3, "safety-investment": 2 },
      microsoft: { "risk-evaluations": 3, "risk-thresholds": 2, "risk-mitigations": 2, "halting-procedures": 3, "safety-investment": 2 },
      mistral: { "risk-evaluations": 1, "risk-thresholds": 1, "risk-mitigations": 1, "halting-procedures": 1, "safety-investment": 1 },
      naver: { "risk-evaluations": 3, "risk-thresholds": 1, "risk-mitigations": 1, "halting-procedures": 2, "safety-investment": 2 },
      openai: { "risk-evaluations": 3, "risk-thresholds": 3, "risk-mitigations": 2, "halting-procedures": 2, "safety-investment": 2 },
      samsung: { "risk-evaluations": 1, "risk-thresholds": 1, "risk-mitigations": 1, "halting-procedures": 1, "safety-investment": 1 },
      tii: { "risk-evaluations": 1, "risk-thresholds": 1, "risk-mitigations": 1, "halting-procedures": 1, "safety-investment": 1 },
      xai: { "risk-evaluations": 3, "risk-thresholds": 3, "risk-mitigations": 1, "halting-procedures": 2, "safety-investment": 2 },
      zhipu: { "risk-evaluations": 1, "risk-thresholds": 1, "risk-mitigations": 1, "halting-procedures": 1, "safety-investment": 1 },
    });

    const wave = scrapeSeoul(buildHtml(), buildChunk(COMPANIES, DIMENSIONS, realScores), {});

    const expectedOverall: Record<string, string> = {
      Amazon: "Fulfilled",
      Anthropic: "Fulfilled",
      Cohere: "Partial",
      Google: "Fulfilled",
      G42: "Fulfilled",
      IBM: "Unfulfilled",
      "Inflection AI": "Unfulfilled",
      Meta: "Partial",
      Microsoft: "Fulfilled",
      "Mistral AI": "Unfulfilled",
      Naver: "Partial",
      OpenAI: "Fulfilled",
      "Samsung Electronics": "Unfulfilled",
      "Technology Innovation Institute": "Unfulfilled",
      xAI: "Partial",
      "Zhipu.ai": "Unfulfilled",
    };

    for (const g of wave.grades) {
      expect(g.scores.overall, `${g.org} overall`).toBe(expectedOverall[g.org]);
    }

    // Spot-check a Fulfilled-with-4 row (Anthropic) so a regression in
    // numeric→verdict for score 4 surfaces as a test failure.
    const anthropic = wave.grades.find((g) => g.org === "Anthropic")!;
    expect(anthropic.scores["halting-procedures"]).toBe("Fulfilled");
    expect(anthropic.scores["safety-investment"]).toBe("Fulfilled");

    // Distribution sanity check: the live page shows 6 Fulfilled / 4
    // Partial / 6 Unfulfilled in its header summary.
    const counts: Record<string, number> = { Fulfilled: 0, Partial: 0, Unfulfilled: 0 };
    for (const g of wave.grades) counts[g.scores.overall]++;
    expect(counts).toEqual({ Fulfilled: 6, Partial: 4, Unfulfilled: 6 });
  });

  it("respects publishedAt + waveLabel overrides", () => {
    const wave = scrapeSeoul(buildHtml(), buildChunk(), {
      publishedAt: "2026-01-15",
      waveLabel: "Custom Label",
    });
    expect(wave.publishedAt).toBe("2026-01-15");
    expect(wave.waveLabel).toBe("Custom Label");
  });

  it("infers waveLabel as '<MonthName> <YYYY>' when only publishedAt is given", () => {
    const wave = scrapeSeoul("<html></html>", buildChunk(), {
      publishedAt: "2026-07-04",
    });
    expect(wave.waveLabel).toBe("July 2026");
  });

  it("throws when publishedAt cannot be inferred and no override is provided", () => {
    expect(() =>
      scrapeSeoul(
        "<html><body>no deadline header</body></html>",
        buildChunk(),
      ),
    ).toThrow(/could not infer publishedAt/);
  });

  it("throws when the company count drifts from 16", () => {
    expect(() =>
      scrapeSeoul(buildHtml(), buildChunk(COMPANIES.slice(0, 14))),
    ).toThrow(/expected 16 companies, got 14/);
  });

  it("throws when the dimension count drifts from 5", () => {
    expect(() =>
      scrapeSeoul(buildHtml(), buildChunk(COMPANIES, DIMENSIONS.slice(0, 4))),
    ).toThrow(/expected 5 dimensions, got 4/);
  });

  it("throws when the page chunk is missing the companies array", () => {
    expect(() => scrapeSeoul(buildHtml(), "var x=1;let u=[];f=[];y={};")).toThrow(
      /could not find companies array/,
    );
  });

  it("throws when a company is missing a dimension score", () => {
    const broken = buildScores();
    delete (broken.amazon as Record<string, number>)["halting-procedures"];
    expect(() =>
      scrapeSeoul(buildHtml(), buildChunk(COMPANIES, DIMENSIONS, broken)),
    ).toThrow(/missing score for amazon\/halting-procedures/);
  });

  it("accepts abbreviated month names in the deadline header", () => {
    expect(scrapeSeoul(buildHtml("Feb 10, 2025"), buildChunk()).publishedAt).toBe(
      "2025-02-10",
    );
    expect(scrapeSeoul(buildHtml("Sept 1, 2025"), buildChunk()).publishedAt).toBe(
      "2025-09-01",
    );
    expect(scrapeSeoul(buildHtml("February 10, 2025"), buildChunk()).publishedAt).toBe(
      "2025-02-10",
    );
  });
});
