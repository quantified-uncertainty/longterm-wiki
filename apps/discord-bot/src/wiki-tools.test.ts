import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the wiki-api module
vi.mock("./wiki-api.js", () => ({
  searchWiki: vi.fn(),
  getPage: vi.fn(),
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

const { searchWiki, getPage } = await import("./wiki-api.js");
const wikiToolsModule = await import("./wiki-tools.js");
// Our mock returns { name, tools } but the real SDK type is McpSdkServerConfigWithInstance
const wikiMcpServer = wikiToolsModule.wikiMcpServer as any;

describe("wiki MCP tools", () => {
  beforeEach(() => {
    vi.mocked(searchWiki).mockReset();
    vi.mocked(getPage).mockReset();
  });

  it("exports an MCP server with two tools", () => {
    expect(wikiMcpServer.name).toBe("wiki-server");
    expect(wikiMcpServer.tools).toHaveLength(2);
    expect(wikiMcpServer.tools[0].name).toBe("search_wiki");
    expect(wikiMcpServer.tools[1].name).toBe("get_page");
  });

  describe("search_wiki tool", () => {
    const searchHandler = () => (wikiMcpServer.tools[0] as any).handler;

    it("calls searchWiki and returns JSON results", async () => {
      const mockResults = [
        { id: "scheming", title: "Scheming", score: 1.5 },
      ];
      vi.mocked(searchWiki).mockResolvedValue(mockResults as any);

      const result = await searchHandler()({ query: "scheming" });

      expect(searchWiki).toHaveBeenCalledWith("scheming", undefined);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(JSON.parse(result.content[0].text)).toEqual(mockResults);
    });

    it("passes limit parameter", async () => {
      vi.mocked(searchWiki).mockResolvedValue([]);

      await searchHandler()({ query: "test", limit: 5 });

      expect(searchWiki).toHaveBeenCalledWith("test", 5);
    });

    it("returns empty array JSON when no results", async () => {
      vi.mocked(searchWiki).mockResolvedValue([]);

      const result = await searchHandler()({ query: "nonexistent" });

      expect(JSON.parse(result.content[0].text)).toEqual([]);
    });
  });

  describe("get_page tool", () => {
    const getPageHandler = () => (wikiMcpServer.tools[1] as any).handler;

    it("returns formatted page content", async () => {
      vi.mocked(getPage).mockResolvedValue({
        id: "scheming",
        title: "Scheming",
        description: "AI deception risk",
        contentPlaintext: "Full page content here.",
      } as any);

      const result = await getPageHandler()({ id: "scheming" });

      expect(getPage).toHaveBeenCalledWith("scheming");
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("# Scheming");
      expect(result.content[0].text).toContain("AI deception risk");
      expect(result.content[0].text).toContain("Full page content here.");
    });

    it("returns 'Page not found' for missing pages", async () => {
      vi.mocked(getPage).mockResolvedValue(null);

      const result = await getPageHandler()({ id: "nonexistent" });

      expect(result.content[0].text).toBe("Page not found");
    });

    it("handles null description and content gracefully", async () => {
      vi.mocked(getPage).mockResolvedValue({
        id: "stub",
        title: "Stub Page",
        description: null,
        contentPlaintext: null,
      } as any);

      const result = await getPageHandler()({ id: "stub" });

      expect(result.content[0].text).toContain("# Stub Page");
      expect(result.content[0].text).toContain("(no content)");
      // Should not contain "null" as literal text
      expect(result.content[0].text).not.toContain("null");
    });
  });
});
