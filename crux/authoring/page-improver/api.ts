/**
 * LLM/API layer for the page-improver pipeline.
 *
 * Handles Claude API calls, web search, and SCRY search.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolUseBlock, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import fs from 'fs';
import path from 'path';
import { MODELS } from '../../lib/anthropic.ts';
import { getApiKey } from '../../lib/api-keys.ts';
import { withRetry as _withRetry, startHeartbeat as _startHeartbeat } from '../../lib/resilience.ts';
import type { RunAgentOptions } from './types.ts';
import { ROOT, SCRY_PUBLIC_KEY, log } from './utils.ts';

// ── Anthropic client ─────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: getApiKey('ANTHROPIC_API_KEY'), timeout: 10 * 60 * 1000 });

// ── Resilience wrappers ──────────────────────────────────────────────────────

/** Retry wrapper that feeds retries through the local `log()` function. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; label?: string } = {}
): Promise<T> {
  return _withRetry(fn, { ...opts, onRetry: (msg) => log('retry', msg) });
}

export const startHeartbeat = _startHeartbeat;

/**
 * Streaming wrapper for Anthropic API calls.
 * Uses server-sent events to keep the connection alive through proxies.
 */
export async function streamingCreate(
  params: Parameters<typeof anthropic.messages.create>[0]
): Promise<Anthropic.Messages.Message> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = anthropic.messages.stream(params as any);
  return await stream.finalMessage();
}

// ── Tool implementations ─────────────────────────────────────────────────────

export async function executeWebSearch(query: string): Promise<string> {
  const response = await withRetry(
    () => streamingCreate({
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

  const textBlocks = response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
  return textBlocks.map(b => b.text).join('\n');
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

// ── Agent execution ──────────────────────────────────────────────────────────

/** Run Claude with tools (streaming + retry + heartbeat). */
export async function runAgent(prompt: string, options: RunAgentOptions = {}): Promise<string> {
  const {
    model = MODELS.sonnet,
    maxTokens = 16000,
    tools = [],
    systemPrompt = ''
  } = options;

  const messages: MessageParam[] = [{ role: 'user', content: prompt }];

  const makeRequest = (msgs: MessageParam[]) =>
    withRetry(
      () => streamingCreate({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: tools as Anthropic.Messages.Tool[],
        messages: msgs
      }),
      { label: `runAgent(${model}, ${maxTokens} tokens)` }
    );

  const stopHeartbeat = startHeartbeat('api', 30);
  let response: Anthropic.Messages.Message;
  try {
    response = await makeRequest(messages);
  } finally {
    stopHeartbeat();
  }

  // Handle tool use loop
  let toolTurns = 0;
  const MAX_TOOL_TURNS = 10;
  while (response.stop_reason === 'tool_use' && toolTurns < MAX_TOOL_TURNS) {
    toolTurns++;
    const toolUseBlocks = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const toolResults: ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      let result: string;
      try {
        const input = (toolUse.input ?? {}) as Record<string, string>;
        if (toolUse.name === 'web_search') {
          result = await executeWebSearch(input.query);
        } else if (toolUse.name === 'scry_search') {
          result = await executeScrySearch(input.query, input.table);
        } else if (toolUse.name === 'read_file') {
          const resolvedPath = path.resolve(input.path);
          if (!resolvedPath.startsWith(ROOT)) {
            result = 'Access denied: path must be within project root';
          } else {
            result = fs.readFileSync(resolvedPath, 'utf-8');
          }
        } else {
          result = `Unknown tool: ${toolUse.name}`;
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        result = `Error: ${error.message}`;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result)
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    const stopLoop = startHeartbeat('api-tool-loop', 30);
    try {
      response = await makeRequest(messages);
    } finally {
      stopLoop();
    }
  }
  if (toolTurns >= MAX_TOOL_TURNS) {
    log('api', `Warning: hit tool turn limit (${MAX_TOOL_TURNS}), stopping agent loop`);
  }

  const textBlocks = response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text');
  return textBlocks.map(b => b.text).join('\n');
}
