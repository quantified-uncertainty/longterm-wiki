/**
 * Unit tests for the FMTI parser + record builder (pure transforms).
 *
 * The fetch + sync orchestration is exercised in fmti-ingest.test.ts using
 * an injected mock fetch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFmtiRecords,
  domainSlug,
  FMTI_WAVES,
  fmtiRawUrl,
  parseCsv,
  parseFmtiFlatScores,
  parseFmtiIndicators,
  parseFmtiOct2023Scores,
  slugify,
  subdomainSlug,
  type FmtiIndicator,
  type FmtiScoreRow,
} from "../fmti.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, "fixtures", name), "utf-8");
}

const DEC2025_IND = loadFixture("dec2025-indicators-mini.csv");
const DEC2025_SCO = loadFixture("dec2025-scores-mini.csv");
const OCT2023 = loadFixture("oct2023-scores-mini.csv");

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------

describe("parseCsv", () => {
  it("handles a simple CSV", () => {
    const rows = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles quoted fields with embedded commas, newlines, and escaped quotes", () => {
    const rows = parseCsv('a,b\n"with, comma",ok\n"line\nbreak","escaped ""quote"""\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["with, comma", "ok"],
      ["line\nbreak", 'escaped "quote"'],
    ]);
  });

  it("strips a leading UTF-8 BOM", () => {
    const rows = parseCsv("\uFEFFa,b\n1,2\n");
    expect(rows[0]).toEqual(["a", "b"]);
  });

  it("handles a file without a trailing newline", () => {
    const rows = parseCsv("a,b\n1,2");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles \\r\\n line endings", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// slugify / domain / subdomain slugs
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("kebab-cases ASCII", () => {
    expect(slugify("Data acquisition methods")).toBe("data-acquisition-methods");
  });
  it("strips punctuation", () => {
    expect(slugify("AUP enforcement!")).toBe("aup-enforcement");
  });
  it("strips combining marks", () => {
    expect(slugify("naïve approach")).toBe("naive-approach");
  });
  it("trims surrounding hyphens", () => {
    expect(slugify("--hello---")).toBe("hello");
    expect(slugify("   ")).toBe("");
  });
});

describe("domainSlug / subdomainSlug", () => {
  it("returns lowercase domain slugs", () => {
    expect(domainSlug("Upstream")).toBe("upstream");
    expect(domainSlug("Downstream")).toBe("downstream");
  });
  it("prefixes subdomains with their domain", () => {
    expect(subdomainSlug("Upstream", "Data Acquisition")).toBe(
      "upstream--data-acquisition",
    );
    expect(subdomainSlug("Downstream", "Acceptable use policy")).toBe(
      "downstream--acceptable-use-policy",
    );
  });
});

// ---------------------------------------------------------------------------
// Indicators / flat-scores parsers
// ---------------------------------------------------------------------------

describe("parseFmtiIndicators", () => {
  it("parses Dec2025-style indicators with multiline fields", () => {
    const ind = parseFmtiIndicators(DEC2025_IND);
    expect(ind).toHaveLength(5);
    expect(ind[0]).toEqual({
      domain: "Upstream",
      subdomain: "Data Acquisition",
      name: "Data acquisition methods",
    });
    expect(ind[4]).toEqual({
      domain: "Downstream",
      subdomain: "Impact",
      name: "User impact",
    });
  });

  it("throws on malformed header", () => {
    expect(() =>
      parseFmtiIndicators("Foo,Bar,Baz\n1,2,3\n"),
    ).toThrowError(/missing expected columns/);
  });
});

describe("parseFmtiFlatScores", () => {
  it("parses orgs and binary scores", () => {
    const { orgs, rows } = parseFmtiFlatScores(DEC2025_SCO);
    expect(orgs).toEqual(["AcmeAI", "BetaLabs", "GammaCorp"]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      indicator: "Data acquisition methods",
      scores: { AcmeAI: 1, BetaLabs: 0, GammaCorp: 1 },
    });
    expect(rows[4].scores.AcmeAI).toBe(0);
  });

  it("treats blank cells as null", () => {
    const csv = "Indicator,A,B\nFoo,1,\nBar,,0\n";
    const { rows } = parseFmtiFlatScores(csv);
    expect(rows[0].scores).toEqual({ A: 1, B: null });
    expect(rows[1].scores).toEqual({ A: null, B: 0 });
  });

  it("throws when first column is not Indicator", () => {
    expect(() => parseFmtiFlatScores("Foo,A,B\n1,1,0\n")).toThrowError(
      /first column should be "Indicator"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Oct 2023 integrated parser
// ---------------------------------------------------------------------------

describe("parseFmtiOct2023Scores", () => {
  it("parses domain/subdomain/indicator + scores", () => {
    const { orgs, rows } = parseFmtiOct2023Scores(OCT2023);
    expect(orgs).toEqual(["AcmeAI", "BetaLabs", "GammaCorp"]);
    expect(rows).toHaveLength(3); // Total footer row dropped
    expect(rows[0]).toEqual({
      domain: "Upstream",
      subdomain: "Data",
      indicator: "Data size",
      scores: { AcmeAI: 1, BetaLabs: 1, GammaCorp: 0 },
    });
  });

  it("drops the trailing Total summary row", () => {
    const { rows } = parseFmtiOct2023Scores(OCT2023);
    expect(rows.find((r) => r.indicator.toLowerCase() === "total")).toBeUndefined();
  });

  it("strips BOM at start of file", () => {
    // OCT2023 fixture starts with BOM.
    const { orgs } = parseFmtiOct2023Scores(OCT2023);
    expect(orgs[0]).toBe("AcmeAI");
  });

  it("throws on unexpected header layout", () => {
    expect(() =>
      parseFmtiOct2023Scores("A,B,C\n1,2,3\n"),
    ).toThrowError(/expected first columns/);
  });
});

// ---------------------------------------------------------------------------
// buildFmtiRecords — record shape, rollups, ID determinism
// ---------------------------------------------------------------------------

describe("buildFmtiRecords", () => {
  const wave = FMTI_WAVES[2]; // Dec 2025
  const indicators: FmtiIndicator[] = parseFmtiIndicators(DEC2025_IND);
  const flat = parseFmtiFlatScores(DEC2025_SCO);

  // Stable resolver that gives every org a synthetic stableId.
  const resolveOrg = (name: string) => `sid_${slugify(name).slice(0, 6)}xx`;

  function build() {
    return buildFmtiRecords({
      wave,
      isLatest: true,
      indicators,
      scores: flat.rows,
      orgs: flat.orgs,
      resolveOrg,
    });
  }

  it("emits one snapshot row with expected metadata", () => {
    const r = build();
    expect(r.snapshot.id).toBe(wave.snapshotId);
    expect(r.snapshot.scorecardSource).toBe("fmti");
    expect(r.snapshot.publishedAt).toBe(wave.publishedAt);
    expect(r.snapshot.license).toBe("CC-BY-4.0");
    expect(r.snapshot.isLatest).toBe(true);
    expect(r.snapshot.sourceActive).toBe(true);
    expect(r.snapshot.orgCount).toBe(3);
    // 5 indicators + 4 unique subdomains + 3 domains + 1 overall = 13
    expect(r.snapshot.dimensionCount).toBe(13);
  });

  it("emits indicator + subdomain + domain + overall grades per org", () => {
    const r = build();
    // Per org: 5 indicators + 4 subdomains (Data Acquisition, Compute,
    // Capabilities, Impact) + 3 domains + 1 overall = 13.
    expect(r.grades).toHaveLength(3 * 13);

    // Group by entity for assertion.
    const byEntity = new Map<string, typeof r.grades>();
    for (const g of r.grades) {
      const list = byEntity.get(g.entityId) ?? [];
      list.push(g);
      byEntity.set(g.entityId, list);
    }
    expect(byEntity.size).toBe(3);
    for (const [, gs] of byEntity) {
      expect(gs).toHaveLength(13);
      expect(gs.filter((g) => g.dimensionSlug === "overall")).toHaveLength(1);
      expect(
        gs.filter((g) => ["upstream", "model", "downstream"].includes(g.dimensionSlug)),
      ).toHaveLength(3);
    }
  });

  it("computes overall as percent of indicators scored 1", () => {
    const r = build();
    // AcmeAI scores: 1,1,0,1,0 → 3/5 = 60.
    const overall = r.grades.find(
      (g) => g.entityDisplayName === "AcmeAI" && g.dimensionSlug === "overall",
    );
    expect(overall?.scoreNumeric).toBe(60);
    expect(overall?.scoreRaw).toBe("3/5");
  });

  it("computes subdomain rollups as percent and rounds to one decimal", () => {
    const r = build();
    // AcmeAI Upstream/Data Acquisition: indicators
    //   "Data acquisition methods" = 1, "Public datasets" = 1 → 2/2 = 100.
    const sub = r.grades.find(
      (g) =>
        g.entityDisplayName === "AcmeAI" &&
        g.dimensionSlug === "upstream--data-acquisition",
    );
    expect(sub).toBeDefined();
    expect(sub!.scoreNumeric).toBe(100);
    expect(sub!.dimensionParentSlug).toBe("upstream");
    expect(sub!.scoreRaw).toBe("2/2");
  });

  it("links indicators to their subdomain via dimensionParentSlug", () => {
    const r = build();
    const indicatorRow = r.grades.find(
      (g) =>
        g.entityDisplayName === "AcmeAI" &&
        g.dimensionSlug === "data-acquisition-methods",
    );
    expect(indicatorRow?.dimensionParentSlug).toBe("upstream--data-acquisition");
    expect(indicatorRow?.scoreNumeric).toBe(100);
    expect(indicatorRow?.scoreRaw).toBe("1");
  });

  it("emits stable, unique ids that fit the natural-key constraint", () => {
    const r = build();
    const ids = new Set(r.grades.map((g) => g.id));
    expect(ids.size).toBe(r.grades.length); // all unique
    for (const g of r.grades) {
      expect(g.id.length).toBeLessThanOrEqual(250);
      // (snapshotId, entityId, dimensionSlug) should be derivable.
      expect(g.id).toContain(g.snapshotId);
      expect(g.id).toContain(g.entityId);
      expect(g.id).toContain(g.dimensionSlug);
    }
  });

  it("skips orgs the resolver returns null for", () => {
    const r = buildFmtiRecords({
      wave,
      isLatest: true,
      indicators,
      scores: flat.rows,
      orgs: flat.orgs,
      resolveOrg: (name) => (name === "BetaLabs" ? null : `sid_${name}xx`),
    });
    expect(r.unresolvedOrgs).toEqual(["BetaLabs"]);
    expect(r.snapshot.orgCount).toBe(2);
    expect(r.grades.every((g) => g.entityDisplayName !== "BetaLabs")).toBe(
      true,
    );
    expect(r.snapshot.notes).toContain("BetaLabs");
  });

  it("includes indicators with no matching definition under the overall parent", () => {
    const orphanScores: FmtiScoreRow[] = [
      ...flat.rows,
      { indicator: "Mystery indicator", scores: { AcmeAI: 1, BetaLabs: 0, GammaCorp: 1 } },
    ];
    const r = buildFmtiRecords({
      wave,
      isLatest: true,
      indicators, // does NOT contain "Mystery indicator"
      scores: orphanScores,
      orgs: flat.orgs,
      resolveOrg,
    });
    const mystery = r.grades.find((g) => g.dimensionSlug === "mystery-indicator");
    expect(mystery).toBeDefined();
    expect(mystery!.dimensionParentSlug).toBe("overall");
  });

  it("never tags isLatest=false snapshots with isLatest=true", () => {
    const r = buildFmtiRecords({
      wave,
      isLatest: false,
      indicators,
      scores: flat.rows,
      orgs: flat.orgs,
      resolveOrg,
    });
    expect(r.snapshot.isLatest).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wave config sanity checks
// ---------------------------------------------------------------------------

describe("FMTI_WAVES configuration", () => {
  it("has a stable, non-overlapping snapshotId for each wave", () => {
    const ids = FMTI_WAVES.map((w) => w.snapshotId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses raw GitHub URLs for fetched files", () => {
    const url = fmtiRawUrl(FMTI_WAVES[0], FMTI_WAVES[0].scoresFile);
    expect(url).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/stanford-crfm\/fmti\/main\//,
    );
  });

  it("publishedAt is a valid ISO date for each wave", () => {
    for (const w of FMTI_WAVES) {
      expect(w.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
