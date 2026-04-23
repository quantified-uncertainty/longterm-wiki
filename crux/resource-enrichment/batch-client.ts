/**
 * Anthropic Batch API Client
 *
 * Wraps the Anthropic Message Batches API for resource enrichment.
 * Uses the 50% discount batch processing with up to 10K requests per batch.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/message-batches
 */

import { getApiKey } from '../lib/api-keys.ts';
import { sleep } from '../resource-utils.ts';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';

export interface BatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    system?: string;
  };
}

/** Anthropic Batch API custom_id constraint: [a-zA-Z0-9_-]{1,64} */
const CUSTOM_ID_VALID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Sanitize a string for use as a Batch API custom_id.
 * Replaces any character outside [a-zA-Z0-9_-] with underscore and truncates to 64 chars.
 */
export function sanitizeBatchCustomId(raw: string): string {
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (sanitized.length === 0) {
    throw new Error(`Cannot sanitize empty or all-invalid custom_id: "${raw}"`);
  }
  return sanitized;
}

export interface BatchStatus {
  id: string;
  type: 'message_batch';
  processing_status: 'in_progress' | 'canceling' | 'ended';
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  created_at: string;
  ended_at: string | null;
  results_url: string | null;
}

export interface BatchResultItem {
  custom_id: string;
  result: {
    type: 'succeeded' | 'errored' | 'canceled' | 'expired';
    message?: {
      content: Array<{ type: 'text'; text: string }>;
    };
    error?: { type: string; message: string };
  };
}

function getAnthropicKey(): string {
  const key = getApiKey('ANTHROPIC_BILLING_KEY');
  if (!key) throw new Error('ANTHROPIC_BILLING_KEY not set');
  return key;
}

/**
 * Create a message batch. Returns the batch ID for polling.
 */
export async function createBatch(requests: BatchRequest[]): Promise<string> {
  // Validate custom_id format — Anthropic requires [a-zA-Z0-9_-]{1,64}
  const invalid = requests.filter(r => !CUSTOM_ID_VALID.test(r.custom_id));
  if (invalid.length > 0) {
    const examples = invalid.slice(0, 3).map(r => `"${r.custom_id}"`).join(', ');
    throw new Error(
      `${invalid.length} custom_id(s) contain invalid characters (must match [a-zA-Z0-9_-]{1,64}): ${examples}. ` +
      `Use sanitizeBatchCustomId() to fix.`
    );
  }

  const apiKey = getAnthropicKey();

  const response = await fetch(`${ANTHROPIC_API_BASE}/messages/batches`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Batch creation failed (${response.status}): ${error}`);
  }

  const data = await response.json() as BatchStatus;
  console.log(`  Created batch ${data.id} with ${requests.length} requests`);
  return data.id;
}

/**
 * Check the status of a batch.
 */
export async function getBatchStatus(batchId: string): Promise<BatchStatus> {
  const apiKey = getAnthropicKey();

  const response = await fetch(`${ANTHROPIC_API_BASE}/messages/batches/${batchId}`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Batch status check failed (${response.status}): ${error}`);
  }

  return response.json() as Promise<BatchStatus>;
}

/**
 * Poll until a batch completes. Returns the final status.
 */
export async function pollBatch(
  batchId: string,
  intervalMs = 30000,
  maxWaitMs = 3600000,
): Promise<BatchStatus> {
  const start = Date.now();

  while (true) {
    const status = await getBatchStatus(batchId);

    if (status.processing_status === 'ended') {
      const counts = status.request_counts;
      console.log(`  Batch ${batchId} ended:`);
      console.log(`    Succeeded: ${counts.succeeded}`);
      console.log(`    Errored:   ${counts.errored}`);
      console.log(`    Canceled:  ${counts.canceled}`);
      console.log(`    Expired:   ${counts.expired}`);
      return status;
    }

    if (Date.now() - start > maxWaitMs) {
      throw new Error(`Batch ${batchId} timed out after ${maxWaitMs / 1000}s`);
    }

    const counts = status.request_counts;
    console.log(
      `  Batch ${batchId}: processing ${counts.processing}, ` +
        `done ${counts.succeeded + counts.errored}/${counts.processing + counts.succeeded + counts.errored}`,
    );

    await sleep(intervalMs);
  }
}

/**
 * Download batch results. Returns parsed result items.
 */
export async function downloadBatchResults(batchId: string): Promise<BatchResultItem[]> {
  const apiKey = getAnthropicKey();

  const status = await getBatchStatus(batchId);
  if (!status.results_url) {
    throw new Error(`Batch ${batchId} has no results URL (status: ${status.processing_status})`);
  }

  const response = await fetch(status.results_url, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Results download failed (${response.status}): ${error}`);
  }

  // Results are JSONL (one JSON object per line)
  const text = await response.text();
  const lines = text.trim().split('\n');
  return lines.map((line) => JSON.parse(line) as BatchResultItem);
}
