/**
 * Tests for the SaferAI HTML scraper (QUA-750).
 *
 * Uses a hand-rolled minimal HTML fixture that mimics the structure of
 * `https://ratings.safer-ai.org/comparison/` — `data-company` headers,
 * `class="title final"` / `class="title"` row labels, and
 * `<a class="val color-NN-NN">XX%</a>` cells. The scraper is regex-based
 * so the fixture only needs the relevant patterns; full WordPress chrome
 * is unnecessary.
 */

import { describe, it, expect } from "vitest";
import { scrapeSaferaiHtml } from "../sources/saferai-scraper.ts";

/**
 * Build a fake SaferAI comparison page with N companies and the four
 * top-level pillars. Each pillar row appears once at the top level and
 * is followed by one nested sub-row to verify the scraper ignores nested
 * rows.
 */
function buildFixture(opts: {
  companies: string[];
  asOf?: string;
  overall: number[];
  pillarValues: number[][]; // 4 arrays of N values
  /** When true, omit the "Overall score" row to test error paths. */
  omitOverall?: boolean;
}): string {
  const { companies, overall, pillarValues } = opts;
  const headers = companies
    .map((name) => `<a data-company="${name}">${name}</a>`)
    .join("");

  const valueRow = (vals: number[]) =>
    vals
      .map((v) => `<div class="value"><a class="val color-20-40">${v}%</a></div>`)
      .join("");

  const overallRow = opts.omitOverall
    ? ""
    : `
      <div class="level">
        <div class="title final">Overall score</div>
        ${valueRow(overall)}
      </div>`;

  const pillarLabels = [
    "Risk Identification",
    "Risk Analysis and Evaluation",
    "Risk Treatment",
    "Risk Governance",
  ];

  const pillarRows = pillarValues
    .map(
      (vals, i) => `
      <div class="level">
        <div class="title">${i + 1}. ${pillarLabels[i]}</div>
        ${valueRow(vals)}
      </div>
      <div class="level nested">
        <div class="title">${i + 1}.1 Sub-row that should be ignored</div>
        ${valueRow(vals.map((v) => v + 1))}
      </div>`,
    )
    .join("");

  const asOfText = opts.asOf
    ? `<div class="under">Up to date as of ${opts.asOf}</div>`
    : "";

  return `<!doctype html><html><head><title>Risk Management Ratings</title></head><body>
    <header>${headers}</header>
    ${overallRow}
    ${pillarRows}
    ${asOfText}
  </body></html>`;
}

