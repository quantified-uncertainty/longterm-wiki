/**
 * AI Lab Watch parser tests (QUA-751).
 *
 * Adversarial tests for `parseAILabWatchHtml`. The parser is intentionally
 * strict — every (org × dimension) cell must be present, every org must
 * have an overall score. These tests pin that contract.
 */

import { describe, it, expect } from "vitest";
import {
  parseAILabWatchHtml,
  AILW_DIMENSIONS,
  AILW_ORGS,
} from "../parse-ailabwatch.ts";

/**
 * Build a minimal fixture HTML covering all 7 orgs × 7 dimensions plus
 * the "Overall score" rollup. Mirrors the real site's structure: every
 * cell anchor has `aria-label="<dim> score for <Org>: NN%"`, and the
 * rollup is a list of `<a href="/companies/<slug>">…<div class="…
 * text-white">NN<div>%</div></div></a>` entries.
 */
function buildFixtureHtml(opts: {
  /** Drop a specific (orgSlug,dimSlug) cell to test the strict-fail path. */
  dropCells?: Array<{ org: string; dim: string }>;
  /** Drop a specific org from the overall rollup. */
  dropOverall?: string[];
  /** Override one cell's percent value (for round-trip checks). */
  overrideCells?: Array<{ org: string; dim: string; pct: number }>;
  /** Override one org's overall percent. */
  overrideOverall?: Array<{ org: string; pct: number }>;
} = {}): string {
  const dropSet = new Set(
    (opts.dropCells ?? []).map((c) => `${c.org}|${c.dim}`),
  );
  const dropOverallSet = new Set(opts.dropOverall ?? []);
  const overrideMap = new Map(
    (opts.overrideCells ?? []).map((c) => [`${c.org}|${c.dim}`, c.pct]),
  );
  const overrideOverallMap = new Map(
    (opts.overrideOverall ?? []).map((c) => [c.org, c.pct]),
  );

  const cellHtml: string[] = [];
  for (const o of AILW_ORGS) {
    for (const d of AILW_DIMENSIONS) {
      const key = `${o.slug}|${d.slug}`;
      if (dropSet.has(key)) continue;
      const pct = overrideMap.get(key) ?? 50;
      cellHtml.push(
        `<a aria-label="${d.ariaPrefix} score for ${o.display}: ${pct}%" href="/cell/${o.slug}/${d.slug}">cell</a>`,
      );
    }
  }

  const overallHtml: string[] = [];
  overallHtml.push('<div><span>Overall score</span></div>');
  for (const o of AILW_ORGS) {
    if (dropOverallSet.has(o.slug)) continue;
    const pct = overrideOverallMap.get(o.slug) ?? 25;
    overallHtml.push(
      `<a class="overall-row" href="/companies/${o.slug}">` +
        `<div class="row-inner"><div class="logo"><img alt="${o.display}"/></div>` +
        `<div class="name">${o.display}</div></div>` +
        `<div class="pill"><div class="text-white">${pct}<div>%</div></div></div>` +
        `</a>`,
    );
  }

  // Matrix-header anchors that should NOT be picked up by the overall
  // parser (they have no .text-white score child).
  const headerHtml: string[] = [];
  for (const o of AILW_ORGS) {
    headerHtml.push(
      `<a class="matrix-header" href="/companies/${o.slug}"><img alt="${o.display}"/></a>`,
    );
  }

  return `<!doctype html><html><body>
    <h1>AI Companies Scorecard</h1>
    <section class="rollup">${overallHtml.join("")}</section>
    <section class="matrix">${headerHtml.join("")}<div class="cells">${cellHtml.join("")}</div></section>
  </body></html>`;
}

