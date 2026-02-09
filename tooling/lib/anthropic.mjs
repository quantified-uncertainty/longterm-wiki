/**
 * Shared Anthropic Client Module
 *
 * Provides a standardized interface for Claude API calls across all scripts.
 * Consolidates API key handling, model selection, error handling, and rate limiting.
 *
 * Usage:
 *   import { createClient, MODELS, callClaude } from './lib/anthropic.mjs';
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
export const MODELS = {
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
const MODEL_ALIASES = {
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
 * @param {string} modelName - Model name or alias
 * @returns {string} Canonical model ID
 */
export function resolveModel(modelName) {
  const resolved = MODEL_ALIASES[modelName] || MODEL_ALIASES[modelName?.toLowerCase()];
  if (!resolved) {
    console.warn(`Unknown model "${modelName}", defaulting to haiku`);
    return MODELS.haiku;
  }
  return resolved;
}

/**
 * Create an Anthropic client instance
 * @param {Object} options
 * @param {string} [options.apiKey] - API key (defaults to ANTHROPIC_API_KEY env var)
 * @param {boolean} [options.required=true] - If true, throws if no API key found
 * @returns {Anthropic|null} Anthropic client or null if no key and not required
 */
export function createClient({ apiKey, required = true } = {}) {
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

/**
 * Call Claude API with standardized error handling
 * @param {Anthropic} client - Anthropic client instance
 * @param {Object} options
 * @param {string} options.model - Model name (haiku, sonnet, opus, or full model ID)
 * @param {string} options.systemPrompt - System prompt
 * @param {string} options.userPrompt - User prompt
 * @param {number} [options.maxTokens=2000] - Max tokens in response
 * @param {number} [options.temperature=0] - Temperature (0-1)
 * @returns {Promise<{text: string, usage: Object}>} Response text and usage stats
 */
export async function callClaude(client, {
  model,
  systemPrompt,
  userPrompt,
  maxTokens = 2000,
  temperature = 0,
}) {
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
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return {
      text,
      usage: response.usage,
      model: modelId,
    };
  } catch (error) {
    // Handle rate limiting
    if (error.status === 429) {
      const retryAfter = error.headers?.['retry-after'] || 30;
      console.warn(`Rate limited. Retry after ${retryAfter}s`);
      throw new RateLimitError(retryAfter);
    }

    // Handle other API errors
    throw error;
  }
}

/**
 * Custom error for rate limiting
 */
export class RateLimitError extends Error {
  constructor(retryAfter) {
    super(`Rate limited. Retry after ${retryAfter}s`);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process items in batches with rate limiting
 * @param {Array} items - Items to process
 * @param {Function} processor - Async function to process each item
 * @param {Object} options
 * @param {number} [options.concurrency=3] - Max concurrent requests
 * @param {number} [options.delayBetweenBatches=200] - Delay between batches in ms
 * @param {Function} [options.onProgress] - Callback for progress updates
 * @returns {Promise<Array>} Results for each item
 */
export async function processBatch(items, processor, {
  concurrency = 3,
  delayBetweenBatches = 200,
  onProgress = null,
} = {}) {
  const results = [];
  let completed = 0;

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (item, idx) => {
        try {
          const result = await processor(item);
          completed++;
          if (onProgress) {
            onProgress({ completed, total: items.length, item, result });
          }
          return { success: true, item, result };
        } catch (error) {
          completed++;
          if (onProgress) {
            onProgress({ completed, total: items.length, item, error });
          }
          return { success: false, item, error };
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
 * @param {string} text - Response text
 * @returns {Object} Parsed JSON
 */
export function parseJsonResponse(text) {
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
 * @param {string} text - Response text
 * @param {Function} parseYaml - YAML parser function
 * @returns {Object} Parsed YAML
 */
export function parseYamlResponse(text, parseYaml) {
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
