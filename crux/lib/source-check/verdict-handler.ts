/**
 * Verdict Handler — store source-check evidence and aggregate verdicts.
 *
 * Shared by factbase-source-check and source-check-orchestrate. Handles:
 * - Storing individual source-check evidence via wiki-server API
 * - Storing aggregate verdicts via wiki-server API
 */

import { lookupResourceByUrl } from '../wiki-server/resources.ts';
import { storeEvidence as storeEvidenceRpc, storeVerdict as storeVerdictRpc } from '../wiki-server/source-check-client.ts';
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
  resourceId?: string | null;
  /** Override the default checker model (e.g., 'deterministic-row-match') */
  checkerModel?: string;
}, logPrefix = '[source-check]'): Promise<void> {
  let resolvedResourceId = params.resourceId ?? null;
  if (!resolvedResourceId && params.sourceUrl) {
    try {
      const resource = await lookupResourceByUrl(params.sourceUrl);
      if (resource.ok) {
        resolvedResourceId = resource.data.id;
      }
    } catch {
      // Best-effort: resource lookup failure should not block evidence storage
    }
  }

  // Truncate fields to match server-side schema limits to avoid validation errors
  const extractedValue = params.extractedValue?.slice(0, 2000) ?? null;
  const notes = params.reasoning?.slice(0, 5000) ?? null;
  const recordId = params.recordId?.slice(0, 500) ?? '';

  const body = {
    recordType: params.recordType,
    recordId,
    sourceUrl: params.sourceUrl || null,
    verdict: params.verdict,
    confidence: params.confidence,
    extractedValue,
    checkerModel: params.checkerModel ?? MODELS.haiku,
    notes,
    ...(params.isPrimarySource !== undefined ? { isPrimarySource: params.isPrimarySource } : {}),
    ...(params.entityId ? { entityId: params.entityId } : {}),
    resourceId: resolvedResourceId,
  };

  const response = await storeEvidenceRpc(body);

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

  const response = await storeVerdictRpc(body);

  if (!response.ok) {
    console.warn(`${logPrefix} Failed to store verdict for ${params.recordType}/${params.recordId}: ${response.error}`);
  }
}
