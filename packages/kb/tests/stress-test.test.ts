/**
 * Stress test: 20 real-world queries evaluated against the KB Graph API.
 *
 * Each test is annotated with a rating:
 *   CLEAN     — direct, single-call answer
 *   AWKWARD   — requires multiple calls or manual assembly
 *   IMPOSSIBLE — cannot be answered with the current API/data
 *
 * Queries 4, 8, and 18 were previously IMPOSSIBLE in the old data model.
 * They should now be answerable via items, facts, or inverse relationships.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "path";
import { loadKB } from "../src/loader";
import { computeInverses } from "../src/inverse";
import type { Graph } from "../src/graph";

const dataDir = resolve(import.meta.dirname, "../data");
let graph: Graph;

beforeAll(async () => {
  graph = await loadKB(dataDir);
  computeInverses(graph);
});

// ── Query 1: What is Anthropic's latest valuation? ──────────────────
// Rating: CLEAN
describe("Q1: Anthropic latest valuation", () => {
  it("returns the most recent valuation fact", () => {
    const fact = graph.getLatest("anthropic", "valuation");
    expect(fact).toBeDefined();
    expect(fact!.value.type).toBe("number");
    const val = (fact!.value as { type: "number"; value: number }).value;
    expect(val).toBe(380e9);
    expect(fact!.asOf).toBe("2026-02");
  });
});

// ── Query 2: Show Anthropic's revenue over time ─────────────────────
// Rating: CLEAN
describe("Q2: Anthropic revenue over time", () => {
  it("returns multiple revenue facts sorted by date", () => {
    const facts = graph.getFacts("anthropic", { property: "revenue" });
    expect(facts.length).toBeGreaterThanOrEqual(5);

    // All should be number type
    for (const f of facts) {
      expect(f.value.type).toBe("number");
    }

    // Sort by asOf to get time series
    const sorted = facts
      .filter((f) => f.asOf !== undefined)
      .sort((a, b) => a.asOf!.localeCompare(b.asOf!));
    expect(sorted.length).toBeGreaterThanOrEqual(5);

    // Revenue should generally increase over time
    const values = sorted.map(
      (f) => (f.value as { type: "number"; value: number }).value
    );
    expect(values[values.length - 1]).toBeGreaterThan(values[0]);
  });
});

// ── Query 3: Compare all AI labs' valuations (cross-entity) ─────────
// Rating: CLEAN (works with whatever entities exist)
describe("Q3: Compare all AI labs valuations", () => {
  it("returns a map of entity -> latest valuation", () => {
    const valuations = graph.getByProperty("valuation", { latest: true });
    // At minimum, Anthropic should have valuation data
    expect(valuations.size).toBeGreaterThanOrEqual(1);
    expect(valuations.has("anthropic")).toBe(true);

    const anthropicVal = valuations.get("anthropic")!;
    expect(anthropicVal.value.type).toBe("number");
    expect(
      (anthropicVal.value as { type: "number"; value: number }).value
    ).toBe(380e9);
  });
});

// ── Query 4: Who are Anthropic's board members? (was IMPOSSIBLE) ────
// Rating: AWKWARD — board members are not a separate collection, but
// key-people items include founders and leadership. This now works
// via getItems, though a dedicated "board-members" collection would
// be CLEANer.
describe("Q4: Anthropic board/key people (was IMPOSSIBLE)", () => {
  it("is now possible via key-people items", () => {
    const people = graph.getItems("anthropic", "key-people");
    expect(people.length).toBeGreaterThan(0);

    // Verify we can find the CEO
    const ceo = people.find((p) => p.fields.title === "CEO");
    expect(ceo).toBeDefined();
    expect(ceo!.fields.person).toBe("dario-amodei");

    // Verify we can find founders
    const founders = people.filter((p) => p.fields.is_founder === true);
    expect(founders.length).toBeGreaterThanOrEqual(2);

    // All entries should have person and title fields
    for (const p of people) {
      expect(p.fields.person).toBeDefined();
      expect(p.fields.title).toBeDefined();
    }
  });
});

// ── Query 5: Who works at Anthropic right now? (was awkward) ────────
// Rating: CLEAN — inverse computation generates employer-of facts
describe("Q5: Who works at Anthropic right now", () => {
  it("returns current employees via inverse employer-of facts", () => {
    // After computeInverses, Anthropic should have employer-of facts
    const employerFacts = graph.getFacts("anthropic", {
      property: "employer-of",
      current: true,
    });
    expect(employerFacts.length).toBeGreaterThanOrEqual(1);

    // Extract employee IDs
    const employeeIds = employerFacts.map((f) => {
      expect(f.value.type).toBe("ref");
      return (f.value as { type: "ref"; value: string }).value;
    });

    // Dario and Jan should both currently work at Anthropic
    expect(employeeIds).toContain("dario-amodei");
    expect(employeeIds).toContain("jan-leike");
  });

  it("can also be answered via key-people items for richer data", () => {
    // key-people gives title, start date, founder status
    const people = graph.getItems("anthropic", "key-people");
    // Filter to currently active (no end date)
    const current = people.filter((p) => p.fields.end === undefined);
    expect(current.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Query 6: Total funding raised by all AI labs (aggregation) ──────
// Rating: CLEAN (works with whatever entities have total-funding facts)
describe("Q6: Total funding raised by all AI labs", () => {
  it("aggregates total-funding across all entities", () => {
    const fundingMap = graph.getByProperty("total-funding", { latest: true });
    expect(fundingMap.size).toBeGreaterThanOrEqual(1);

    // Anthropic should have total funding data
    expect(fundingMap.has("anthropic")).toBe(true);
    const anthropicFunding = fundingMap.get("anthropic")!;
    expect(
      (anthropicFunding.value as { type: "number"; value: number }).value
    ).toBe(67e9);

    // Compute aggregate
    let totalAcrossLabs = 0;
    for (const [, fact] of fundingMap) {
      if (fact.value.type === "number") {
        totalAcrossLabs += fact.value.value;
      }
    }
    expect(totalAcrossLabs).toBeGreaterThan(0);
  });
});

// ── Query 7: List all funding rounds for Anthropic with investors
//             and valuations (event-based) ────────────────────────────
// Rating: CLEAN
describe("Q7: Anthropic funding rounds", () => {
  it("returns all funding rounds with detail fields", () => {
    const rounds = graph.getItems("anthropic", "funding-rounds");
    expect(rounds.length).toBeGreaterThanOrEqual(9);

    // Each round should have at least date and amount
    for (const r of rounds) {
      expect(r.fields.date).toBeDefined();
      expect(r.fields.amount).toBeDefined();
    }

    // Check a specific round with full data
    const seriesG = rounds.find((r) => r.key === "i_OVNz9C3XUA");
    expect(seriesG).toBeDefined();
    expect(seriesG!.fields.amount).toBe(30e9);
    expect(seriesG!.fields.valuation).toBe(380e9);
    expect(seriesG!.fields.lead_investor).toBe("gic");

    // Rounds with valuations
    const withValuation = rounds.filter(
      (r) => r.fields.valuation !== undefined
    );
    expect(withValuation.length).toBeGreaterThanOrEqual(4);
  });
});

// ── Query 8: What is OpenAI's current valuation?
//             (was IMPOSSIBLE -- data was in a different layer) ───────
// Rating: CLEAN if OpenAI data exists, otherwise shows the API works
// but data is absent. The query pattern itself is now fully supported.
describe("Q8: OpenAI current valuation (was IMPOSSIBLE)", () => {
  it("is now possible via getLatest (data-dependent)", () => {
    // The API call is clean regardless of whether OpenAI data exists
    const fact = graph.getLatest("openai", "valuation");

    const openaiThing = graph.getThing("openai");
    if (openaiThing) {
      // If OpenAI data has been added, we should get a valuation
      expect(fact).toBeDefined();
      expect(fact!.value.type).toBe("number");
    } else {
      // OpenAI thing not yet in KB -- the query pattern works, just no data
      expect(fact).toBeUndefined();
    }
  });

  it("the API pattern is identical to the Anthropic query (CLEAN)", () => {
    // Demonstrate the same pattern works for any entity
    const anthropicVal = graph.getLatest("anthropic", "valuation");
    expect(anthropicVal).toBeDefined();

    // The OpenAI call would be exactly the same shape
    const openaiVal = graph.getLatest("openai", "valuation");
    // Returns undefined or a fact -- both are valid responses
    expect(openaiVal === undefined || openaiVal.value.type === "number").toBe(
      true
    );
  });
});

// ── Query 9: Anthropic headcount over time ──────────────────────────
// Rating: CLEAN
describe("Q9: Anthropic headcount over time", () => {
  it("returns headcount facts as a time series", () => {
    const facts = graph.getFacts("anthropic", { property: "headcount" });
    expect(facts.length).toBeGreaterThanOrEqual(1);

    for (const f of facts) {
      expect(f.value.type).toBe("number");
      expect(f.asOf).toBeDefined();
    }

    // Latest headcount
    const latest = graph.getLatest("anthropic", "headcount");
    expect(latest).toBeDefined();
    expect(
      (latest!.value as { type: "number"; value: number }).value
    ).toBeGreaterThan(0);
  });
});

// ── Query 10: What is Anthropic's gross margin? ─────────────────────
// Rating: CLEAN — gross-margin property and data now exist.
describe("Q10: Anthropic gross margin", () => {
  it("returns the gross margin fact", () => {
    const fact = graph.getLatest("anthropic", "gross-margin");
    expect(fact).toBeDefined();
    expect(fact!.value.type).toBe("number");
    expect((fact!.value as { type: "number"; value: number }).value).toBe(63);
  });
});

// ── Query 11: Which entities have revenue data? (cross-entity scan) ─
// Rating: CLEAN
describe("Q11: Which entities have revenue data", () => {
  it("scans all entities for revenue facts", () => {
    const revenueMap = graph.getByProperty("revenue", { latest: true });
    // At minimum Anthropic has revenue
    expect(revenueMap.size).toBeGreaterThanOrEqual(1);
    expect(revenueMap.has("anthropic")).toBe(true);

    // List entity IDs that have revenue data
    const entitiesWithRevenue = Array.from(revenueMap.keys());
    expect(entitiesWithRevenue).toContain("anthropic");
  });
});

// ── Query 12: Compare headcount across AI labs ──────────────────────
// Rating: CLEAN (works with whatever entities have headcount data)
describe("Q12: Compare headcount across AI labs", () => {
  it("returns headcount map for comparison", () => {
    const headcountMap = graph.getByProperty("headcount", { latest: true });
    expect(headcountMap.size).toBeGreaterThanOrEqual(1);

    // Anthropic headcount
    const anthropicHc = headcountMap.get("anthropic");
    expect(anthropicHc).toBeDefined();
    expect(anthropicHc!.value.type).toBe("number");
    expect(
      (anthropicHc!.value as { type: "number"; value: number }).value
    ).toBeGreaterThan(0);
  });
});

// ── Query 13: When was Anthropic founded? ────────────────────────────
// Rating: CLEAN
describe("Q13: When was Anthropic founded", () => {
  it("returns the founded-date fact directly", () => {
    const fact = graph.getLatest("anthropic", "founded-date");
    expect(fact).toBeDefined();
    expect(fact!.value).toEqual({ type: "date", value: "2021-01" });
  });
});

// ── Query 14: Anthropic revenue-to-valuation ratio (computed metric) ─
// Rating: AWKWARD — requires two getLatest calls and manual division.
// A computed-property system could make this CLEAN.
describe("Q14: Anthropic revenue-to-valuation ratio", () => {
  it("can be computed from two getLatest calls", () => {
    const revFact = graph.getLatest("anthropic", "revenue");
    const valFact = graph.getLatest("anthropic", "valuation");

    expect(revFact).toBeDefined();
    expect(valFact).toBeDefined();

    const revenue = (revFact!.value as { type: "number"; value: number }).value;
    const valuation = (valFact!.value as { type: "number"; value: number })
      .value;

    const ratio = revenue / valuation;
    // Revenue ~$19B / Valuation ~$380B = ~0.05
    expect(ratio).toBeGreaterThan(0.01);
    expect(ratio).toBeLessThan(0.5);

    // Verify we can display the dates these came from
    expect(revFact!.asOf).toBeDefined();
    expect(valFact!.asOf).toBeDefined();
  });
});

// ── Query 15: What safety research does Anthropic do? ───────────────
// Rating: CLEAN — research-areas item collection provides structured data.
describe("Q15: Anthropic safety research", () => {
  it("is answerable via research-areas items and key-people", () => {
    // Research areas collection
    const areas = graph.getItems("anthropic", "research-areas");
    expect(areas.length).toBeGreaterThanOrEqual(3);

    // Find specific research areas
    const mechInterp = areas.find((a) => a.key === "i_X3GMmkZdIQ");
    expect(mechInterp).toBeDefined();
    expect(mechInterp!.fields.name).toBe("Mechanistic Interpretability");
    expect(mechInterp!.fields["team-size"]).toBe(50);

    // Safety-related people from key-people
    const people = graph.getItems("anthropic", "key-people");
    const safetyPeople = people.filter((p) => {
      const title = String(p.fields.title ?? "").toLowerCase();
      return (
        title.includes("alignment") ||
        title.includes("safety") ||
        title.includes("interpretability")
      );
    });
    expect(safetyPeople.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Query 16: What products has Anthropic launched? ──────────────────
// Rating: CLEAN — products item collection provides structured data.
describe("Q16: Anthropic products launched", () => {
  it("returns products from the products item collection", () => {
    const products = graph.getItems("anthropic", "products");
    expect(products.length).toBeGreaterThanOrEqual(3);

    // Check specific products
    const claudeCode = products.find((p) => p.key === "i_5ZyixnNTeg");
    expect(claudeCode).toBeDefined();
    expect(claudeCode!.fields.name).toBe("Claude Code");
    expect(claudeCode!.fields.launched).toBe("2025-02");

    // All products should have name and launch date
    for (const p of products) {
      expect(p.fields.name).toBeDefined();
      expect(p.fields.launched).toBeDefined();
    }
  });
});

// ── Query 17: Anthropic vs OpenAI market share ──────────────────────
// Rating: AWKWARD — Anthropic uses enterprise-market-share and
// coding-market-share properties while OpenAI uses the generic
// market-share property. Cross-entity comparison requires knowing
// which property each entity uses.
describe("Q17: Anthropic vs OpenAI market share", () => {
  it("compares enterprise market share for Anthropic and general market share for OpenAI", () => {
    const anthropicShare = graph.getLatest("anthropic", "enterprise-market-share");
    const openaiShare = graph.getLatest("openai", "market-share");
    expect(anthropicShare).toBeDefined();
    expect(openaiShare).toBeDefined();

    const anthVal = (anthropicShare!.value as { type: "number"; value: number }).value;
    const oaiVal = (openaiShare!.value as { type: "number"; value: number }).value;

    // Both should be reasonable percentage values
    expect(anthVal).toBeGreaterThan(0);
    expect(anthVal).toBeLessThan(100);
    expect(oaiVal).toBeGreaterThan(0);
    expect(oaiVal).toBeLessThan(100);
  });

  it("Anthropic also has coding-market-share data", () => {
    const codingShare = graph.getLatest("anthropic", "coding-market-share");
    expect(codingShare).toBeDefined();
    const val = (codingShare!.value as { type: "number"; value: number }).value;
    expect(val).toBe(42);
  });

  it("cross-entity lookup works for market-share (OpenAI only)", () => {
    const shareMap = graph.getByProperty("market-share", { latest: true });
    expect(shareMap.size).toBe(1);
    expect(shareMap.has("openai")).toBe(true);
  });

  it("cross-entity lookup works for enterprise-market-share (Anthropic only)", () => {
    const shareMap = graph.getByProperty("enterprise-market-share", { latest: true });
    expect(shareMap.size).toBe(1);
    expect(shareMap.has("anthropic")).toBe(true);
  });
});

// ── Query 18: Jan Leike's career history (was IMPOSSIBLE) ───────────
// Rating: CLEAN — employment history is modeled as temporal
// employed-by ref facts with asOf/validEnd.
describe("Q18: Jan Leike career history (was IMPOSSIBLE)", () => {
  it("is now possible via employed-by facts with temporal bounds", () => {
    const careerFacts = graph.getFacts("jan-leike", {
      property: "employed-by",
    });
    // After computeInverses, there are both original and derived facts.
    // Filter to non-derived facts for the canonical career history.
    const original = careerFacts.filter((f) => f.derivedFrom === undefined);
    expect(original).toHaveLength(2);

    // Sort by start date
    const sorted = original
      .filter((f) => f.asOf !== undefined)
      .sort((a, b) => a.asOf!.localeCompare(b.asOf!));

    // First position: OpenAI (2021-01 to 2024-05)
    const openai = sorted[0];
    expect(openai.value).toEqual({ type: "ref", value: "openai" });
    expect(openai.asOf).toBe("2021-01");
    expect(openai.validEnd).toBe("2024-05");

    // Second position: Anthropic (2024-05, ongoing)
    const anthropic = sorted[1];
    expect(anthropic.value).toEqual({ type: "ref", value: "anthropic" });
    expect(anthropic.asOf).toBe("2024-05");
    expect(anthropic.validEnd).toBeUndefined(); // Still there

    // Current employer via current filter (includes derived inverse facts)
    const current = graph.getFacts("jan-leike", {
      property: "employed-by",
      current: true,
    });
    // Extract unique employer IDs — derived inverses may duplicate entries
    const currentEmployers = [
      ...new Set(
        current
          .filter((f) => f.value.type === "ref")
          .map((f) => (f.value as { type: "ref"; value: string }).value)
      ),
    ];
    expect(currentEmployers).toContain("anthropic");

    // Role history
    const roles = graph.getFacts("jan-leike", { property: "role" });
    expect(roles.length).toBeGreaterThanOrEqual(1);
    const latestRole = graph.getLatest("jan-leike", "role");
    expect(latestRole).toBeDefined();
    expect(
      (latestRole!.value as { type: "text"; value: string }).value
    ).toContain("Alignment");
  });
});

// ── Query 19: What properties exist and which are most used? ────────
// Rating: AWKWARD — getAllProperties() lists properties, but computing
// usage counts requires iterating all things.
describe("Q19: Property inventory and usage frequency", () => {
  it("lists all defined properties", () => {
    const props = graph.getAllProperties();
    expect(props.length).toBeGreaterThanOrEqual(10);

    // Check some known properties exist
    const propIds = props.map((p) => p.id);
    expect(propIds).toContain("revenue");
    expect(propIds).toContain("valuation");
    expect(propIds).toContain("employed-by");
    expect(propIds).toContain("role");
    expect(propIds).toContain("founded-date");
    expect(propIds).toContain("headquarters");
  });

  it("can compute usage counts (AWKWARD: requires iteration)", () => {
    const allProps = graph.getAllProperties();
    const usageCounts: { id: string; name: string; count: number }[] = [];

    for (const prop of allProps) {
      const entitiesWithProp = graph.getByProperty(prop.id);
      usageCounts.push({
        id: prop.id,
        name: prop.name,
        count: entitiesWithProp.size,
      });
    }

    // Sort by usage count
    usageCounts.sort((a, b) => b.count - a.count);

    // At least some properties should be used
    const used = usageCounts.filter((u) => u.count > 0);
    expect(used.length).toBeGreaterThan(0);

    // employed-by / employer-of should be among the most used (after inverses)
    const employedBy = usageCounts.find((u) => u.id === "employed-by");
    expect(employedBy).toBeDefined();
    expect(employedBy!.count).toBeGreaterThanOrEqual(2);
  });
});

// ── Query 20: Who is the CEO of Anthropic? / What company does Dario
//              Amodei lead? (bidirectional) ───────────────────────────
// Rating: CLEAN for person->org (employed-by + role).
//         CLEAN for org->person (key-people items or inverse employer-of).
describe("Q20: Bidirectional person-org lookup", () => {
  it("person -> org: Dario Amodei leads Anthropic", () => {
    // Get Dario's employer — after computeInverses, there may be both
    // original and derived employed-by facts. Use getRelated for a clean
    // list of employer IDs.
    const employers = graph.getRelated("dario-amodei", "employed-by");
    expect(employers).toContain("anthropic");

    // Alternatively, filter to non-derived facts for the canonical record
    const originalFacts = graph
      .getFacts("dario-amodei", { property: "employed-by", current: true })
      .filter((f) => f.derivedFrom === undefined);
    expect(originalFacts).toHaveLength(1);
    expect(
      (originalFacts[0].value as { type: "ref"; value: string }).value
    ).toBe("anthropic");

    // Get Dario's role
    const role = graph.getLatest("dario-amodei", "role");
    expect(role).toBeDefined();
    expect((role!.value as { type: "text"; value: string }).value).toBe("CEO");

    // Verify the thing exists and is a person
    const dario = graph.getThing("dario-amodei");
    expect(dario).toBeDefined();
    expect(dario!.type).toBe("person");
  });

  it("org -> person: Anthropic CEO is Dario Amodei", () => {
    // Via key-people items
    const people = graph.getItems("anthropic", "key-people");
    const ceo = people.find((p) => p.fields.title === "CEO");
    expect(ceo).toBeDefined();
    expect(ceo!.fields.person).toBe("dario-amodei");

    // Verify the referenced person exists
    const person = graph.getThing(ceo!.fields.person as string);
    expect(person).toBeDefined();
    expect(person!.name).toBe("Dario Amodei");
  });

  it("org -> person: also works via inverse employer-of facts", () => {
    // computeInverses should have created employer-of facts on Anthropic
    const employees = graph.getRelated("anthropic", "employer-of");
    expect(employees).toContain("dario-amodei");
    expect(employees).toContain("jan-leike");
  });
});
