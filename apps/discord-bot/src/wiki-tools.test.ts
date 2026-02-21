import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the wiki-api module
vi.mock("./wiki-api.js", () => ({
  searchWiki: vi.fn(),
  getPage: vi.fn(),
  getRelatedPages: vi.fn(),
  getEntity: vi.fn(),
  searchEntities: vi.fn(),
  getFacts: vi.fn(),
  getPageCitations: vi.fn(),
  searchResources: vi.fn(),
  getBacklinks: vi.fn(),
  getWikiStats: vi.fn(),
  getRecentChanges: vi.fn(),
  getAutoUpdateStatus: vi.fn(),
  getCitationHealth: vi.fn(),
  getRiskReport: vi.fn(),
}));

// Mock the SDK to avoid loading the real MCP server infrastructure
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: any) => Promise<any>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: any) => ({
    name: options.name,
    tools: options.tools,
  }),
}));

const {
  searchWiki,
  getPage,
  getRelatedPages,
  getEntity,
  searchEntities,
  getFacts,
  getPageCitations,
  searchResources,
  getBacklinks,
  getWikiStats,
  getRecentChanges,
  getAutoUpdateStatus,
  getCitationHealth,
  getRiskReport,
} = await import("./wiki-api.js");
const wikiToolsModule = await import("./wiki-tools.js");
// Our mock returns { name, tools } but the real SDK type is McpSdkServerConfigWithInstance
const wikiMcpServer = wikiToolsModule.wikiMcpServer as any;

// Helper to find a tool by name
const tool = (name: string) => {
  const t = wikiMcpServer.tools.find((t: any) => t.name === name);
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
};
const handler = (name: string) => (args: any) => tool(name).handler(args);

