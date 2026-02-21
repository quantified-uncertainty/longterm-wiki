import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { searchWiki, getPage } from "./wiki-api.js";

const searchTool = tool(
  "search_wiki",
  "Search the AI safety wiki for pages matching a query. Returns ranked results with titles, descriptions, and relevance scores.",
  {
    query: z.string().describe("Search query"),
    limit: z
      .number()
      .optional()
      .describe("Max results to return (default 10)"),
  },
  async (args) => {
    const results = await searchWiki(args.query, args.limit);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

const getPageTool = tool(
  "get_page",
  "Get the full content of a wiki page by its slug ID (e.g. 'scheming') or numeric ID (e.g. 'E42'). Returns the page title, description, and full plaintext content.",
  {
    id: z.string().describe("Page slug (e.g. 'scheming') or numeric ID (e.g. 'E42')"),
  },
  async (args) => {
    const page = await getPage(args.id);
    if (!page) {
      return { content: [{ type: "text" as const, text: "Page not found" }] };
    }
    const text = `# ${page.title}\n\n${page.description ?? ""}\n\n${page.contentPlaintext ?? "(no content)"}`;
    return { content: [{ type: "text" as const, text }] };
  }
);

export const wikiMcpServer = createSdkMcpServer({
  name: "wiki-server",
  tools: [searchTool, getPageTool],
});
