import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
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
} from "./wiki-api.js";

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

const getRelatedPagesTool = tool(
  "get_related_pages",
  "Get pages related to a given wiki page or entity by ID. Returns a list of related pages with relationship labels and relevance scores. Useful for exploring connected topics.",
  {
    id: z.string().describe("Page or entity ID (e.g. 'deceptive-alignment')"),
    limit: z
      .number()
      .optional()
      .describe("Max results to return (default 10)"),
  },
  async (args) => {
    const data = await getRelatedPages(args.id, args.limit);
    if (!data) {
      return {
        content: [{ type: "text" as const, text: "No related pages found or page not found" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

const getEntityTool = tool(
  "get_entity",
  "Get structured data about a specific entity (organization, person, model, concept, etc.) by its ID. Returns description, website, tags, custom fields, and related entries. Use this for factual questions about specific organizations or people.",
  {
    id: z
      .string()
      .describe("Entity ID (e.g. 'miri', 'anthropic', 'gpt-4')"),
  },
  async (args) => {
    const entity = await getEntity(args.id);
    if (!entity) {
      return { content: [{ type: "text" as const, text: "Entity not found" }] };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(entity, null, 2) }],
    };
  }
);

const searchEntitiesTool = tool(
  "search_entities",
  "Search the wiki's entity registry (organizations, people, models, concepts, risks, etc.) by name or description. Use this when asked about specific organizations, researchers, or AI models rather than topics.",
  {
    query: z.string().describe("Search query (e.g. 'AI safety organizations', 'language models')"),
    limit: z
      .number()
      .optional()
      .describe("Max results to return (default 10)"),
  },
  async (args) => {
    const data = await searchEntities(args.query, args.limit);
    if (!data) {
      return {
        content: [{ type: "text" as const, text: "Entity search failed" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

const getFactsTool = tool(
  "get_facts",
  "Get canonical numerical facts for a specific entity (e.g. funding, employee count, compute, publication counts). Use this for quantitative questions like 'How many employees does Anthropic have?' or 'What is OpenAI's funding?'",
  {
    entity_id: z
      .string()
      .describe("Entity ID to get facts for (e.g. 'anthropic', 'openai', 'deepmind')"),
  },
  async (args) => {
    const data = await getFacts(args.entity_id);
    if (!data) {
      return {
        content: [{ type: "text" as const, text: "No facts found for this entity" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

const getPageCitationsTool = tool(
  "get_page_citations",
  "Get the citations and source quotes for a specific wiki page. Returns footnotes with source titles, URLs, claim text, and verification status. Use this when asked 'what are the sources for X?' or 'is claim Y cited?'",
  {
    page_id: z
      .string()
      .describe("Page ID to get citations for (e.g. 'scheming', 'deceptive-alignment')"),
  },
  async (args) => {
    const data = await getPageCitations(args.page_id);
    if (!data) {
      return {
        content: [{ type: "text" as const, text: "No citations found for this page" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

const searchResourcesTool = tool(
  "search_resources",
  "Search the wiki's curated resource library for papers, articles, reports, and other external references. Use this when asked for reading recommendations or specific papers on a topic.",
  {
    query: z
      .string()
      .describe("Search query (e.g. 'interpretability papers', 'AI governance reports')"),
    limit: z
      .number()
      .optional()
      .describe("Max results to return (default 10)"),
  },
  async (args) => {
    const data = await searchResources(args.query, args.limit);
    if (!data) {
      return {
        content: [{ type: "text" as const, text: "Resource search failed" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

const getBacklinksTool = tool(
  "get_backlinks",
  "Get all wiki pages that link to a given page or entity. Shows which topics reference this page, revealing its place in the knowledge graph. Useful for 'what pages mention X?' questions.",
  {
    id: z.string().describe("Page or entity ID (e.g. 'rlhf', 'miri')"),
    limit: z
      .number()
      .optional()
      .describe("Max results to return (default 20)"),
  },
  async (args) => {
    const data = await getBacklinks(args.id, args.limit);
    if (!data) {
      return {
        content: [{ type: "text" as const, text: "No backlinks found or page not found" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

const wikiStatsTool = tool(
  "wiki_stats",
  "Get overall statistics about the LongtermWiki: total pages, entities, facts, citations, uptime. Use this when asked 'how big is the wiki?' or 'how many citations does the wiki have?'",
  {},
  async (_args) => {
    const stats = await getWikiStats();
    if (!stats) {
      return {
        content: [{ type: "text" as const, text: "Could not retrieve wiki stats" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
    };
  }
);

const recentChangesTool = tool(
  "recent_changes",
  "Get recent wiki editing sessions showing which pages were changed and when. Use this for questions like 'what changed on the wiki this week?' or 'what was recently updated?'",
  {
    limit: z
      .number()
      .optional()
      .describe("Max sessions to return (default 10)"),
    since: z
      .string()
      .optional()
      .describe("Filter sessions since this date (YYYY-MM-DD format)"),
  },
  async (args) => {
    const data = await getRecentChanges(args.limit, args.since);
    if (!data) {
      return {
        content: [{ type: "text" as const, text: "Could not retrieve recent changes" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

const autoUpdateStatusTool = tool(
  "auto_update_status",
  "Get the status of recent automatic wiki update runs, including how many pages were updated, budget spent, and which pages changed. Use this for questions about 'when was the last auto-update?' or 'what did the last update change?'",
  {
    limit: z
      .number()
      .optional()
      .describe("Max runs to return (default 5)"),
  },
  async (args) => {
    const data = await getAutoUpdateStatus(args.limit);
    if (!data) {
      return {
        content: [{ type: "text" as const, text: "Could not retrieve auto-update status" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

const citationHealthTool = tool(
  "citation_health",
  "Get a list of wiki pages with broken or unverified citations. Use this when asked 'which pages have broken citations?' or 'which pages are missing sources?'",
  {},
  async (_args) => {
    const data = await getCitationHealth();
    if (!data) {
      return {
        content: [{ type: "text" as const, text: "Could not retrieve citation health data" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

const riskReportTool = tool(
  "risk_report",
  "Get a report of wiki pages with the highest hallucination risk scores, indicating which pages may have accuracy issues or need review. Use this when asked 'which pages are least trustworthy?' or 'which pages need review?'",
  {
    level: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Risk level filter (default 'high')"),
    limit: z
      .number()
      .optional()
      .describe("Max pages to return (default 10)"),
  },
  async (args) => {
    const data = await getRiskReport(args.level ?? "high", args.limit);
    if (!data) {
      return {
        content: [{ type: "text" as const, text: "Could not retrieve risk report" }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

export const wikiMcpServer = createSdkMcpServer({
  name: "wiki-server",
  tools: [
    searchTool,
    getPageTool,
    getRelatedPagesTool,
    getEntityTool,
    searchEntitiesTool,
    getFactsTool,
    getPageCitationsTool,
    searchResourcesTool,
    getBacklinksTool,
    wikiStatsTool,
    recentChangesTool,
    autoUpdateStatusTool,
    citationHealthTool,
    riskReportTool,
  ],
});