describe("wiki MCP tools", () => {
  beforeEach(() => {
    vi.mocked(searchWiki).mockReset();
    vi.mocked(getPage).mockReset();
    vi.mocked(getRelatedPages).mockReset();
    vi.mocked(getEntity).mockReset();
    vi.mocked(searchEntities).mockReset();
    vi.mocked(getFacts).mockReset();
    vi.mocked(getPageCitations).mockReset();
    vi.mocked(searchResources).mockReset();
    vi.mocked(getBacklinks).mockReset();
    vi.mocked(getWikiStats).mockReset();
    vi.mocked(getRecentChanges).mockReset();
    vi.mocked(getAutoUpdateStatus).mockReset();
    vi.mocked(getCitationHealth).mockReset();
    vi.mocked(getRiskReport).mockReset();
  });

  it("exports an MCP server with 14 tools", () => {
    expect(wikiMcpServer.name).toBe("wiki-server");
    expect(wikiMcpServer.tools).toHaveLength(14);
  });

  it("registers the expected tool names", () => {
    const names = wikiMcpServer.tools.map((t: any) => t.name);
    expect(names).toContain("search_wiki");
    expect(names).toContain("get_page");
    expect(names).toContain("get_related_pages");
    expect(names).toContain("get_entity");
    expect(names).toContain("search_entities");
    expect(names).toContain("get_facts");
    expect(names).toContain("get_page_citations");
    expect(names).toContain("search_resources");
    expect(names).toContain("get_backlinks");
    expect(names).toContain("wiki_stats");
    expect(names).toContain("recent_changes");
    expect(names).toContain("auto_update_status");
    expect(names).toContain("citation_health");
    expect(names).toContain("risk_report");
  });

  describe("search_wiki tool", () => {
    it("calls searchWiki and returns JSON results", async () => {
      const mockResults = [{ id: "scheming", title: "Scheming", score: 1.5 }];
      vi.mocked(searchWiki).mockResolvedValue(mockResults as any);

      const result = await handler("search_wiki")({ query: "scheming" });

      expect(searchWiki).toHaveBeenCalledWith("scheming", undefined);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(JSON.parse(result.content[0].text)).toEqual(mockResults);
    });

    it("passes limit parameter", async () => {
      vi.mocked(searchWiki).mockResolvedValue([]);

      await handler("search_wiki")({ query: "test", limit: 5 });

      expect(searchWiki).toHaveBeenCalledWith("test", 5);
    });

    it("returns empty array JSON when no results", async () => {
      vi.mocked(searchWiki).mockResolvedValue([]);

      const result = await handler("search_wiki")({ query: "nonexistent" });

      expect(JSON.parse(result.content[0].text)).toEqual([]);
    });
  });

  describe("get_page tool", () => {
    it("returns formatted page content", async () => {
      vi.mocked(getPage).mockResolvedValue({
        id: "scheming",
        title: "Scheming",
        description: "AI deception risk",
        contentPlaintext: "Full page content here.",
      } as any);

      const result = await handler("get_page")({ id: "scheming" });

      expect(getPage).toHaveBeenCalledWith("scheming");
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("# Scheming");
      expect(result.content[0].text).toContain("AI deception risk");
      expect(result.content[0].text).toContain("Full page content here.");
    });

    it("returns 'Page not found' for missing pages", async () => {
      vi.mocked(getPage).mockResolvedValue(null);

      const result = await handler("get_page")({ id: "nonexistent" });

      expect(result.content[0].text).toBe("Page not found");
    });

    it("handles null description and content gracefully", async () => {
      vi.mocked(getPage).mockResolvedValue({
        id: "stub",
        title: "Stub Page",
        description: null,
        contentPlaintext: null,
      } as any);

      const result = await handler("get_page")({ id: "stub" });

      expect(result.content[0].text).toContain("# Stub Page");
      expect(result.content[0].text).toContain("(no content)");
      expect(result.content[0].text).not.toContain("null");
    });
  });

  describe("get_related_pages tool", () => {
    it("calls getRelatedPages and returns JSON", async () => {
      const mockData = {
        entityId: "scheming",
        related: [{ id: "deceptive-alignment", type: "concept", title: "Deceptive Alignment", score: 0.9 }],
        total: 1,
      };
      vi.mocked(getRelatedPages).mockResolvedValue(mockData as any);

      const result = await handler("get_related_pages")({ id: "scheming" });

      expect(getRelatedPages).toHaveBeenCalledWith("scheming", undefined);
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it("passes limit parameter", async () => {
      vi.mocked(getRelatedPages).mockResolvedValue({ entityId: "x", related: [], total: 0 });

      await handler("get_related_pages")({ id: "scheming", limit: 5 });

      expect(getRelatedPages).toHaveBeenCalledWith("scheming", 5);
    });

    it("returns not-found message when null", async () => {
      vi.mocked(getRelatedPages).mockResolvedValue(null);

      const result = await handler("get_related_pages")({ id: "nonexistent" });

      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("get_entity tool", () => {
    it("calls getEntity and returns JSON", async () => {
      const mockEntity = { id: "anthropic", entityType: "organization", title: "Anthropic" };
      vi.mocked(getEntity).mockResolvedValue(mockEntity as any);

      const result = await handler("get_entity")({ id: "anthropic" });

      expect(getEntity).toHaveBeenCalledWith("anthropic");
      expect(JSON.parse(result.content[0].text)).toEqual(mockEntity);
    });

    it("returns not-found message when null", async () => {
      vi.mocked(getEntity).mockResolvedValue(null);

      const result = await handler("get_entity")({ id: "nonexistent" });

      expect(result.content[0].text).toBe("Entity not found");
    });
  });

  describe("search_entities tool", () => {
    it("calls searchEntities and returns JSON", async () => {
      const mockData = { results: [{ id: "miri", entityType: "organization", title: "MIRI" }], query: "miri", total: 1 };
      vi.mocked(searchEntities).mockResolvedValue(mockData as any);

      const result = await handler("search_entities")({ query: "miri" });

      expect(searchEntities).toHaveBeenCalledWith("miri", undefined);
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it("passes limit parameter", async () => {
      vi.mocked(searchEntities).mockResolvedValue({ results: [], query: "test", total: 0 });

      await handler("search_entities")({ query: "labs", limit: 5 });

      expect(searchEntities).toHaveBeenCalledWith("labs", 5);
    });

    it("returns failure message when null", async () => {
      vi.mocked(searchEntities).mockResolvedValue(null);

      const result = await handler("search_entities")({ query: "test" });

      expect(result.content[0].text).toContain("failed");
    });
  });

  describe("get_facts tool", () => {
    it("calls getFacts and returns JSON", async () => {
      const mockData = {
        entityId: "anthropic",
        facts: [{ id: 1, entityId: "anthropic", factId: "employees", label: "Employees", value: "~1000", numeric: 1000 }],
        total: 1,
        limit: 100,
        offset: 0,
      };
      vi.mocked(getFacts).mockResolvedValue(mockData as any);

      const result = await handler("get_facts")({ entity_id: "anthropic" });

      expect(getFacts).toHaveBeenCalledWith("anthropic");
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it("returns not-found message when null", async () => {
      vi.mocked(getFacts).mockResolvedValue(null);

      const result = await handler("get_facts")({ entity_id: "nonexistent" });

      expect(result.content[0].text).toContain("No facts found");
    });
  });

  describe("get_page_citations tool", () => {
    it("calls getPageCitations and returns JSON", async () => {
      const mockData = {
        quotes: [{ id: 1, pageId: "scheming", footnote: 1, claimText: "AI can deceive", url: "https://example.com" }],
      };
      vi.mocked(getPageCitations).mockResolvedValue(mockData as any);

      const result = await handler("get_page_citations")({ page_id: "scheming" });

      expect(getPageCitations).toHaveBeenCalledWith("scheming");
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it("returns not-found message when null", async () => {
      vi.mocked(getPageCitations).mockResolvedValue(null);

      const result = await handler("get_page_citations")({ page_id: "nonexistent" });

      expect(result.content[0].text).toContain("No citations found");
    });
  });

  describe("search_resources tool", () => {
    it("calls searchResources and returns JSON", async () => {
      const mockData = {
        results: [{ id: "r1", url: "https://example.com", title: "Interp Paper" }],
        count: 1,
        query: "interpretability",
      };
      vi.mocked(searchResources).mockResolvedValue(mockData as any);

      const result = await handler("search_resources")({ query: "interpretability" });

      expect(searchResources).toHaveBeenCalledWith("interpretability", undefined);
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it("passes limit parameter", async () => {
      vi.mocked(searchResources).mockResolvedValue({ results: [], count: 0, query: "test" });

      await handler("search_resources")({ query: "test", limit: 3 });

      expect(searchResources).toHaveBeenCalledWith("test", 3);
    });

    it("returns failure message when null", async () => {
      vi.mocked(searchResources).mockResolvedValue(null);

      const result = await handler("search_resources")({ query: "test" });

      expect(result.content[0].text).toContain("failed");
    });
  });

  describe("get_backlinks tool", () => {
    it("calls getBacklinks and returns JSON", async () => {
      const mockData = {
        targetId: "rlhf",
        backlinks: [{ id: "alignment", type: "concept", title: "Alignment", linkType: "entity_link", weight: 1.0 }],
        total: 1,
      };
      vi.mocked(getBacklinks).mockResolvedValue(mockData as any);

      const result = await handler("get_backlinks")({ id: "rlhf" });

      expect(getBacklinks).toHaveBeenCalledWith("rlhf", undefined);
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it("passes limit parameter", async () => {
      vi.mocked(getBacklinks).mockResolvedValue({ targetId: "x", backlinks: [], total: 0 });

      await handler("get_backlinks")({ id: "rlhf", limit: 10 });

      expect(getBacklinks).toHaveBeenCalledWith("rlhf", 10);
    });

    it("returns not-found message when null", async () => {
      vi.mocked(getBacklinks).mockResolvedValue(null);

      const result = await handler("get_backlinks")({ id: "nonexistent" });

      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("wiki_stats tool", () => {
    it("calls getWikiStats and returns JSON", async () => {
      const mockStats = {
        health: { status: "healthy", totalPages: 625, totalEntities: 200, totalFacts: 1500 },
        citations: { totalQuotes: 3000, verified: 1200 },
      };
      vi.mocked(getWikiStats).mockResolvedValue(mockStats as any);

      const result = await handler("wiki_stats")({});

      expect(getWikiStats).toHaveBeenCalledOnce();
      expect(JSON.parse(result.content[0].text)).toEqual(mockStats);
    });

    it("returns failure message when null", async () => {
      vi.mocked(getWikiStats).mockResolvedValue(null);

      const result = await handler("wiki_stats")({});

      expect(result.content[0].text).toContain("Could not retrieve wiki stats");
    });
  });

  describe("recent_changes tool", () => {
    it("calls getRecentChanges and returns JSON", async () => {
      const mockData = {
        sessions: [{ id: 1, date: "2026-02-21", title: "Update scheming", pages: ["scheming"] }],
      };
      vi.mocked(getRecentChanges).mockResolvedValue(mockData as any);

      const result = await handler("recent_changes")({});

      expect(getRecentChanges).toHaveBeenCalledWith(undefined, undefined);
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it("passes limit and since parameters", async () => {
      vi.mocked(getRecentChanges).mockResolvedValue({ sessions: [] });

      await handler("recent_changes")({ limit: 5, since: "2026-02-01" });

      expect(getRecentChanges).toHaveBeenCalledWith(5, "2026-02-01");
    });

    it("returns failure message when null", async () => {
      vi.mocked(getRecentChanges).mockResolvedValue(null);

      const result = await handler("recent_changes")({});

      expect(result.content[0].text).toContain("Could not retrieve recent changes");
    });
  });

  describe("auto_update_status tool", () => {
    it("calls getAutoUpdateStatus and returns JSON", async () => {
      const mockData = {
        entries: [{ id: 1, date: "2026-02-21", trigger: "scheduled", pagesUpdated: 5 }],
        total: 1,
        limit: 5,
        offset: 0,
      };
      vi.mocked(getAutoUpdateStatus).mockResolvedValue(mockData as any);

      const result = await handler("auto_update_status")({});

      expect(getAutoUpdateStatus).toHaveBeenCalledWith(undefined);
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it("passes limit parameter", async () => {
      vi.mocked(getAutoUpdateStatus).mockResolvedValue({ entries: [], total: 0, limit: 3, offset: 0 });

      await handler("auto_update_status")({ limit: 3 });

      expect(getAutoUpdateStatus).toHaveBeenCalledWith(3);
    });

    it("returns failure message when null", async () => {
      vi.mocked(getAutoUpdateStatus).mockResolvedValue(null);

      const result = await handler("auto_update_status")({});

      expect(result.content[0].text).toContain("Could not retrieve auto-update status");
    });
  });

  describe("citation_health tool", () => {
    it("calls getCitationHealth and returns JSON", async () => {
      const mockData = {
        broken: [{ pageId: "scheming", footnote: 1, url: "https://broken.com", claimText: "Claim" }],
      };
      vi.mocked(getCitationHealth).mockResolvedValue(mockData as any);

      const result = await handler("citation_health")({});

      expect(getCitationHealth).toHaveBeenCalledOnce();
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it("returns failure message when null", async () => {
      vi.mocked(getCitationHealth).mockResolvedValue(null);

      const result = await handler("citation_health")({});

      expect(result.content[0].text).toContain("Could not retrieve citation health data");
    });
  });

  describe("risk_report tool", () => {
    it("calls getRiskReport with defaults and returns JSON", async () => {
      const mockData = {
        pages: [{ pageId: "scheming", score: 85, level: "high", factors: ["no_citations"] }],
      };
      vi.mocked(getRiskReport).mockResolvedValue(mockData as any);

      const result = await handler("risk_report")({});

      expect(getRiskReport).toHaveBeenCalledWith("high", undefined);
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it("passes level and limit parameters", async () => {
      vi.mocked(getRiskReport).mockResolvedValue({ pages: [] });

      await handler("risk_report")({ level: "medium", limit: 5 });

      expect(getRiskReport).toHaveBeenCalledWith("medium", 5);
    });

    it("returns failure message when null", async () => {
      vi.mocked(getRiskReport).mockResolvedValue(null);

      const result = await handler("risk_report")({});

      expect(result.content[0].text).toContain("Could not retrieve risk report");
    });
  });
});
