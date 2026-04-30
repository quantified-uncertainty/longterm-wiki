/**
 * OpenRouter Response Schemas (QUA-158 / Tier 3)
 *
 * Side-effect-free Zod schemas for OpenRouter chat-completions responses.
 * Lives in its own file so importing the schemas doesn't transitively pull
 * in `openrouter.ts`'s module-load `dotenv.config()` + `getApiKey()` calls,
 * which would force tests that mock `getApiKey` to satisfy the mock at
 * top-of-file initialization.
 *
 * Both `crux/lib/openrouter.ts` (Perplexity research) and `crux/lib/llm.ts`
 * (OpenRouter-mode Anthropic routing) import from here.
 */

import { z } from 'zod';

/** Error body returned by OpenRouter when a request fails. */
const OpenRouterErrorSchema = z.object({
  message: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
}).passthrough();

const OpenRouterChoiceSchema = z.object({
  message: z.object({
    content: z.string().nullable().optional().default(''),
    citations: z.array(z.string()).optional(),
  }).passthrough(),
  finish_reason: z.string().nullable().optional(),
}).passthrough();

const OpenRouterUsageSchema = z.object({
  prompt_tokens: z.number().nullable().optional(),
  completion_tokens: z.number().nullable().optional(),
  total_tokens: z.number().nullable().optional(),
  cost: z.number().nullable().optional(),
}).passthrough();

/**
 * Successful chat-completions response from OpenRouter.
 * Validates the outer envelope; per-provider variation (Perplexity citations,
 * Gemini token counts, etc.) flows through via `passthrough()`.
 */
export const OpenRouterChatResponseSchema = z.object({
  error: OpenRouterErrorSchema.optional(),
  citations: z.array(z.string()).optional(),
  choices: z.array(OpenRouterChoiceSchema).optional().default([]),
  model: z.string().optional().default(''),
  usage: OpenRouterUsageSchema.optional().default({}),
}).passthrough();

export type OpenRouterChatResponse = z.infer<typeof OpenRouterChatResponseSchema>;
