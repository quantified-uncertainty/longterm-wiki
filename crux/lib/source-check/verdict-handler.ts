/**
 * Verdict Handler — store source-check evidence and aggregate verdicts.
 *
 * Shared by factbase-source-check and source-check-orchestrate. Handles:
 * - Storing individual source-check evidence via wiki-server API
 * - Storing aggregate verdicts via wiki-server API
 */

import { apiRequest } from '../wiki-server/client.ts';
import { MODELS } from '../llm.ts';
import type { SourceCheckVerdict, RecordType } from '../../../apps/wiki-server/src/api-types.ts';

/**
 * Store individual source-check evidence in the wiki-server.
 *
 * @param params - Evidence parameters
 * @param logPrefix - Prefix for warning messages (default: '[source-check]')
 */
export async function storeSourceCheckEvidence(params: {
  recordType: RecordType | 'fact';
  recordId: string;
  sourceUrl: string;
  verdict: SourceCheckVerdict | string;
  confidence: number;
  extractedValue: string;
  reasoning: string;
  isPrimarySource?: boolean;
  /** Entity ID to associate with this evidence (e.g., org stableId for personnel/division records) */
  entityId?: string | null;
}, logPrefix = '[source-check]'): Promise<void> {
  const body = {
    recordType: params.recordType,
    recordId: params.recordId,
    sourceUrl: params.sourceUrl,
    verdict: params.verdict,
    confidence: params.confidence,
    extractedValue: params.extractedValue,
    checkerModel: MODELS.haiku,
    notes: params.reasoning,
    ...(params.isPrimarySource !== undefined ? { isPrimarySource: params.isPrimarySource } : {}),
    ...(params.entityId ? { entityId: params.entityId } : {}),
  };

  const response = await apiRequest<{ id: number; verdictFlagged: boolean }>(
    'POST',
    '/api/verifications/evidence',
    body,
  );

  if (!response.ok) {
    console.warn(`${logPrefix} Failed to store evidence for ${params.recordType}/${params.recordId}: ${response.error}`);
  }
}

/**
 * Store an aggregate verdict for a record.
 *
 * @param params - Verdict parameters
 * @param logPrefix - Prefix for warning messages (default: '[source-check]')
 */
export async function storeAggregateVerdict(params: {
  recordType: RecordType | 'fact';
  recordId: string;
  verdict: SourceCheckVerdict | string;
  confidence: number;
  reasoning: string;
  sourcesChecked: number;
  /** Entity ID to associate with this verdict (e.g., org stableId for personnel/division records) */
  entityId?: string | null;
  /** Human-readable record name (persisted in verdict, survives record deletion) */
  displayName?: string | null;
  /** Human-readable entity name (persisted in verdict, survives record deletion) */
  entityDisplayName?: string | null;
}, logPrefix = '[source-check]'): Promise<void> {
  const body = {
    recordType: params.recordType,
    recordId: params.recordId,
    verdict: params.verdict,
    confidence: params.confidence,
    reasoning: params.reasoning,
    sourcesChecked: params.sourcesChecked,
    ...(params.entityId ? { entityId: params.entityId } : {}),
    ...(params.displayName ? { displayName: params.displayName } : {}),
    ...(params.entityDisplayName ? { entityDisplayName: params.entityDisplayName } : {}),
  };

  const response = await apiRequest<{ ok: boolean }>(
    'POST',
    '/api/verifications/verdicts',
    body,
  );

  if (!response.ok) {
    console.warn(`${logPrefix} Failed to store verdict for ${params.recordType}/${params.recordId}: ${response.error}`);
  }
}
