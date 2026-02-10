/**
 * Shared Anthropic Client Module
 *
 * Provides a standardized interface for Claude API calls across all scripts.
 * Consolidates API key handling, model selection, error handling, and rate limiting.
 *
 * Usage:
 *   import { createClient, MODELS, callClaude } from './lib/anthropic.ts';
 *
 *   const client = createClient(); // Uses ANTHROPIC_API_KEY from env
 *   const response = await callClaude(client, {
 *     model: MODELS.sonnet,
 *     systemPrompt: '...',
 *     userPrompt: '...',
 *   });
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';

// Load environment variables from multiple possible locations
config({ path: '.env' });
config({ path: '.env.local' });

/**
 * Available Claude models with standardized names
 */
export const MODELS: Record<string, string> = {
  // Fast and cheap - good for high-volume tasks
  haiku: 'claude-3-5-haiku-latest',
  // Balanced - good for most tasks
  sonnet: 'claude-sonnet-4-20250514',
  // Most capable - for complex tasks
  opus: 'claude-opus-4-6',
};

/**
 * Model aliases for backward compatibility
 */
const MODEL_ALIASES: Record<string, string> = {
  'haiku': MODELS.haiku,
  'sonnet': MODELS.sonnet,
  'opus': MODELS.opus,
  'claude-3-5-haiku-latest': MODELS.haiku,
  'claude-3-5-haiku-20241022': MODELS.haiku,
  'claude-sonnet-4-20250514': MODELS.sonnet,
  'claude-sonnet-4-5-20250929': MODELS.sonnet,
  'claude-opus-4-20250514': MODELS.opus,
  'claude-opus-4-5-20251101': MODELS.opus,
  'claude-opus-4-6': MODELS.opus,
};

/**
 * Resolve a model name to the canonical model ID
 */
export function resolveModel(modelName: string): string {
  const resolved = MODEL_ALIASES[modelName] || MODEL_ALIASES[modelName?.toLowerCase()];
  if (!resolved) {
    console.warn(`Unknown model "${modelName}", defaulting to haiku`);
    return MODELS.haiku;
  }
  return resolved;
}

export interface CreateClientOptions {
  apiKey?: string;
  required?: boolean;
}

/**
 * Create an Anthropic client instance
 */
export function createClient({ apiKey, required = true }: CreateClientOptions = {}): Anthropic | null {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;

  if (!key) {
    if (required) {
      console.error('Error: ANTHROPIC_API_KEY not found in environment');
      console.error('Make sure you have a .env or .env.local file with ANTHROPIC_API_KEY=sk-...');
      process.exit(1);
    }
    return null;
  }

  return new Anthropic({ apiKey: key });
}

export interface CallClaudeOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CallClaudeResult {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

/**
 * Call Claude API with standardized error handling
 */
export async function callClaude(client: Anthropic, {
  model,
  systemPrompt,
  userPrompt,
  maxTokens = 2000,
  temperature = 0,
}: CallClaudeOptions): Promise<CallClaudeResult> {
  const modelId = resolveModel(model);

  try {
    const response = await client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ],
    });

    const text = response.content
      .filter((block: { type: string }) => block.type === 'text')
      .map((block: { type: string; text?: string }) => {
        if (block.type === 'text') return block.text || '';
        return '';
      })
      .join('\n');

    return {
      text,
      usage: response.usage,
      model: modelId,
    };
  } catch (error: unknown) {
    // Handle rate limiting
    const apiError = error as { status?: number; headers?: Record<string, string> };
    if (apiError.status === 429) {
      const retryAfter = apiError.headers?.['retry-after'] || '30';
      console.warn(`Rate limited. Retry after ${retryAfter}s`);
      throw new RateLimitError(Number(retryAfter));
    }

    // Handle other API errors
    throw error;
  }
}

/**
 * Custom error for rate limiting
 */
export class RateLimitError extends Error {
  retryAfter: number;

  constructor(retryAfter: number) {
    super(`Rate limited. Retry after ${retryAfter}s`);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface BatchResult<T, I> {
  success: boolean;
  item: I;
  result?: T;
  error?: unknown;
}

export interface ProcessBatchOptions<I> {
  concurrency?: number;
  delayBetweenBatches?: number;
  onProgress?: ((info: { completed: number; total: number; item: I; result?: unknown; error?: unknown }) => void) | null;
}

/**
 * Process items in batches with rate limiting
 */
export async function processBatch<T, I>(
  items: I[],
  processor: (item: I) => Promise<T>,
  {
    concurrency = 3,
    delayBetweenBatches = 200,
    onProgress = null,
  }: ProcessBatchOptions<I> = {},
): Promise<BatchResult<T, I>[]> {
  const results: BatchResult<T, I>[] = [];
  let completed = 0;

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        try {
          const result = await processor(item);
          completed++;
          if (onProgress) {
            onProgress({ completed, total: items.length, item, result });
          }
          return { success: true, item, result } as BatchResult<T, I>;
        } catch (error) {
          completed++;
          if (onProgress) {
            onProgress({ completed, total: items.length, item, error });
          }
          return { success: false, item, error } as BatchResult<T, I>;
        }
      })
    );
    results.push(...batchResults);

    // Delay between batches to avoid rate limiting
    if (i + concurrency < items.length) {
      await sleep(delayBetweenBatches);
    }
  }

  return results;
}

/**
 * Parse JSON from Claude response, handling markdown code blocks
 */
export function parseJsonResponse(text: string): unknown {
  // Remove markdown code blocks if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  return JSON.parse(cleaned);
}

/**
 * Parse YAML from Claude response, handling markdown code blocks
 */
export function parseYamlResponse(text: string, parseYaml: (input: string) => unknown): unknown {
  // Remove markdown code blocks if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```yaml')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  return parseYaml(cleaned);
}
