import { query } from "@anthropic-ai/claude-agent-sdk";
import { WIKI_BASE_URL, TIMEOUT_MS } from "./config.js";
import { wikiMcpServer } from "./wiki-tools.js";

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
  return `Answer this question about the LongtermWiki AI safety wiki: "${question}"

Instructions:
1. Use search_wiki to find relevant pages matching the question
2. Use get_page to read the full content of the most relevant pages
3. If you can't find info after 2-3 searches, say "I couldn't find information about this topic"
4. Be concise (2-3 paragraphs max)
5. Include links to relevant pages using the page ID:
   - URL format: ${WIKI_BASE_URL}/wiki/{id}
   - Example: ${WIKI_BASE_URL}/wiki/scheming
   - Format as markdown: [Page Title](${WIKI_BASE_URL}/wiki/...)
   - Always use the full URL starting with https://`;
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
                "";
              toolCalls.push(`${block.name}: ${detail}`);
              console.log(`${elapsed()} 🔧 Tool: ${block.name}`, detail);
            } else if (block.type === "text" && block.text) {
              console.log(
                `${elapsed()} 💬 Text: ${block.text.slice(0, 100)}...`
              );
            }
          }
        }
      } else if (msgType === "result") {
        console.log(`${elapsed()} ✅ Got result`);
      } else {
        console.log(`${elapsed()} ${msgType} ${subtype}`);
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
