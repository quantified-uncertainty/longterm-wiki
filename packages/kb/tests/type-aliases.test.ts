import { describe, it, expect } from "vitest";
import { Graph, resolveKBType, KB_TYPE_ALIASES } from "../src/graph";

describe("KB type aliases", () => {
  describe("resolveKBType", () => {
    it("resolves 'model' to 'ai-model'", () => {
      expect(resolveKBType("model")).toBe("ai-model");
    });

    it("passes through types without aliases", () => {
      expect(resolveKBType("organization")).toBe("organization");
      expect(resolveKBType("person")).toBe("person");
      expect(resolveKBType("ai-model")).toBe("ai-model");
    });
  });

  describe("KB_TYPE_ALIASES", () => {
    it("contains model -> ai-model mapping", () => {
      expect(KB_TYPE_ALIASES).toHaveProperty("model", "ai-model");
    });
  });

  describe("Graph.getSchema with aliases", () => {
    it("resolves schema for aliased types", () => {
      const graph = new Graph();
      graph.addSchema({
        type: "ai-model",
        name: "AI Model",
        required: ["developed-by"],
        recommended: ["parameter-count"],
      });

      // Direct lookup works
      expect(graph.getSchema("ai-model")).toBeDefined();
      expect(graph.getSchema("ai-model")!.type).toBe("ai-model");

      // Alias lookup works: "model" resolves to "ai-model" schema
      expect(graph.getSchema("model")).toBeDefined();
      expect(graph.getSchema("model")!.type).toBe("ai-model");

      // Non-existent type still returns undefined
      expect(graph.getSchema("nonexistent")).toBeUndefined();
    });
  });

  describe("Graph.getByType with aliases", () => {
    it("getByType('ai-model') includes entities with type 'model'", () => {
      const graph = new Graph();
      graph.addEntity({
        id: "gpt-4",
        stableId: "abc1234567",
        type: "model",
        name: "GPT-4",
      });
      graph.addEntity({
        id: "anthropic",
        stableId: "def1234567",
        type: "organization",
        name: "Anthropic",
      });

      const aiModels = graph.getByType("ai-model");
      expect(aiModels).toHaveLength(1);
      expect(aiModels[0].id).toBe("gpt-4");

      // Direct type query still works
      const models = graph.getByType("model");
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("gpt-4");

      // Organization query is unaffected
      const orgs = graph.getByType("organization");
      expect(orgs).toHaveLength(1);
      expect(orgs[0].id).toBe("anthropic");
    });
  });
});