describe("scrapeSaferaiHtml", () => {
  const COMPANIES = [
    "Anthropic",
    "OpenAI",
    "G42",
    "Meta",
    "DeepMind",
    "Microsoft",
    "Amazon",
    "xAI",
    "NVIDIA",
    "Magic",
    "Naver",
    "Cohere",
  ];

  it("extracts the four top-level pillars + overall, ignoring nested sub-rows", () => {
    const html = buildFixture({
      companies: COMPANIES,
      asOf: "October 2025",
      overall: [34, 33, 24, 21, 20, 18, 18, 16, 16, 11, 10, 8],
      pillarValues: [
        [26, 32, 17, 23, 22, 7, 11, 22, 14, 12, 7, 7],
        [21, 28, 18, 27, 21, 13, 16, 21, 11, 14, 7, 5],
        [41, 38, 24, 20, 27, 28, 23, 5, 14, 8, 8, 12],
        [49, 35, 38, 15, 12, 25, 21, 16, 23, 10, 18, 7],
      ],
    });

    const wave = scrapeSaferaiHtml(html);

    expect(wave.publishedAt).toBe("2025-10-01");
    expect(wave.waveLabel).toBe("October 2025");
    expect(wave.dimensions).toEqual([
      { slug: "risk-identification", label: "Risk Identification", weight: 0.25 },
      {
        slug: "risk-analysis-evaluation",
        label: "Risk Analysis and Evaluation",
        weight: 0.25,
      },
      { slug: "risk-treatment", label: "Risk Treatment", weight: 0.25 },
      { slug: "risk-governance", label: "Risk Governance", weight: 0.25 },
    ]);
    expect(wave.grades).toHaveLength(12);

    const anthropic = wave.grades.find((g) => g.org === "Anthropic")!;
    expect(anthropic.scores.overall).toBe("34%");
    expect(anthropic.scores["risk-identification"]).toBe("26%");
    expect(anthropic.scores["risk-treatment"]).toBe("41%");

    const cohere = wave.grades.find((g) => g.org === "Cohere")!;
    expect(cohere.scores.overall).toBe("8%");
    expect(cohere.scores["risk-governance"]).toBe("7%");
  });

  it("infers publishedAt + waveLabel from the page footer", () => {
    const html = buildFixture({
      companies: COMPANIES,
      asOf: "March 2026",
      overall: new Array(12).fill(10),
      pillarValues: [
        new Array(12).fill(10),
        new Array(12).fill(10),
        new Array(12).fill(10),
        new Array(12).fill(10),
      ],
    });

    const wave = scrapeSaferaiHtml(html);
    expect(wave.publishedAt).toBe("2026-03-01");
    expect(wave.waveLabel).toBe("March 2026");
  });

  it("respects publishedAt + waveLabel overrides", () => {
    const html = buildFixture({
      companies: COMPANIES,
      asOf: "October 2025",
      overall: new Array(12).fill(0),
      pillarValues: [
        new Array(12).fill(0),
        new Array(12).fill(0),
        new Array(12).fill(0),
        new Array(12).fill(0),
      ],
    });

    const wave = scrapeSaferaiHtml(html, {
      publishedAt: "2025-10-15",
      waveLabel: "Mid-October 2025",
    });
    expect(wave.publishedAt).toBe("2025-10-15");
    expect(wave.waveLabel).toBe("Mid-October 2025");
  });

  it("throws when fewer than 12 companies are present", () => {
    const html = buildFixture({
      companies: COMPANIES.slice(0, 8),
      asOf: "October 2025",
      overall: new Array(8).fill(10),
      pillarValues: [
        new Array(8).fill(10),
        new Array(8).fill(10),
        new Array(8).fill(10),
        new Array(8).fill(10),
      ],
    });
    expect(() => scrapeSaferaiHtml(html)).toThrow(/expected 12 companies/);
  });

  it("throws when the Overall score row is missing", () => {
    const html = buildFixture({
      companies: COMPANIES,
      asOf: "October 2025",
      overall: new Array(12).fill(0),
      pillarValues: [
        new Array(12).fill(10),
        new Array(12).fill(10),
        new Array(12).fill(10),
        new Array(12).fill(10),
      ],
      omitOverall: true,
    });
    expect(() => scrapeSaferaiHtml(html)).toThrow(/Overall score/);
  });

  it("throws when publishedAt cannot be inferred and no override is provided", () => {
    const html = buildFixture({
      companies: COMPANIES,
      // No asOf — page lacks "Up to date as of …" text.
      overall: new Array(12).fill(10),
      pillarValues: [
        new Array(12).fill(10),
        new Array(12).fill(10),
        new Array(12).fill(10),
        new Array(12).fill(10),
      ],
    });
    expect(() => scrapeSaferaiHtml(html)).toThrow(/could not infer publishedAt/);
  });

  it("preserves the canonical column order from data-company headers", () => {
    const reordered = ["Cohere", ...COMPANIES.slice(0, 11)];
    const html = buildFixture({
      companies: reordered,
      asOf: "October 2025",
      overall: [99, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      pillarValues: [
        new Array(12).fill(10),
        new Array(12).fill(10),
        new Array(12).fill(10),
        new Array(12).fill(10),
      ],
    });
    const wave = scrapeSaferaiHtml(html);
    expect(wave.grades[0].org).toBe("Cohere");
    expect(wave.grades[0].scores.overall).toBe("99%");
  });
});