describe("parseAILabWatchHtml", () => {
  it("parses all 49 per-cell scores and 7 overall scores from a complete page", () => {
    const html = buildFixtureHtml({
      overrideCells: [
        { org: "anthropic", dim: "risk-assessment", pct: 44 },
        { org: "xai", dim: "planning", pct: 0 },
      ],
      overrideOverall: [
        { org: "anthropic", pct: 28 },
        { org: "deepseek", pct: 1 },
      ],
    });
    const out = parseAILabWatchHtml(html);

    // Every org × dimension cell present.
    for (const o of AILW_ORGS) {
      expect(Object.keys(out.perDimension[o.slug])).toHaveLength(
        AILW_DIMENSIONS.length,
      );
    }
    expect(out.perDimension.anthropic["risk-assessment"]).toBe(44);
    expect(out.perDimension.xai.planning).toBe(0);
    expect(out.perDimension.meta.misuse).toBe(50); // default

    // Every org has an overall.
    for (const o of AILW_ORGS) {
      expect(typeof out.overall[o.slug]).toBe("number");
    }
    expect(out.overall.anthropic).toBe(28);
    expect(out.overall.deepseek).toBe(1);
    expect(out.overall.meta).toBe(25); // default
  });

  it("throws when any org × dimension cell is missing", () => {
    const html = buildFixtureHtml({
      dropCells: [{ org: "anthropic", dim: "risk-assessment" }],
    });
    expect(() => parseAILabWatchHtml(html)).toThrowError(
      /missing 1 cells: anthropic\/risk-assessment/,
    );
  });

  it("throws when multiple cells are missing and reports the count", () => {
    const html = buildFixtureHtml({
      dropCells: [
        { org: "openai", dim: "scheming" },
        { org: "openai", dim: "misuse" },
        { org: "meta", dim: "planning" },
      ],
    });
    expect(() => parseAILabWatchHtml(html)).toThrowError(/missing 3 cells:/);
  });

  it("throws when an org's overall score is missing from the rollup", () => {
    const html = buildFixtureHtml({ dropOverall: ["microsoft"] });
    expect(() => parseAILabWatchHtml(html)).toThrowError(
      /missing overall scores for microsoft/,
    );
  });

  it("ignores aria-labels that don't match the score pattern", () => {
    const html = buildFixtureHtml().replace(
      "</body>",
      `<a aria-label="Switch to dark mode">x</a>` +
        `<a aria-label="Toggle menu">x</a>` +
        `<a aria-label="Some other score for Foo: 99%">x</a>` +
        `</body>`,
    );
    const out = parseAILabWatchHtml(html);
    // Adding noise didn't add or change scores.
    expect(out.perDimension.anthropic["risk-assessment"]).toBe(50);
  });

  it("does not mistake matrix-header anchors for overall-score rows", () => {
    // Matrix headers: <a href="/companies/X"><img /></a> with no .text-white child.
    // If the parser walked them, every org's overall would be 0 / wrong / undefined.
    const html = buildFixtureHtml({
      overrideOverall: [{ org: "anthropic", pct: 28 }],
    });
    const out = parseAILabWatchHtml(html);
    expect(out.overall.anthropic).toBe(28);
  });

  it("parses live-site percent format (e.g., '44%') unambiguously", () => {
    // Real site uses NN%, also NN<div>%</div>. Our fixture mirrors the
    // latter — verify we got the digits, not the percent sign.
    const html = buildFixtureHtml({
      overrideCells: [{ org: "anthropic", dim: "scheming", pct: 4 }],
    });
    const out = parseAILabWatchHtml(html);
    expect(out.perDimension.anthropic.scheming).toBe(4);
    expect(typeof out.perDimension.anthropic.scheming).toBe("number");
  });

  it("is case-insensitive on dimension and org name in aria-labels", () => {
    // The site's labels use Sentence-case prefixes ("Risk assessment"),
    // but if someone fixes a typo with different casing, we should still
    // resolve.
    const baseHtml = buildFixtureHtml();
    const tweaked = baseHtml.replace(
      'aria-label="Risk assessment score for Anthropic: 50%"',
      'aria-label="risk ASSESSMENT score FOR anthropic: 50%"',
    );
    const out = parseAILabWatchHtml(tweaked);
    expect(out.perDimension.anthropic["risk-assessment"]).toBe(50);
  });
});
