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
 * Date when MODELS were last verified as current.
 * validate-models.ts warns if this is more than 60 days old.
 * Update this date after confirming models are still the latest versions.
 */
export const MODELS_LAST_VERIFIED = '2026-02-12';

/**
 * Available Claude models with standardized names
 */
export const MODELS: Record<string, string> = {
  // Fast and cheap - good for high-volume tasks
  haiku: 'claude-haiku-4-5-20251001',
  // Balanced - good for most tasks
  sonnet: 'claude-sonnet-4-5-20250929',
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
  'claude-haiku-4-5-20251001': MODELS.haiku,
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
      throw new Error(
        'ANTHROPIC_API_KEY not found in environment. ' +
        'Make sure you have a .env or .env.local file with ANTHROPIC_API_KEY=sk-...'
      );
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
class RateLimitError extends Error {
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
