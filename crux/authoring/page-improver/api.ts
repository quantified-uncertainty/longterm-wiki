/**
 * LLM/API layer for the page-improver pipeline.
 *
 * Thin wrapper around the shared LLM abstraction (crux/lib/llm.ts),
 * adding page-improver-specific tool handlers (web search, SCRY, file read).
 */

import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import {
  createLlmClient, runLlmAgent, streamingCreate, extractText,
  startHeartbeat, withRetry, type ToolHandler,
} from '../../lib/llm.ts';
import { MODELS } from '../../lib/anthropic.ts';
import type { RunAgentOptions } from './types.ts';
import { ROOT, SCRY_PUBLIC_KEY, log } from './utils.ts';

// ── Anthropic client (singleton) ─────────────────────────────────────────────

const client = createLlmClient();

// ── Re-export for pipeline.ts ────────────────────────────────────────────────

export { startHeartbeat };

// ── Tool implementations ─────────────────────────────────────────────────────

export async function executeWebSearch(query: string): Promise<string> {
  const response = await withRetry(
    () => streamingCreate(client, {
      model: MODELS.sonnet,
      max_tokens: 4000,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any],
      messages: [{
        role: 'user',
        content: `Search for: "${query}". Return the top 5 most relevant results with titles, URLs, and brief descriptions.`
      }]
    }),
    { label: 'web_search' }
  );

  return extractText(response);
}

export async function executeScrySearch(query: string, table: string = 'mv_eaforum_posts'): Promise<string> {
  const sql = `SELECT title, uri, snippet, original_author, original_timestamp::date as date
    FROM scry.search('${query.replace(/'/g, "''")}', '${table}')
    WHERE title IS NOT NULL AND kind = 'post'
    LIMIT 10`;

  try {
    const response = await fetch('https://api.exopriors.com/v1/scry/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SCRY_PUBLIC_KEY}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
      signal: AbortSignal.timeout(30000),
    });
    return await response.text();
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return `SCRY search error: ${error.message}`;
  }
}

// ── Tool handler registry ────────────────────────────────────────────────────

/** Build tool handlers for the page-improver agent. */
function buildToolHandlers(): Record<string, ToolHandler> {
  return {
    web_search: async (input) => executeWebSearch(input.query),
    scry_search: async (input) => executeScrySearch(input.query, input.table),
    read_file: async (input) => {
      const resolvedPath = path.resolve(input.path);
      if (!resolvedPath.startsWith(ROOT)) {
        return 'Access denied: path must be within project root';
      }
      return fs.readFileSync(resolvedPath, 'utf-8');
    },
  };
}

// ── Agent execution ──────────────────────────────────────────────────────────

/** Run Claude with tools (streaming + retry + heartbeat). */
export async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<string> {
  const {
    model = MODELS.sonnet,
    maxTokens = 16000,
    tools = [],
    systemPrompt = ''
  } = options;

  return runLlmAgent(client, prompt, {
    model,
    maxTokens,
    systemPrompt,
    tools,
    toolHandlers: buildToolHandlers(),
    retryLabel: 'runAgent',
    heartbeatPhase: 'api',
    onRetry: (msg) => log('retry', msg),
  });
}
