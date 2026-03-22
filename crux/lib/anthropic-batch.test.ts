/**
 * Tests for anthropic-batch.ts — Anthropic Batch API client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { submitBatch, extractBatchResultText, type BatchRequest, type MessageBatchIndividualResponse } from './anthropic-batch.ts';
import type Anthropic from '@anthropic-ai/sdk';

// Create a mock client factory
function createMockClient(overrides: Record<string, unknown> = {}): Anthropic {
  return {
    messages: {
      batches: {
        create: vi.fn().mockResolvedValue({
          id: 'batch_123',
          processing_status: 'in_progress',
          request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        }),
        retrieve: vi.fn().mockResolvedValue({
          id: 'batch_123',
          processing_status: 'ended',
          request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 },
        }),
        results: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield {
              custom_id: 'page-1',
              result: {
                type: 'succeeded',
                message: {
                  content: [{ type: 'text', text: 'result for page 1' }],
                  usage: { input_tokens: 100, output_tokens: 50 },
                },
              },
            };
          },
        }),
        ...overrides,
      },
    },
  } as unknown as Anthropic;
}

describe('submitBatch', () => {
  it('throws on empty requests array', async () => {
    const client = createMockClient();
    await expect(submitBatch(client, [])).rejects.toThrow('Cannot submit an empty batch');
  });

  it('throws on duplicate customIds', async () => {
    const client = createMockClient();
    const requests: BatchRequest[] = [
      { customId: 'same-id', params: { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] } },
      { customId: 'same-id', params: { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] } },
    ];
    await expect(submitBatch(client, requests)).rejects.toThrow('unique');
  });

  it('calls client.messages.batches.create with correct format', async () => {
    const client = createMockClient();
    const requests: BatchRequest[] = [
      { customId: 'page-1', params: { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'improve page 1' }] } },
      { customId: 'page-2', params: { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'improve page 2' }] } },
    ];

    const result = await submitBatch(client, requests);

    expect(result.id).toBe('batch_123');
    expect(client.messages.batches.create).toHaveBeenCalledWith({
      requests: [
        { custom_id: 'page-1', params: requests[0].params },
        { custom_id: 'page-2', params: requests[1].params },
      ],
    });
  });
});

describe('extractBatchResultText', () => {
  it('returns text from succeeded result', () => {
    const result = {
      custom_id: 'page-1',
      result: {
        type: 'succeeded' as const,
        message: {
          content: [
            { type: 'text' as const, text: 'improved content here' },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        } as Anthropic.Messages.Message,
      },
    };

    expect(extractBatchResultText(result)).toBe('improved content here');
  });

  it('returns null for errored result', () => {
    const result = {
      custom_id: 'page-1',
      result: {
        type: 'errored' as const,
        error: {
          type: 'error' as const,
          request_id: null,
          error: { type: 'api_error' as const, message: 'something went wrong' },
        },
      },
    } as MessageBatchIndividualResponse;

    expect(extractBatchResultText(result)).toBeNull();
  });

  it('returns null for canceled result', () => {
    const result = {
      custom_id: 'page-1',
      result: { type: 'canceled' as const },
    } as MessageBatchIndividualResponse;

    expect(extractBatchResultText(result)).toBeNull();
  });

  it('returns null for expired result', () => {
    const result = {
      custom_id: 'page-1',
      result: { type: 'expired' as const },
    } as MessageBatchIndividualResponse;

    expect(extractBatchResultText(result)).toBeNull();
  });

  it('concatenates multiple text blocks', () => {
    const result = {
      custom_id: 'page-1',
      result: {
        type: 'succeeded' as const,
        message: {
          content: [
            { type: 'text' as const, text: 'part 1' },
            { type: 'text' as const, text: 'part 2' },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        } as Anthropic.Messages.Message,
      },
    };

    expect(extractBatchResultText(result)).toBe('part 1\npart 2');
  });
});
