import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

// We need to mock fs before importing the module
vi.mock("fs");
vi.mock("js-yaml", () => ({
  default: { load: vi.fn(() => []) },
}));

// Create a minimal mock database
const mockDatabase = {
  entities: [
    {
      id: "test-entity",
      type: "risk",
      title: "Test Entity",
      description: "A test entity",
      severity: "high",
      tags: ["ai", "safety"],
      relatedEntries: [{ id: "other-entity", type: "concept" }],
    },
    {
      id: "other-entity",
      type: "concept",
      title: "Other Entity",
      description: "Another entity",
    },
    {
      id: "researcher-1",
      type: "researcher",
      title: "Dr. Test",
    },
  ],
  // Pre-transformed entities (produced by build-data.mjs → entity-transform.mjs)
  typedEntities: [
    {
      id: "test-entity",
      entityType: "risk",
      title: "Test Entity",
      description: "A test entity",
      severity: "high",
      tags: ["ai", "safety"],
      clusters: [],
      relatedEntries: [{ id: "other-entity", type: "concept" }],
      sources: [],
      customFields: [],
      relatedTopics: [],
      riskCategory: "accident",
    },
    {
      id: "other-entity",
      entityType: "concept",
      title: "Other Entity",
      description: "Another entity",
      tags: [],
      clusters: [],
      relatedEntries: [],
      sources: [],
      customFields: [],
      relatedTopics: [],
    },
    {
      id: "researcher-1",
      entityType: "person",
      title: "Dr. Test",
      role: "Researcher",
      affiliation: "Test Org",
      knownFor: [],
      tags: [],
      clusters: [],
      relatedEntries: [],
      sources: [],
      customFields: [],
      relatedTopics: [],
    },
    {
      id: "table-entity",
      entityType: "approach",
      title: "Table With Entity",
      description: "A table page that also has an entity definition",
      tags: [],
      clusters: [],
      relatedEntries: [],
      sources: [],
      customFields: [],
      relatedTopics: [],
    },
    {
      id: "internal-doc",
      entityType: "internal",
      title: "Architecture Docs",
      description: "Internal documentation page",
      tags: [],
      clusters: [],
      relatedEntries: [],
      sources: [],
      customFields: [],
      relatedTopics: [],
    },
  ],
  resources: [
    {
      id: "resource-1",
      url: "https://example.com",
      title: "Test Resource",
      type: "paper",
      credibility_override: 4,
    },
    {
      id: "resource-2",
      url: "https://example.com/2",
      title: "Published Resource",
      type: "paper",
      publication_id: "pub-1",
    },
    {
      id: "resource-3",
      url: "https://example.com/3",
      title: "No Credibility",
      type: "blog",
    },
  ],
  publications: [
    {
      id: "pub-1",
      name: "Nature",
      type: "journal",
      credibility: 5,
      peer_reviewed: true,
      domains: ["science"],
    },
  ],
  experts: [
    {
      id: "researcher-1",
      name: "Dr. Test",
      affiliation: "org-1",
      role: "Researcher",
    },
  ],
  organizations: [
    {
      id: "org-1",
      name: "Test Org",
      type: "safety-org",
      founded: "2020",
    },
  ],
  backlinks: {
    "test-entity": [
      { id: "other-entity", type: "concept", title: "Other Entity" },
    ],
  },
  pathRegistry: {
    "test-entity": "/knowledge-base/risks/test-entity",
    "other-entity": "/knowledge-base/concepts/other-entity",
    "table-entity": "/knowledge-base/responses/table-entity",
    "orphan-table": "/knowledge-base/risks/orphan-table",
    "internal-doc": "/internal/architecture",
  },
  idRegistry: {
    byNumericId: { E1: "test-entity", E2: "other-entity", E3: "researcher-1", E4: "table-entity", E5: "orphan-table", E6: "internal-doc" },
    bySlug: { "test-entity": "E1", "other-entity": "E2", "researcher-1": "E3", "table-entity": "E4", "orphan-table": "E5", "internal-doc": "E6" },
  },
  pages: [
    {
      id: "test-entity",
      path: "/knowledge-base/risks/test-entity",
      filePath: "risks/test-entity.mdx",
      title: "Test Entity",
      quality: 7,
      importance: 85,
      tractability: null,
      neglectedness: null,
      uncertainty: null,
      causalLevel: null,
      lastUpdated: "2025-01-15",
      llmSummary: "A summary of the test entity.",
      description: null,
      ratings: { novelty: 3, rigor: 4 },
      category: "risks",
      wordCount: 2500,
    },
    {
      id: "table-entity",
      path: "/knowledge-base/responses/table-entity",
      filePath: "responses/table-entity.mdx",
      title: "Table With Entity",
      quality: 20,
      importance: 30,
      contentFormat: "table",
      lastUpdated: "2025-02-01",
      category: "responses",
      wordCount: 0,
    },
    {
      id: "orphan-table",
      path: "/knowledge-base/risks/orphan-table",
      filePath: "risks/orphan-table.mdx",
      title: "Orphan Table",
      quality: 20,
      importance: 30,
      contentFormat: "table",
      lastUpdated: "2025-02-01",
      category: "risks",
      wordCount: 0,
    },
    {
      id: "internal-doc",
      path: "/internal/architecture",
      filePath: "internal/architecture.mdx",
      title: "Architecture Docs",
      quality: 0,
      importance: 0,
      lastUpdated: "2025-02-01",
      category: "internal",
      wordCount: 500,
      updateFrequency: 90,
    },
  ],
  facts: {
    "test-entity.severity-level": {
      value: "high",
      entity: "test-entity",
      factId: "severity-level",
    },
    "test-entity.impact-estimate": {
      value: "$1 billion",
      numeric: 1000000000,
      entity: "test-entity",
      factId: "impact-estimate",
    },
  },
  stats: {},
};

