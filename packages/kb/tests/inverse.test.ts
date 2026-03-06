import { describe, it, expect, beforeAll, vi } from "vitest";
import path from "node:path";
import { loadKB } from "../src/loader.ts";
import { computeInverses } from "../src/inverse.ts";
import type { Graph } from "../src/graph.ts";

const DATA_DIR = path.resolve(__dirname, "../data");

describe("inverse", () => {
  let graph: Graph;

  beforeAll(async () => {
    graph = await loadKB(DATA_DIR);
    // Suppress console.warn for expected warnings about missing things
    vi.spyOn(console, "warn").mockImplementation(() => {});
    computeInverses(graph);
    vi.restoreAllMocks();
  });

  describe("computeInverses", () => {
    it("creates employer-of facts on anthropic from employed-by on persons", () => {
      const employerOfFacts = graph.getFacts("anthropic", {
        property: "employer-of",
      });
      // Both dario-amodei and jan-leike have employed-by: anthropic
      expect(employerOfFacts.length).toBeGreaterThanOrEqual(2);

      const refValues = employerOfFacts.map((f) => {
        expect(f.value.type).toBe("ref");
        return (f.value as { type: "ref"; value: string }).value;
      });
      expect(refValues).toContain("dario-amodei");
      expect(refValues).toContain("jan-leike");
    });

    it("inverse facts have derivedFrom set", () => {
      const employerOfFacts = graph.getFacts("anthropic", {
        property: "employer-of",
      });
      for (const fact of employerOfFacts) {
        expect(fact.derivedFrom).toBeDefined();
        expect(typeof fact.derivedFrom).toBe("string");
      }
    });

    it("inverse fact IDs start with inv_", () => {
      const employerOfFacts = graph.getFacts("anthropic", {
        property: "employer-of",
      });
      for (const fact of employerOfFacts) {
        expect(fact.id.startsWith("inv_")).toBe(true);
      }
    });

    it("inverse facts preserve asOf temporal bound", () => {
      const employerOfFacts = graph.getFacts("anthropic", {
        property: "employer-of",
      });
      // Dario's employed-by has asOf: 2021-01, so the inverse should too
      const darioInverse = employerOfFacts.find(
        (f) =>
          f.value.type === "ref" &&
          (f.value as { type: "ref"; value: string }).value === "dario-amodei"
      );
      expect(darioInverse).toBeDefined();
      expect(darioInverse!.asOf).toBe("2021-01");
    });

    it("inverse facts preserve validEnd temporal bound", () => {
      // Jan Leike's OpenAI employment has validEnd: 2024-05
      // But openai is not in the graph, so that inverse is skipped.
      // Jan Leike's Anthropic employment has no validEnd.
      const janInverse = graph
        .getFacts("anthropic", { property: "employer-of" })
        .find(
          (f) =>
            f.value.type === "ref" &&
            (f.value as { type: "ref"; value: string }).value === "jan-leike"
        );
      expect(janInverse).toBeDefined();
      expect(janInverse!.validEnd).toBeUndefined();
    });

    it("getRelated returns person IDs via employer-of after computing inverses", () => {
      const related = graph.getRelated("anthropic", "employer-of");
      expect(related).toContain("dario-amodei");
      expect(related).toContain("jan-leike");
    });

    it("skips inverse when referenced thing does not exist in graph", () => {
      // Jan Leike has employed-by: openai, but openai is not in the graph.
      // The inverse should NOT have been created on a nonexistent "openai" thing.
      const openaiThing = graph.getThing("openai");
      expect(openaiThing).toBeUndefined();

      // Even if somehow facts were added, there should be no openai employer-of facts
      const openaiFacts = graph.getFacts("openai", {
        property: "employer-of",
      });
      expect(openaiFacts).toEqual([]);
    });

    it("logs a warning when referenced thing does not exist", async () => {
      // Load a fresh graph and capture warnings
      const freshGraph = await loadKB(DATA_DIR);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      computeInverses(freshGraph);

      // Should have warned about openai not being in the graph
      const warnings = warnSpy.mock.calls.map((call) => call[0]);
      const openaiWarning = warnings.find(
        (w) => typeof w === "string" && w.includes("openai")
      );
      expect(openaiWarning).toBeDefined();

      warnSpy.mockRestore();
    });

    it("inverse fact IDs are deterministic (content-addressed)", async () => {
      // Load two separate graphs, compute inverses on both, compare IDs
      const graph1 = await loadKB(DATA_DIR);
      const graph2 = await loadKB(DATA_DIR);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      computeInverses(graph1);
      computeInverses(graph2);
      warnSpy.mockRestore();

      const facts1 = graph1
        .getFacts("anthropic", { property: "employer-of" })
        .map((f) => f.id)
        .sort();
      const facts2 = graph2
        .getFacts("anthropic", { property: "employer-of" })
        .map((f) => f.id)
        .sort();

      expect(facts1).toEqual(facts2);
    });
  });
});
