/**
 * Tests for the !date YAML custom tag in the KB loader.
 *
 * The !date tag allows explicit date typing in YAML, eliminating ambiguity
 * for bare years (2021) that would otherwise be parsed as numbers.
 *
 * Usage in KB YAML:
 *   founded: !date 2019        → { type: "date", value: "2019" }
 *   started: !date 2023-06     → { type: "date", value: "2023-06" }
 *   born:    !date 2023-06-15  → { type: "date", value: "2023-06-15" }
 */

import { describe, it, expect, beforeAll } from "vitest";
import { parse as parseYaml } from "yaml";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DateMarker, loadKB } from "../src/loader";

// Reconstruct the dateTag as the loader defines it, for isolated YAML parsing tests.
// (CUSTOM_TAGS is not exported, but DateMarker is — we can rebuild the tag handler.)
const dateTagForTest = {
  tag: "!date",
  resolve(str: string): DateMarker {
    return new DateMarker(str);
  },
  identify(value: unknown): value is DateMarker {
    return value instanceof DateMarker;
  },
};

function parseWithDateTag(yaml: string): unknown {
  return parseYaml(yaml, { customTags: [dateTagForTest] });
}

// ── Unit tests: YAML tag parsing ──────────────────────────────────────────────

describe("!date YAML tag — unit tests", () => {
  describe("DateMarker class", () => {
    it("stores value as-is", () => {
      expect(new DateMarker("2019").value).toBe("2019");
      expect(new DateMarker("2023-06").value).toBe("2023-06");
      expect(new DateMarker("2023-06-15").value).toBe("2023-06-15");
    });
  });

  describe("YAML parsing", () => {
    it("!date bare year → DateMarker('2019')", () => {
      const result = parseWithDateTag("founded: !date 2019") as Record<string, unknown>;
      expect(result.founded).toBeInstanceOf(DateMarker);
      expect((result.founded as DateMarker).value).toBe("2019");
    });

    it("!date year-month → DateMarker('2023-06')", () => {
      const result = parseWithDateTag("started: !date 2023-06") as Record<string, unknown>;
      expect(result.started).toBeInstanceOf(DateMarker);
      expect((result.started as DateMarker).value).toBe("2023-06");
    });

    it("!date full ISO date → DateMarker('2023-06-15')", () => {
      const result = parseWithDateTag("born: !date 2023-06-15") as Record<string, unknown>;
      expect(result.born).toBeInstanceOf(DateMarker);
      expect((result.born as DateMarker).value).toBe("2023-06-15");
    });

    it("bare year without !date is parsed as number (showing why !date is needed)", () => {
      // Without !date, `2019` is a YAML integer — ambiguous with years.
      const result = parseWithDateTag("founded: 2019") as Record<string, unknown>;
      expect(typeof result.founded).toBe("number");
      expect(result.founded).toBe(2019);
    });
  });
});

// ── Integration tests: loadKB with !date-tagged facts ─────────────────────────

describe("!date YAML tag — loadKB integration", () => {
  let dataDir: string;

  beforeAll(async () => {
    // Create a minimal KB data directory with !date facts
    dataDir = await mkdtemp(join(tmpdir(), "kb-date-tag-test-"));

    // Minimal properties.yaml (founded-date with dataType date)
    await writeFile(
      join(dataDir, "properties.yaml"),
      `properties:
  founded-date:
    name: Founded Date
    dataType: date
  born-year:
    name: Birth Year
    dataType: date
  headcount:
    name: Headcount
    dataType: number
`
    );

    // schemas/ directory
    await mkdir(join(dataDir, "schemas"));
    await writeFile(
      join(dataDir, "schemas", "organization.yaml"),
      `type: organization
name: Organization
required: []
recommended: []
`
    );

    // things/ directory with !date facts
    await mkdir(join(dataDir, "things"));
    await writeFile(
      join(dataDir, "things", "test-org.yaml"),
      `thing:
  id: test-org
  stableId: testStableId1
  type: organization
  name: Test Org

facts:
  # Bare year with !date tag — would be number without tag
  - id: f_founded_bare_year
    property: founded-date
    value: !date 2019

  # Year-month with !date tag — same as heuristic would detect from string "2019-06"
  - id: f_born_year_month
    property: born-year
    value: !date 2019-06

  # Full ISO date with !date tag — same as heuristic would detect from string "2019-06-15"
  - id: f_full_iso
    property: headcount
    value: !date 2019-06-15
`
    );
  });

  it("!date 2019 → fact with type 'date' and value '2019'", async () => {
    const graph = await loadKB(dataDir);
    const facts = graph.getFacts("test-org", { property: "founded-date" });
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toEqual({ type: "date", value: "2019" });
  });

  it("!date 2019-06 → fact with type 'date' and value '2019-06' (same as DATE_RE heuristic)", async () => {
    const graph = await loadKB(dataDir);
    const facts = graph.getFacts("test-org", { property: "born-year" });
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toEqual({ type: "date", value: "2019-06" });
  });

  it("!date 2019-06-15 → fact with type 'date' and value '2019-06-15' (same as DATE_RE heuristic)", async () => {
    const graph = await loadKB(dataDir);
    const facts = graph.getFacts("test-org", { property: "headcount" });
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toEqual({ type: "date", value: "2019-06-15" });
  });

  it("!date tag takes priority over property dataType (date wins)", async () => {
    // headcount has dataType: number, but !date overrides it
    const graph = await loadKB(dataDir);
    const facts = graph.getFacts("test-org", { property: "headcount" });
    expect(facts[0].value.type).toBe("date");
  });

  it("!date in asOf field produces string, not [object Object]", async () => {
    // Regression test: DateMarker in asOf was converted via String() producing "[object Object]"
    // This verifies the fix in loader.ts parseFact()
    const realDataDir = join(__dirname, "../data");
    const graph = await loadKB(realDataDir);
    const facts = graph.getFacts("red-queen-bio", { property: "total-funding" });
    const seedFact = facts.find((f) => f.id === "f_rqb_seed");
    expect(seedFact).toBeDefined();
    expect(seedFact!.asOf).toBe("2025-11");
    expect(seedFact!.asOf).not.toBe("[object Object]");
  });
});
