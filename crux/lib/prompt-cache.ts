/**
 * Prompt Caching Utilities
 *
 * Anthropic's prompt caching uses `cache_control` blocks on the system prompt.
 * When the same system prompt prefix is sent within 5 minutes, cached input
 * tokens are billed at 90% discount (0.1x price). The first request pays a 25%
 * premium on the cached portion for cache writes.
 *
 * Strategy: split the system prompt into a static prefix (wiki conventions,
 * objectivity rules, biographical accuracy rules — the same for every page)
 * and a dynamic suffix (page-specific content, entity lookups, KB facts).
 * Mark the static prefix with cache_control: { type: "ephemeral" }.
 *
 * Usage:
 *   import { buildCachedSystemPrompt } from './prompt-cache.ts';
 *
 *   const system = buildCachedSystemPrompt(staticGuidelines, dynamicContext);
 *   // Pass `system` as the `system` parameter to Anthropic API
 */

import type Anthropic from '@anthropic-ai/sdk';

// Re-export STATIC_IMPROVE_GUIDELINES from the single source of truth in prompts.ts.
// This avoids duplication — prompts.ts owns the canonical text, and this module
// just re-exports it for convenience alongside the caching utilities.
export { STATIC_IMPROVE_GUIDELINES } from '../authoring/page-improver/phases/prompts.ts';

type TextBlockParam = Anthropic.Messages.TextBlockParam;

/**
 * Build a system prompt with cache_control on the static prefix.
 *
 * The Anthropic API accepts `system` as either a string or an array of
 * content blocks. When prompt caching is desired, we use the array form
 * and mark the static portion with `cache_control: { type: "ephemeral" }`.
 *
 * @param staticPrefix - Guidelines that are identical across all pages
 *   (wiki conventions, objectivity rules, etc.). Cached after first call.
 * @param dynamicSuffix - Page-specific content (entity lookup, KB facts,
 *   current content, etc.). Never cached.
 * @returns Array of TextBlockParam suitable for the `system` parameter
 */
export function buildCachedSystemPrompt(
  staticPrefix: string,
  dynamicSuffix: string,
): TextBlockParam[] {
  const blocks: TextBlockParam[] = [];

  if (staticPrefix) {
    blocks.push({
      type: 'text',
      text: staticPrefix,
      cache_control: { type: 'ephemeral' },
    });
  }

  if (dynamicSuffix) {
    blocks.push({
      type: 'text',
      text: dynamicSuffix,
    });
  }

  return blocks;
}

/**
 * Check if a system prompt content block array uses prompt caching.
 */
export function hasCacheControl(
  system: string | TextBlockParam[] | undefined,
): boolean {
  if (!system || typeof system === 'string') return false;
  return system.some(block => block.cache_control != null);
}
