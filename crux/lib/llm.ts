/**
 * Shared LLM Abstraction
 *
 * Unified interface for Claude API calls across all authoring pipelines.
 * Consolidates streaming, retry, heartbeat, and tool-use loop patterns
 * that were previously duplicated between page-improver/api.ts and
 * creator/api-direct.ts.
 *
 * Usage:
 *   import { createLlmClient, runLlmAgent, streamLlmCall } from '../../lib/llm.ts';
 *
 *   const client = createLlmClient();
 *   const text = await streamLlmCall(client, { model: MODELS.sonnet, ... });
 *   // or with tool loop:
 *   const result = await runLlmAgent(client, prompt, { tools, toolHandlers });
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolUseBlock, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { createClient, MODELS } from './anthropic.ts';
import { withRetry, startHeartbeat } from './resilience.ts';

// ---------------------------------------------------------------------------
// Client creation
// ---------------------------------------------------------------------------

export interface LlmClientOptions {
  apiKey?: string;
  timeout?: number;
}

/**
 * Create an Anthropic client with sensible defaults.
 * Throws if ANTHROPIC_API_KEY is not available.
 */
export function createLlmClient(options?: LlmClientOptions): Anthropic {
  const client = createClient({ apiKey: options?.apiKey });
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY not found in environment');
  }
  return client;
}

// ---------------------------------------------------------------------------
// Low-level streaming call
// ---------------------------------------------------------------------------

/**
 * Execute a streaming Claude API call and return the final message.
 * Handles SSE streaming through proxies.
 */
export async function streamingCreate(
  client: Anthropic,
  params: Parameters<typeof client.messages.create>[0]
): Promise<Anthropic.Messages.Message> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = client.messages.stream(params as any);
  return await stream.finalMessage();
}

/**
 * Extract text content from a Claude response message.
 */
export function extractText(response: Anthropic.Messages.Message): string {
  return response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

/**
 * Extract MDX content from a Claude response.
 * Handles code blocks, frontmatter detection, etc.
 */
export function extractMdxContent(text: string): string {
  // If wrapped in a code block, extract it
  const codeBlockMatch = text.match(/```(?:mdx)?\n([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1];
  }

  // If starts with frontmatter, it's already MDX
  if (text.startsWith('---')) {
    return text;
  }

  // Try to find the frontmatter start
  const fmStart = text.indexOf('---\n');
  if (fmStart !== -1) {
    return text.slice(fmStart);
  }

  return text;
}

// ---------------------------------------------------------------------------
// Simple streaming call with retry + heartbeat
// ---------------------------------------------------------------------------

export interface StreamCallOptions {
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  temperature?: number;
  retryLabel?: string;
  heartbeatPhase?: string;
}

/**
 * Make a simple Claude API call with streaming, retry, and heartbeat.
 * Returns the text content of the response.
 */
export async function streamLlmCall(
  client: Anthropic,
  prompt: string,
  options: StreamCallOptions = {},
): Promise<string> {
  const {
    model = MODELS.sonnet,
    maxTokens = 4000,
    systemPrompt = '',
    temperature,
    retryLabel = 'llm-call',
    heartbeatPhase = 'api',
  } = options;

  const stopHeartbeat = startHeartbeat(heartbeatPhase, 30);
  try {
    const response = await withRetry(
      () => streamingCreate(client, {
        model,
        max_tokens: maxTokens,
        ...(systemPrompt && { system: systemPrompt }),
        ...(temperature !== undefined && { temperature }),
        messages: [{ role: 'user', content: prompt }],
      }),
      { label: retryLabel }
    );

    return extractText(response);
  } finally {
    stopHeartbeat();
  }
}

// ---------------------------------------------------------------------------
// Agent loop (with tool use)
// ---------------------------------------------------------------------------

/** Handler function for a tool call. Returns the tool result as a string. */
export type ToolHandler = (input: Record<string, string>) => Promise<string>;

export interface AgentOptions {
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  /** Map of tool name → handler function. */
  toolHandlers?: Record<string, ToolHandler>;
  maxToolTurns?: number;
  retryLabel?: string;
  heartbeatPhase?: string;
  /** Called on each retry. Defaults to console.log. */
  onRetry?: (message: string) => void;
}

/**
 * Run Claude as an agent with tool-use loop support.
 * Handles streaming, retry, heartbeat, and iterative tool calls.
 *
 * This replaces the duplicated agent loops in page-improver/api.ts
 * and creator/api-direct.ts.
 */
export async function runLlmAgent(
  client: Anthropic,
  prompt: string,
  options: AgentOptions = {},
): Promise<string> {
  const {
    model = MODELS.sonnet,
    maxTokens = 16000,
    systemPrompt = '',
    tools = [],
    toolHandlers = {},
    maxToolTurns = 10,
    retryLabel = 'agent',
    heartbeatPhase = 'api',
  } = options;

  const messages: MessageParam[] = [{ role: 'user', content: prompt }];

  const makeRequest = (msgs: MessageParam[]) =>
    withRetry(
      () => streamingCreate(client, {
        model,
        max_tokens: maxTokens,
        ...(systemPrompt && { system: systemPrompt }),
        tools: tools as Anthropic.Messages.Tool[],
        messages: msgs,
      }),
      { label: `${retryLabel}(${model}, ${maxTokens} tokens)`, onRetry: options.onRetry }
    );

  const stopHeartbeat = startHeartbeat(heartbeatPhase, 30);
  let response: Anthropic.Messages.Message;
  try {
    response = await makeRequest(messages);
  } finally {
    stopHeartbeat();
  }

  // Handle tool use loop
  let toolTurns = 0;
  while (response.stop_reason === 'tool_use' && toolTurns < maxToolTurns) {
    toolTurns++;
    const toolUseBlocks = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const toolResults: ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      let result: string;
      try {
        const input = (toolUse.input ?? {}) as Record<string, string>;
        const handler = toolHandlers[toolUse.name];
        if (handler) {
          result = await handler(input);
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

    const stopLoop = startHeartbeat(`${heartbeatPhase}-tool-loop`, 30);
    try {
      response = await makeRequest(messages);
    } finally {
      stopLoop();
    }
  }

  if (toolTurns >= maxToolTurns) {
    console.warn(`[llm] Hit tool turn limit (${maxToolTurns}), stopping agent loop`);
  }

  return extractText(response);
}

// Re-export commonly used dependencies so consumers don't need multiple imports
export { MODELS } from './anthropic.ts';
export { withRetry, startHeartbeat } from './resilience.ts';
