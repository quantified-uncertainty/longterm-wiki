/**
 * Anthropic Batch API Client
 *
 * Wraps the Anthropic Message Batches API for submitting multiple requests
 * at once with 50% cost reduction. Ideal for auto-update which processes
 * 3-10 pages per run.
 *
 * The Batch API processes requests asynchronously. Small batches (3-10 items)
 * typically complete within minutes, while larger batches may take up to 24 hours.
 *
 * Usage:
 *   import { submitBatch, pollBatch, getBatchResults } from './anthropic-batch.ts';
 *
 *   const batch = await submitBatch(client, requests);
 *   const completed = await pollBatch(client, batch.id);
 *   const results = await getBatchResults(client, batch.id);
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  MessageBatch,
  MessageBatchIndividualResponse,
  BatchCreateParams,
} from '@anthropic-ai/sdk/resources/messages/batches';

export type { MessageBatch, MessageBatchIndividualResponse, BatchCreateParams };

/** A single request to include in a batch. */
export interface BatchRequest {
  /** Unique identifier for matching results to requests. */
  customId: string;
  /** Standard Anthropic message creation parameters. */
  params: Anthropic.Messages.MessageCreateParamsNonStreaming;
}

/**
 * Submit a batch of message creation requests to the Anthropic Batch API.
 *
 * @param client - Anthropic SDK client instance
 * @param requests - Array of batch requests with unique customIds
 * @returns The created MessageBatch object with an `id` for polling
 * @throws If the batch creation fails or if requests is empty
 */
export async function submitBatch(
  client: Anthropic,
  requests: BatchRequest[],
): Promise<MessageBatch> {
  if (requests.length === 0) {
    throw new Error('Cannot submit an empty batch');
  }

  // Validate customId uniqueness
  const ids = new Set(requests.map(r => r.customId));
  if (ids.size !== requests.length) {
    throw new Error('All customId values must be unique within a batch');
  }

  const batchRequests: BatchCreateParams['requests'] = requests.map(r => ({
    custom_id: r.customId,
    params: r.params,
  }));

  return client.messages.batches.create({ requests: batchRequests });
}

/**
 * Poll a batch until it completes (all requests succeeded, errored, or expired).
 *
 * @param client - Anthropic SDK client instance
 * @param batchId - The batch ID from submitBatch
 * @param options - Polling configuration
 * @returns The completed MessageBatch object
 * @throws If polling times out
 */
export async function pollBatch(
  client: Anthropic,
  batchId: string,
  options: {
    /** Polling interval in milliseconds (default: 10000 = 10s) */
    intervalMs?: number;
    /** Maximum time to wait in milliseconds (default: 3600000 = 1 hour) */
    timeoutMs?: number;
    /** Called on each poll with the current batch status */
    onPoll?: (batch: MessageBatch) => void;
  } = {},
): Promise<MessageBatch> {
  const { intervalMs = 10_000, timeoutMs = 3_600_000, onPoll } = options;
  const start = Date.now();

  while (true) {
    const batch = await client.messages.batches.retrieve(batchId);

    if (onPoll) onPoll(batch);

    if (batch.processing_status === 'ended') {
      return batch;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Batch ${batchId} did not complete within ${timeoutMs / 1000}s. ` +
        `Status: ${batch.processing_status}, ` +
        `Counts: ${JSON.stringify(batch.request_counts)}`
      );
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/**
 * Retrieve results from a completed batch.
 *
 * @param client - Anthropic SDK client instance
 * @param batchId - The batch ID from submitBatch
 * @returns Map of customId -> individual response (succeeded, errored, canceled, or expired)
 */
export async function getBatchResults(
  client: Anthropic,
  batchId: string,
): Promise<Map<string, MessageBatchIndividualResponse>> {
  const results = new Map<string, MessageBatchIndividualResponse>();

  const decoder = await client.messages.batches.results(batchId);
  for await (const item of decoder) {
    results.set(item.custom_id, item);
  }

  return results;
}

/**
 * Extract text content from a batch result's message.
 * Returns null if the result is not a succeeded message.
 */
export function extractBatchResultText(
  result: MessageBatchIndividualResponse,
): string | null {
  if (result.result.type !== 'succeeded') return null;

  return result.result.message.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

/**
 * High-level convenience: submit a batch, poll until complete, and return results.
 *
 * @param client - Anthropic SDK client instance
 * @param requests - Array of batch requests
 * @param options - Polling options plus optional progress callback
 * @returns Map of customId -> individual response
 */
export async function runBatch(
  client: Anthropic,
  requests: BatchRequest[],
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onPoll?: (batch: MessageBatch) => void;
    onSubmit?: (batch: MessageBatch) => void;
  } = {},
): Promise<Map<string, MessageBatchIndividualResponse>> {
  const batch = await submitBatch(client, requests);
  if (options.onSubmit) options.onSubmit(batch);

  await pollBatch(client, batch.id, {
    intervalMs: options.intervalMs,
    timeoutMs: options.timeoutMs,
    onPoll: options.onPoll,
  });

  return getBatchResults(client, batch.id);
}
