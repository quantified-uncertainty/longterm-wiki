/**
 * Unit tests for OpenRouterChatResponseSchema (QUA-158 / Tier 3).
 *
 * Validates that the schema accepts real-world OpenRouter response shapes
 * (success + error + provider variants) and rejects clearly malformed
 * payloads.
 */

import { describe, it, expect } from 'vitest';
import { OpenRouterChatResponseSchema } from './openrouter-schemas.ts';

describe('OpenRouterChatResponseSchema', () => {
  it('accepts a typical successful chat-completion response', () => {
    const raw = {
      id: 'gen-123',
      model: 'anthropic/claude-haiku-4-5-20251001',
      choices: [
        {
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = OpenRouterChatResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.choices[0].message.content).toBe('hello');
      expect(result.data.usage?.prompt_tokens).toBe(10);
    }
  });

  it('accepts a Perplexity-style response with citations at the top level', () => {
    const raw = {
      model: 'perplexity/sonar',
      citations: ['https://example.com/a', 'https://example.com/b'],
      choices: [
        {
          message: { content: 'answer with [1] and [2]' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 100, cost: 0.0015 },
    };
    const result = OpenRouterChatResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.citations).toEqual(['https://example.com/a', 'https://example.com/b']);
      expect(result.data.usage?.cost).toBe(0.0015);
    }
  });

  it('accepts an error envelope with no choices field', () => {
    const raw = { error: { message: 'rate limited', code: 429 } };
    const result = OpenRouterChatResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error?.message).toBe('rate limited');
      expect(result.data.choices).toEqual([]);
    }
  });

  it('accepts string-typed error codes (some providers send strings)', () => {
    const raw = { error: { message: 'bad', code: 'unauthorized' } };
    const result = OpenRouterChatResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('accepts null content in a choice message (some models return null)', () => {
    const raw = {
      choices: [{ message: { content: null }, finish_reason: 'tool_use' }],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
      model: 'm',
    };
    const result = OpenRouterChatResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('preserves provider-specific fields via passthrough', () => {
    const raw = {
      id: 'x',
      model: 'm',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      provider: 'anthropic',
      created: 1234567890,
    };
    const result = OpenRouterChatResponseSchema.safeParse(raw);
    expect(result.success).toBe(true);
    // passthrough keeps unknown top-level fields
    if (result.success) {
      expect((result.data as { provider?: string }).provider).toBe('anthropic');
    }
  });

  it('rejects an array at the top level (not an object)', () => {
    const result = OpenRouterChatResponseSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it('rejects a string at the top level (HTML error page parsed as string)', () => {
    const result = OpenRouterChatResponseSchema.safeParse('Internal Server Error');
    expect(result.success).toBe(false);
  });

  it('rejects choices entries that are not objects', () => {
    const raw = { choices: ['not-an-object'] };
    const result = OpenRouterChatResponseSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});
