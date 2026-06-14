/**
 * LLM Call Payloads API — wiki-server client (model-swap eval, step 1b).
 *
 * Mirrors pipeline-runs.ts: response types are inferred from the Hono RPC
 * route via InferResponseType<>, no raw `apiRequest<T>` with hand-written
 * generics. Used by the capture path in `crux/lib/llm-usage/capture-payload.ts`.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { LlmPayloadsRoute } from '../../../apps/wiki-server/src/routes/operational/llm-payloads.ts';

type RpcClient = ReturnType<typeof hc<LlmPayloadsRoute>>;

export type LlmPayloadRecorded = InferResponseType<RpcClient['index']['$post'], 201>;
export type LlmPayloadsListResult = InferResponseType<RpcClient['index']['$get'], 200>;
export type LlmPayloadRow = LlmPayloadsListResult['payloads'][number];

export interface RecordLlmPayloadInput {
  runId?: string | null;
  flow?: string | null;
  label?: string | null;
  model: string;
  viaOpenrouter?: boolean;
  request: Record<string, unknown>;
  response: string;
  tokensInput?: number | null;
  tokensOutput?: number | null;
}

/** Record one captured LLM call. */
export async function recordLlmPayload(
  input: RecordLlmPayloadInput,
): Promise<ApiResult<LlmPayloadRecorded>> {
  return apiRequest<LlmPayloadRecorded>('POST', '/api/llm-payloads', input);
}

/** List captured calls (filter by flow / model) for replay. */
export async function listLlmPayloads(options?: {
  flow?: string;
  model?: string;
  limit?: number;
}): Promise<ApiResult<LlmPayloadsListResult>> {
  const params = new URLSearchParams();
  if (options?.flow) params.set('flow', options.flow);
  if (options?.model) params.set('model', options.model);
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<LlmPayloadsListResult>('GET', `/api/llm-payloads${qs ? `?${qs}` : ''}`);
}
