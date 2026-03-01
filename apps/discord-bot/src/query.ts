import { query } from "@anthropic-ai/claude-agent-sdk";
import { WIKI_BASE_URL, TIMEOUT_MS, MAX_TOOL_CALLS } from "./config.js";
import { wikiMcpServer } from "./wiki-tools.js";
import { logger } from "./log.js";

export interface QueryResult {
  result: string;
  toolCalls: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model?: string;
}

export function buildPrompt(question: string): string {
  return `You are an expert assistant for LongtermWiki, a curated AI safety knowledge base with ~625 pages covering risks, organizations, models, concepts, governance responses, and more.

## Wiki structure

**Page categories:** risks (misuse, accident, structural), organizations (labs, nonprofits, governments), AI models, technical concepts (alignment, interpretability, RLHF, etc.), governance interventions, historical events, people, and resources.

**Entity types registered in the wiki:** person, organization, risk, approach, model, concept, intelligence-paradigm, capability, crux, debate, event, metric, project, policy, case-study, scenario.

## Available tools and when to use them

- **search_wiki** — General topic search across all pages. Start here for most questions.
- **get_page** — Fetch full page content. Use after search to get details.
- **get_related_pages** — Find pages related to a topic. Use for "what's connected to X?" or exploration questions.
- **get_entity** — Get structured data (description, website, tags) for a specific org/person/model. Use when asked about a specific named entity.
- **search_entities** — Search the entity registry. Use for "which organizations work on X?" or "who are the researchers studying Y?"
- **get_facts** — Get canonical numerical facts for an entity (funding, headcount, compute, publications). Use for quantitative questions like "How many employees does Anthropic have?" or "What's OpenAI's funding?"
- **get_page_citations** — Get source citations and footnotes for a page. Use when asked "what are the sources for X?" or "is claim Y cited?"
- **search_resources** — Search curated papers/articles/reports. Use for "any good papers on X?" or reading recommendations.
- **get_backlinks** — Find pages that mention a topic. Use for "what pages reference RLHF?" or "what topics link to MIRI?"
- **wiki_stats** — Overall wiki statistics (page count, entity count, citation count). Use for "how big is the wiki?"
- **recent_changes** — Recent editing sessions. Use for "what changed this week?" or "what was recently updated?"
- **auto_update_status** — Status of automatic update runs. Use for "when was the last auto-update?" or "what did it change?"
- **citation_health** — Pages with broken citations. Use for "which pages have broken citations?"
- **risk_report** — Pages with high hallucination risk scores. Use for "which pages need review?" or "which are least trustworthy?"

## Tool chaining strategy

- **Quantitative questions** (funding, headcount, compute): search_entities → get_facts
- **Conceptual questions**: search_wiki → get_page
- **Exploration questions** ("what's related to X?"): search_wiki → get_related_pages
- **Organization/person questions**: search_entities → get_entity → get_facts
- **Source questions**: search_wiki → get_page_citations
- **Resource recommendations**: search_resources

## Instructions

1. Choose the right tool(s) for the question type (see strategy above)
2. If the first search doesn't find what you need, try a different search term or tool
3. If you genuinely can't find the information after 2-3 attempts, say "I couldn't find information about this topic in the wiki"
4. Be concise — 2-3 paragraphs max
5. Always link to relevant pages:
   - URL format: ${WIKI_BASE_URL}/wiki/{id}
   - Example: ${WIKI_BASE_URL}/wiki/scheming
   - Format as markdown: [Page Title](${WIKI_BASE_URL}/wiki/page-id)

## Question to answer

"${question}"`;
}

export async function runQuery(question: string): Promise<QueryResult> {
  let result = "";
  let lastResult = "";
  const toolCalls: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let model: string | undefined;

  const startTime = Date.now();
  const elapsed = () => `[${((Date.now() - startTime) / 1000).toFixed(1)}s]`;

  const queryPromise = (async () => {
    for await (const msg of query({
      prompt: buildPrompt(question),
      options: {
        allowedTools: [],
        mcpServers: { wiki: wikiMcpServer },
        permissionMode: "bypassPermissions",
      } as any,
    })) {
      const msgType = msg.type;
      const subtype = "subtype" in msg ? msg.subtype : "";

      if (msgType === "assistant" && "message" in msg) {
        const message = (msg as any).message;
        if (message?.usage) {
          inputTokens += message.usage.input_tokens || 0;
          outputTokens += message.usage.output_tokens || 0;
          cacheReadTokens += message.usage.cache_read_input_tokens || 0;
          cacheCreationTokens += message.usage.cache_creation_input_tokens || 0;
        }
        if (message?.model) {
          model = message.model;
        }

        const content = message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              const detail =
                block.input?.query ||
                block.input?.id ||
                block.input?.entity_id ||
                block.input?.page_id ||
                "";
              toolCalls.push(`${block.name}: ${detail}`);
              logger.debug({ elapsed: elapsed(), tool: block.name, detail }, "Tool call");
            } else if (block.type === "text" && block.text) {
              logger.debug({ elapsed: elapsed(), text: block.text.slice(0, 100) }, "Text block");
            }
          }
          if (toolCalls.length >= MAX_TOOL_CALLS) {
            logger.warn({ elapsed: elapsed(), maxToolCalls: MAX_TOOL_CALLS }, "Tool call limit reached, stopping query");
            result =
              (lastResult || result) +
              `\n\n*(Stopped after ${MAX_TOOL_CALLS} tool calls to limit API usage)*`;
            break;
          }
        }
      } else if (msgType === "result") {
        logger.debug({ elapsed: elapsed() }, "Got result");
      } else {
        logger.debug({ elapsed: elapsed(), msgType, subtype }, "Stream event");
      }

      if ("result" in msg) {
        result = msg.result as string;
        lastResult = result;
      }
    }
    return {
      result,
      toolCalls,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      model,
    };
  })();

  const timeoutPromise = new Promise<QueryResult>((_, reject) => {
    setTimeout(() => reject(new Error("TIMEOUT")), TIMEOUT_MS);
  });

  try {
    return await Promise.race([queryPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof Error && error.message === "TIMEOUT") {
      if (lastResult) {
        return {
          result: lastResult + "\n\n*(Response truncated due to timeout)*",
          toolCalls,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          model,
        };
      }
      throw new Error("Query timed out after 60 seconds");
    }
    throw error;
  }
}
