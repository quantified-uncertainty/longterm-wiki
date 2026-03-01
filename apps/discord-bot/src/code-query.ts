import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  WIKI_BASE_URL,
  CODE_TIMEOUT_MS,
  CODE_MAX_BUDGET_USD,
  CODE_MAX_TURNS,
  CODE_MAX_TOOL_CALLS,
  CLAUDE_CODE_OAUTH_TOKEN,
  WIKI_REPO_PATH,
} from "./config.js";
import { wikiMcpServer } from "./wiki-tools.js";
import { logger } from "./log.js";

export interface CodeQueryResult {
  result: string;
  toolCalls: string[];
  durationMs: number;
  model?: string;
}

export function buildCodePrompt(question: string): string {
  return `You are a research assistant for LongtermWiki, an AI safety knowledge base.

You have access to:
1. **File tools** (Read, Glob, Grep) pointed at the wiki repository. Use these to explore MDX pages in content/docs/, YAML entity data in data/entities/, facts in data/facts/, and resources in data/resources/.
2. **Wiki API tools** (search_wiki, get_page, get_entity, get_facts, etc.) that query the live wiki database.

## Repository structure
- content/docs/ — ~700 MDX wiki pages organized by topic
- data/entities/ — YAML files defining entities (orgs, people, models, concepts)
- data/facts/ — Canonical numerical facts (funding, headcount, etc.)
- data/resources/ — Curated external papers, articles, reports
- data/graphs/ — Cause-effect graph data

## Strategy
- For quick lookups, use the wiki API tools (search_wiki, get_page, get_facts)
- For deep research across multiple files, use Grep to find patterns across the codebase
- For exploring page content in detail, use Read on specific MDX files
- Combine both approaches for comprehensive answers

## Response format
- Be concise: 2-4 paragraphs max
- Link to relevant pages: [Title](${WIKI_BASE_URL}/wiki/{id})
- If you can't find information after thorough search, say so honestly

## Question
"${question}"`;
}

export async function runCodeQuery(
  question: string
): Promise<CodeQueryResult> {
  const toolCalls: string[] = [];
  let lastResult = "";
  let model: string | undefined;

  const startTime = Date.now();
  const elapsed = () => `[${((Date.now() - startTime) / 1000).toFixed(1)}s]`;

  // Whitelist env vars for the spawned Claude Code subprocess.
  // Only pass what's needed — exclude DISCORD_TOKEN, API keys, etc.
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_OAUTH_TOKEN,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: process.env.NODE_ENV,
  };

  const queryPromise = (async (): Promise<CodeQueryResult> => {
    for await (const msg of query({
      prompt: buildCodePrompt(question),
      options: {
        tools: ["Read", "Glob", "Grep"],
        mcpServers: { "wiki-server": wikiMcpServer },
        cwd: WIKI_REPO_PATH,
        env,
        maxTurns: CODE_MAX_TURNS,
        maxBudgetUsd: CODE_MAX_BUDGET_USD,
        persistSession: false,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: `You are answering a question from a Discord user. Be concise (2-4 paragraphs). Link to wiki pages using ${WIKI_BASE_URL}/wiki/{id} format.`,
        },
      },
    })) {
      if (msg.type === "assistant" && "message" in msg) {
        const message = (msg as Record<string, unknown>).message as
          | {
              model?: string;
              content?: Array<{
                type: string;
                name?: string;
                text?: string;
                input?: Record<string, unknown>;
              }>;
            }
          | undefined;

        if (message?.model) model = message.model;

        if (Array.isArray(message?.content)) {
          for (const block of message.content) {
            if (block.type === "tool_use" && block.name) {
              const detail =
                block.input?.file_path ||
                block.input?.pattern ||
                block.input?.query ||
                block.input?.id ||
                "";
              toolCalls.push(
                `${block.name}: ${String(detail).slice(0, 80)}`
              );
              logger.debug(
                { elapsed: elapsed(), tool: block.name },
                "Code tool call"
              );
            }
          }

          if (toolCalls.length >= CODE_MAX_TOOL_CALLS) {
            logger.warn(
              { elapsed: elapsed(), maxToolCalls: CODE_MAX_TOOL_CALLS },
              "Code query tool call limit reached"
            );
            lastResult =
              lastResult +
              `\n\n*(Stopped after ${CODE_MAX_TOOL_CALLS} tool calls to limit usage)*`;
            break;
          }
        }
      }

      if ("result" in msg && typeof msg.result === "string") {
        lastResult = msg.result;
      }

      if (msg.type === "result") {
        return {
          result: lastResult,
          toolCalls,
          durationMs: Date.now() - startTime,
          model,
        };
      }
    }

    return {
      result: lastResult,
      toolCalls,
      durationMs: Date.now() - startTime,
      model,
    };
  })();

  const timeoutPromise = new Promise<CodeQueryResult>((_, reject) => {
    setTimeout(() => reject(new Error("TIMEOUT")), CODE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([queryPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof Error && error.message === "TIMEOUT") {
      if (lastResult) {
        return {
          result: lastResult + "\n\n*(Response truncated due to timeout)*",
          toolCalls,
          durationMs: Date.now() - startTime,
          model,
        };
      }
      const timeoutMinutes = CODE_TIMEOUT_MS / 1000 / 60;
      throw new Error(`Query timed out after ${timeoutMinutes} minutes`);
    }

    // Surface auth errors clearly
    const errorMsg =
      error instanceof Error ? error.message : String(error);
    if (
      errorMsg.includes("auth") ||
      errorMsg.includes("token") ||
      errorMsg.includes("401") ||
      errorMsg.includes("403")
    ) {
      throw new Error(
        `Authentication failed — the OAuth token may have expired. Original error: ${errorMsg}`
      );
    }

    throw error;
  }
}
