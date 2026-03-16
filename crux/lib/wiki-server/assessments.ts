/**
 * Wiki Server Client — Page Assessments
 *
 * Client library for the /api/assessments endpoint.
 * Uses apiRequest() for test mock compatibility.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { PageAssessment } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types (inferred from server route)
// ---------------------------------------------------------------------------

export interface AssessmentBatchResult {
  inserted: number;
  skipped: number;
}

export interface AssessmentSingleResult {
  id: number;
  assessor: string;
  assessedAt: string;
  pageId: string;
}

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
