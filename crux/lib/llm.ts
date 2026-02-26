/**
 * Shared LLM Abstraction
 *
 * Unified interface for Claude API calls across all authoring pipelines.
 * Consolidates streaming, retry, heartbeat, and tool-use loop patterns
 * that were previously duplicated between page-improver/api.ts and
 * creator/api-direct.ts.
 *
 * Supports OpenRouter routing: call `setOpenRouterMode(true)` before
 * pipeline execution to route all Claude calls through OpenRouter.
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
import type { CostTracker } from './cost-tracker.ts';
import { getApiKey } from './api-keys.ts';

// ---------------------------------------------------------------------------
// OpenRouter routing
// ---------------------------------------------------------------------------

let _useOpenRouter = false;

/** Enable or disable OpenRouter routing for all LLM calls. */
export function setOpenRouterMode(enabled: boolean): void {
  _useOpenRouter = enabled;
  if (enabled) {
    console.log('[llm] OpenRouter mode enabled — routing Claude calls through OpenRouter');
  }
}

/** Check if OpenRouter mode is active. */
export function isOpenRouterMode(): boolean {
  return _useOpenRouter;
}

/** Map Anthropic model IDs to OpenRouter model IDs. */
function toOpenRouterModel(model: string): string {
  // If already has a provider prefix, use as-is
  if (model.includes('/')) return model;
  return `anthropic/${model}`;
}

// ---------------------------------------------------------------------------
// Client creation
// ---------------------------------------------------------------------------

export interface LlmClientOptions {
  apiKey?: string;
  timeout?: number;
}

/**
 * Create an Anthropic client with sensible defaults.
 * In OpenRouter mode, still creates a client (for type compatibility)
 * but streamingCreate will bypass it.
 * Throws if ANTHROPIC_API_KEY is not available (unless OpenRouter mode).
 */
export function createLlmClient(options?: LlmClientOptions): Anthropic {
  if (_useOpenRouter) {
    // In OpenRouter mode, we still need a client object for type compatibility,
    // but streamingCreate will bypass it. Create with a dummy key if needed.
    const key = options?.apiKey || getApiKey('ANTHROPIC_API_KEY') || 'openrouter-mode';
    return new Anthropic({ apiKey: key });
  }
  const client = createClient({ apiKey: options?.apiKey });
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY not found in environment');
  }
  return client;
}

// ---------------------------------------------------------------------------
// Low-level streaming call
// ---------------------------------------------------------------------------

/** Options for streamingCreate (tracker integration). */
export interface StreamingCreateOptions {
  /** If provided, the call's usage is automatically recorded. */
  tracker?: CostTracker;
  /** Label for the cost entry (e.g. "orchestrator", "rewrite_section"). */
  label?: string;
}

/**
 * Execute a streaming Claude API call and return the final message.
 * Handles SSE streaming through proxies.
 *
 * When OpenRouter mode is active, routes through OpenRouter's API
 * instead of the Anthropic SDK.
 *
 * When a CostTracker is provided via options, the call's token usage is
 * automatically recorded — no caller-side bookkeeping needed.
 */
export async function streamingCreate(
  client: Anthropic,
  params: Parameters<typeof client.messages.create>[0],
  options?: StreamingCreateOptions,
): Promise<Anthropic.Messages.Message> {
  if (_useOpenRouter) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return callOpenRouterAsAnthropic(params as any, options);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = client.messages.stream(params as any);
  const message = await stream.finalMessage();

  // Auto-record if tracker provided
  if (options?.tracker && message.usage) {
    options.tracker.record(
      params.model,
      message.usage,
      options.label,
    );
  }

  return message;
}

/**
 * Route an Anthropic-formatted request through OpenRouter and return
 * a response shaped like Anthropic.Messages.Message.
 */
async function callOpenRouterAsAnthropic(
  params: Record<string, unknown>,
  options?: StreamingCreateOptions,
): Promise<Anthropic.Messages.Message> {
  const apiKey = getApiKey('OPENROUTER_API_KEY');
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set — required for OpenRouter mode');
  }

  const model = toOpenRouterModel(params.model as string);

  // Convert Anthropic message format to OpenRouter (OpenAI-compatible) format
  const messages: Array<{ role: string; content: string }> = [];

  // System prompt
  if (params.system) {
    const systemText = typeof params.system === 'string'
      ? params.system
      : Array.isArray(params.system)
        ? (params.system as Array<{ text: string }>).map(b => b.text).join('\n')
        : '';
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  // User/assistant messages
  const inputMessages = params.messages as MessageParam[];
  for (const msg of inputMessages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Flatten content blocks to text
      const text = (msg.content as Array<{ type: string; text?: string; content?: string }>)
        .map((block) => {
          if (block.type === 'text') return block.text || '';
          if (block.type === 'tool_result') return block.content || '';
          return JSON.stringify(block);
        })
        .join('\n');
      messages.push({ role: msg.role, content: text });
    }
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://www.longtermwiki.com',
      'X-Title': 'LongtermWiki Content Pipeline',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: params.max_tokens || 4000,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
    }),
  });

  const data = await response.json() as {
    error?: { message?: string };
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; cost?: number };
  };

  if (!response.ok || data.error) {
    const msg = data.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenRouter error: ${msg}`);
  }

  const text = data.choices[0]?.message?.content || '';
  const usage = {
    input_tokens: data.usage?.prompt_tokens || 0,
    output_tokens: data.usage?.completion_tokens || 0,
  };

  // Record cost
  if (options?.tracker) {
    if (data.usage?.cost) {
      options.tracker.recordExternalCost(model, data.usage.cost, options.label || 'openrouter');
    } else {
      options.tracker.record(model, usage, options.label);
    }
  }

  // Return Anthropic-compatible message shape
  return {
    id: 'openrouter-' + Date.now(),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: data.model || model,
    stop_reason: data.choices[0]?.finish_reason === 'stop' ? 'end_turn' : 'end_turn',
    stop_sequence: null,
    usage,
  } as Anthropic.Messages.Message;
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
  /** If provided, the call's usage is automatically recorded. */
  tracker?: CostTracker;
  /** Label for the cost entry (e.g. "rewrite_section"). */
  label?: string;
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
    tracker,
    label,
  } = options;

  const trackingOptions: StreamingCreateOptions | undefined =
    tracker ? { tracker, label } : undefined;

  const stopHeartbeat = startHeartbeat(heartbeatPhase, 30);
  try {
    const response = await withRetry(
      () => streamingCreate(client, {
        model,
        max_tokens: maxTokens,
        ...(systemPrompt && { system: systemPrompt }),
        ...(temperature !== undefined && { temperature }),
        messages: [{ role: 'user', content: prompt }],
      }, trackingOptions),
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
export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

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
        ...(tools.length > 0 && { tools: tools as Anthropic.Messages.Tool[] }),
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
        const input = (toolUse.input ?? {}) as Record<string, unknown>;
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
