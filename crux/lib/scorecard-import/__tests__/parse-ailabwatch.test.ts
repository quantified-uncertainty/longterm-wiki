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
  buildAILabWatchGradesFile,
  AILW_DIMENSIONS,
  AILW_ORGS,
} from "../parse-ailabwatch.ts";
import { FAIR_USE_CITATION_LICENSE } from "../types.ts";

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

  it("throws on empty / completely empty HTML rather than silently returning empty data", () => {
    expect(() => parseAILabWatchHtml("")).toThrowError(/missing 49 cells/);
    expect(() => parseAILabWatchHtml("<html></html>")).toThrowError(/missing 49 cells/);
  });

  it("throws with a clear error when an aria-label has a non-integer percent", () => {
    // Build a complete fixture and replace one aria-label with a decimal.
    // Without the loose-regex check, this would silently leave the cell
    // missing and the strict-validator would say "missing 1 cells".
    const html = buildFixtureHtml().replace(
      'aria-label="Risk assessment score for Anthropic: 50%"',
      'aria-label="Risk assessment score for Anthropic: 13.5%"',
    );
    expect(() => parseAILabWatchHtml(html)).toThrowError(
      /aria-label\(s\) had non-integer percent: Risk assessment score for Anthropic: 13\.5%/,
    );
  });

  it("rejects percent values outside 0-100 (HTML tamper / format change)", () => {
    const html = buildFixtureHtml().replace(
      'aria-label="Risk assessment score for Anthropic: 50%"',
      'aria-label="Risk assessment score for Anthropic: 999%"',
    );
    expect(() => parseAILabWatchHtml(html)).toThrowError(
      /out-of-range percent \(999\)/,
    );
  });

  it("strips query strings and fragments from /companies/ hrefs", () => {
    const html = buildFixtureHtml({
      overrideOverall: [{ org: "anthropic", pct: 28 }],
    }).replace(
      'href="/companies/anthropic"',
      'href="/companies/anthropic?ref=card"',
    );
    const out = parseAILabWatchHtml(html);
    expect(out.overall.anthropic).toBe(28);
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

describe("buildAILabWatchGradesFile", () => {
  function freshParsed() {
    const perDimension: Record<string, Record<string, number>> = {};
    for (const o of AILW_ORGS) {
      perDimension[o.slug] = {};
      for (const d of AILW_DIMENSIONS) perDimension[o.slug][d.slug] = 50;
    }
    const overall: Record<string, number> = {};
    for (const o of AILW_ORGS) overall[o.slug] = 25;
    return { perDimension, overall };
  }

  const opts = {
    publishedAt: "2025-09-01",
    waveLabel: "September 2025 (frozen)",
    sourceUrl: "https://ailabwatch.org/",
    methodologyUrl: "https://ailabwatch.org/about",
    notes: "frozen test",
  };

  it("emits one row per org with overall + 7 dimensions", () => {
    const out = buildAILabWatchGradesFile(freshParsed(), opts);
    expect(out.grades).toHaveLength(7);
    for (const row of out.grades) {
      expect(Object.keys(row.scores).sort()).toEqual(
        ["overall", ...AILW_DIMENSIONS.map((d) => d.slug)].sort(),
      );
    }
  });

  it("formats every score as a percent string verbatim (not a number)", () => {
    const parsed = freshParsed();
    parsed.overall.anthropic = 28;
    parsed.perDimension.anthropic["risk-assessment"] = 44;
    const out = buildAILabWatchGradesFile(parsed, opts);
    const a = out.grades.find((g) => g.org === "Anthropic")!;
    expect(a.scores.overall).toBe("28%");
    expect(a.scores["risk-assessment"]).toBe("44%");
    expect(typeof a.scores.overall).toBe("string");
  });

  it("preserves the exact display name from AILW_ORGS (not the slug)", () => {
    const out = buildAILabWatchGradesFile(freshParsed(), opts);
    const orgNames = out.grades.map((g) => g.org).sort();
    expect(orgNames).toEqual(
      ["Anthropic", "DeepMind", "DeepSeek", "Meta", "Microsoft", "OpenAI", "xAI"].sort(),
    );
  });

  it("hardcodes weight=null because the live site doesn't publish weights", () => {
    const out = buildAILabWatchGradesFile(freshParsed(), opts);
    for (const dim of out.dimensions) {
      expect(dim.weight).toBeNull();
    }
  });

  it("hardcodes license=fair-use-citation and isLatest=true (single-wave frozen source)", () => {
    // QUA-867 item B: ailabwatch.org publishes no explicit Creative Commons
    // or other license. We label our display "fair-use-citation" so the
    // /scorecards/ailabwatch snapshot table renders an actual reuse term
    // instead of an em-dash.
    const out = buildAILabWatchGradesFile(freshParsed(), opts);
    expect(out.license).toBe(FAIR_USE_CITATION_LICENSE);
    expect(out.isLatest).toBe(true);
  });

  it("throws when overall is missing for an org", () => {
    const parsed = freshParsed();
    delete (parsed.overall as Record<string, number>).anthropic;
    expect(() => buildAILabWatchGradesFile(parsed, opts)).toThrowError(
      /no overall score for "anthropic"/,
    );
  });

  it("throws when a dimension score is missing for an org", () => {
    const parsed = freshParsed();
    delete (parsed.perDimension.openai as Record<string, number>).security;
    expect(() => buildAILabWatchGradesFile(parsed, opts)).toThrowError(
      /no "security" score for org "openai"/,
    );
  });
});