// Mock fs.readFileSync to return our mock database
vi.mocked(fs.readFileSync).mockImplementation((filepath: any) => {
  if (String(filepath).endsWith("database.json")) {
    return JSON.stringify(mockDatabase);
  }
  throw new Error(`Unexpected file read: ${filepath}`);
});

// Now import the module (after mocks are set up)
// We need to use dynamic import and reset modules between tests
describe("Data Layer", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("getEntityById", () => {
    it("returns entity by ID", async () => {
      const { getEntityById } = await import("../../data/index");
      const entity = getEntityById("test-entity");
      expect(entity).toBeDefined();
      expect(entity?.title).toBe("Test Entity");
      expect(entity?.type).toBe("risk");
    });

    it("returns undefined for missing entity", async () => {
      const { getEntityById } = await import("../../data/index");
      expect(getEntityById("nonexistent")).toBeUndefined();
    });
  });

  describe("getResourceCredibility", () => {
    it("returns credibility_override when present", async () => {
      const { getResourceById, getResourceCredibility } = await import("../../data/index");
      const resource = getResourceById("resource-1")!;
      expect(getResourceCredibility(resource)).toBe(4);
    });

    it("falls back to publication credibility", async () => {
      const { getResourceById, getResourceCredibility } = await import("../../data/index");
      const resource = getResourceById("resource-2")!;
      expect(getResourceCredibility(resource)).toBe(5);
    });

    it("returns undefined when no credibility source", async () => {
      const { getResourceById, getResourceCredibility } = await import("../../data/index");
      const resource = getResourceById("resource-3")!;
      expect(getResourceCredibility(resource)).toBeUndefined();
    });

    it("uses override even when publication exists", async () => {
      const { getResourceCredibility } = await import("../../data/index");
      const resource = {
        id: "x",
        url: "",
        title: "",
        type: "paper",
        credibility_override: 2,
        publication_id: "pub-1",
      };
      expect(getResourceCredibility(resource)).toBe(2);
    });

    it("handles credibility_override of 0 correctly", async () => {
      const { getResourceCredibility } = await import("../../data/index");
      const resource = {
        id: "x",
        url: "",
        title: "",
        type: "paper",
        credibility_override: 0,
        publication_id: "pub-1",
      };
      // Should return 0, not fall through to publication
      expect(getResourceCredibility(resource)).toBe(0);
    });
  });

  describe("getEntityHref", () => {
    it("returns /wiki/E{n} for known entities", async () => {
      const { getEntityHref } = await import("../../data/index");
      expect(getEntityHref("test-entity")).toBe("/wiki/E1");
    });

    it("falls back to slug when no numeric ID", async () => {
      const { getEntityHref } = await import("../../data/index");
      expect(getEntityHref("unknown-slug")).toBe("/wiki/unknown-slug");
    });
  });

  describe("getFact / getFactValue", () => {
    it("returns fact by composite key", async () => {
      const { getFact } = await import("../../data/index");
      const fact = getFact("test-entity", "severity-level");
      expect(fact).toBeDefined();
      expect(fact?.value).toBe("high");
    });

    it("returns undefined for missing fact", async () => {
      const { getFact } = await import("../../data/index");
      expect(getFact("test-entity", "nonexistent")).toBeUndefined();
    });

    it("getFactValue returns just the value string", async () => {
      const { getFactValue } = await import("../../data/index");
      expect(getFactValue("test-entity", "impact-estimate")).toBe("$1 billion");
    });
  });

  describe("getFactsForEntity", () => {
    it("returns all facts keyed by factId", async () => {
      const { getFactsForEntity } = await import("../../data/index");
      const facts = getFactsForEntity("test-entity");
      expect(Object.keys(facts)).toHaveLength(2);
      expect(facts["severity-level"]).toBeDefined();
      expect(facts["impact-estimate"]).toBeDefined();
    });

    it("returns empty object for entity with no facts", async () => {
      const { getFactsForEntity } = await import("../../data/index");
      const facts = getFactsForEntity("nonexistent");
      expect(Object.keys(facts)).toHaveLength(0);
    });
  });

  describe("getBacklinksFor", () => {
    it("returns backlinks with hrefs", async () => {
      const { getBacklinksFor } = await import("../../data/index");
      const links = getBacklinksFor("test-entity");
      expect(links).toHaveLength(1);
      expect(links[0].title).toBe("Other Entity");
      expect(links[0].href).toBe("/wiki/E2");
    });

    it("returns empty array for entity with no backlinks", async () => {
      const { getBacklinksFor } = await import("../../data/index");
      expect(getBacklinksFor("nonexistent")).toEqual([]);
    });
  });

  describe("getExploreItems", () => {
    it("returns items for entities with pages", async () => {
      const { getExploreItems } = await import("../../data/index");
      const items = getExploreItems();
      // Only entities/pages with content appear; mock has 1 entity with a page
      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it("merges page data into entity items", async () => {
      const { getExploreItems } = await import("../../data/index");
      const items = getExploreItems();
      const testItem = items.find((i) => i.id === "test-entity");
      expect(testItem).toBeDefined();
      expect(testItem?.quality).toBe(7);
      expect(testItem?.importance).toBe(85);
      expect(testItem?.description).toBe("A summary of the test entity.");
      expect(testItem?.wordCount).toBe(2500);
      expect(testItem?.lastUpdated).toBe("2025-01-15");
    });

    it("assigns risk category for risk entities", async () => {
      const { getExploreItems } = await import("../../data/index");
      const items = getExploreItems();
      const testItem = items.find((i) => i.id === "test-entity");
      // test-entity is type "risk" but not in any named category → defaults to "accident"
      expect(testItem?.riskCategory).toBe("accident");
    });

    it("excludes entities without content pages from explore items", async () => {
      const { getExploreItems } = await import("../../data/index");
      const items = getExploreItems();
      const conceptItem = items.find((i) => i.id === "other-entity");
      // other-entity has no page in the mock → should not appear in explore
      expect(conceptItem).toBeUndefined();
    });

    it("uses contentFormat as type when page is a table (even with entity)", async () => {
      const { getExploreItems } = await import("../../data/index");
      const items = getExploreItems();
      // table-entity has entityType "approach" but contentFormat "table" → type must be "table"
      const tableWithEntity = items.find((i) => i.id === "table-entity");
      expect(tableWithEntity).toBeDefined();
      expect(tableWithEntity?.type).toBe("table");
      expect(tableWithEntity?.contentFormat).toBe("table");
    });

    it("uses contentFormat as type for table pages without entities", async () => {
      const { getExploreItems } = await import("../../data/index");
      const items = getExploreItems();
      // orphan-table has no entity, contentFormat "table" → type must be "table"
      const orphanTable = items.find((i) => i.id === "orphan-table");
      expect(orphanTable).toBeDefined();
      expect(orphanTable?.type).toBe("table");
    });

    it("all table-format pages appear under type 'table'", async () => {
      const { getExploreItems } = await import("../../data/index");
      const items = getExploreItems();
      const tableItems = items.filter((i) => i.type === "table");
      // Both table pages (with and without entity) must show as type "table"
      expect(tableItems).toHaveLength(2);
    });

    it("excludes internal pages from explore items", async () => {
      const { getExploreItems } = await import("../../data/index");
      const items = getExploreItems();
      // internal-doc has entityType "internal" — must NOT appear in explore
      const internalItem = items.find((i) => i.id === "internal-doc");
      expect(internalItem).toBeUndefined();
      // No items should have type "internal"
      const internalItems = items.filter((i) => i.type === "internal");
      expect(internalItems).toHaveLength(0);
    });
  });

  describe("getUpdateSchedule", () => {
    it("excludes internal pages from update schedule", async () => {
      const { getUpdateSchedule } = await import("../../data/index");
      const items = getUpdateSchedule();
      const internalItem = items.find((i) => i.id === "internal-doc");
      expect(internalItem).toBeUndefined();
    });
  });

  describe("getEntityInfoBoxData", () => {
    it("returns null for missing entity", async () => {
      const { getEntityInfoBoxData } = await import("../../data/index");
      expect(getEntityInfoBoxData("nonexistent")).toBeNull();
    });

    it("returns basic data for risk entity", async () => {
      const { getEntityInfoBoxData } = await import("../../data/index");
      const data = getEntityInfoBoxData("test-entity");
      expect(data).toBeDefined();
      expect(data?.type).toBe("risk");
      expect(data?.severity).toBe("high");
      expect(data?.category).toBe("accident");
    });

    it("resolves related entries with titles and hrefs", async () => {
      const { getEntityInfoBoxData } = await import("../../data/index");
      const data = getEntityInfoBoxData("test-entity");
      expect(data?.relatedEntries).toHaveLength(1);
      expect(data?.relatedEntries?.[0].title).toBe("Other Entity");
      expect(data?.relatedEntries?.[0].href).toBe("/wiki/E2");
    });

    it("merges expert data for researcher type (now person)", async () => {
      const { getEntityInfoBoxData } = await import("../../data/index");
      const data = getEntityInfoBoxData("researcher-1");
      expect(data?.type).toBe("person");
      expect(data?.title).toBe("Dr. Test");
      expect(data?.affiliation).toBe("Test Org");
      expect(data?.role).toBe("Researcher");
    });
  });
});
