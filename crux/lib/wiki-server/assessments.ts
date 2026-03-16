/**
 * Wiki Server Client — Page Assessments
 *
 * Client library for the /api/assessments endpoint.
 * Uses apiRequest() for test mock compatibility.
 * Response types inferred from server route via Hono RPC.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { PageAssessment } from '../../../apps/wiki-server/src/api-types.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { AssessmentsRoute } from '../../../apps/wiki-server/src/routes/wikibase/assessments.ts';

// ---------------------------------------------------------------------------
// Types (inferred from server route via Hono RPC)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<AssessmentsRoute>>;
export type AssessmentBatchResult = InferResponseType<RpcClient['batch']['$post'], 201>;
export type AssessmentSingleResult = InferResponseType<RpcClient['index']['$post'], 201>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Record a single assessment to the wiki-server.
 */
export async function recordAssessment(
  data: PageAssessment,
): Promise<ApiResult<AssessmentSingleResult>> {
  return apiRequest<AssessmentSingleResult>('POST', '/api/assessments', data);
}

/**
 * Record a batch of assessments to the wiki-server.
 */
export async function recordAssessmentBatch(
  items: PageAssessment[],
): Promise<ApiResult<AssessmentBatchResult>> {
  return apiRequest<AssessmentBatchResult>('POST', '/api/assessments/batch', { items });
}
