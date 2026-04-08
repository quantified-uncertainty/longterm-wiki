/**
 * Shared types for the source-check orchestrator.
 * Used by orchestrator.ts, item-collectors.ts, item-verifier.ts, and the command wrapper.
 */

import type { CommandOptions as BaseOptions } from '../command-types.ts';
import type { Entity } from '../content-types.ts';
import type { PageEntry } from '../content-types.ts';
import type { Fact, Entity as FBEntity } from '../../../packages/factbase/src/types.ts';
import type { SourceFetchErrorType } from '../search/paywall-detection.ts';
import type { SourceCheckVerdict, RecordType } from '../../../apps/wiki-server/src/api-types.ts';

export interface OrchestrateOptions extends BaseOptions {
  budget?: string;
  limit?: string;
  type?: string;
  /** Filter to a specific record type (e.g. personnel, grant, funding-round) */
  table?: string;
  'entity-type'?: string;
  entityType?: string;
  /** Filter to a specific entity by stableId */
  entity?: string;
  source?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  ci?: boolean;
  concurrency?: string;
  /** Use Anthropic Batch API for 50% cost savings (async, may take minutes to hours) */
  batch?: boolean;
}

export type VerifyItemKind = 'fact' | 'record' | 'entity';

export interface VerifyItem {
  kind: VerifyItemKind;
  /** Unique ID for deduplication */
  id: string;
  /** Human-readable description */
  description: string;
  /** Entity type (organization, person, etc.) */
  entityType: string;
  /** Entity name */
  entityName: string;
  /** Priority score (higher = verify first) */
  priority: number;
  /** Source URL if available */
  sourceUrl?: string;
  /** Whether this item has never been verified */
  neverVerified: boolean;
  /** Last source-check timestamp (ISO string) if available */
  lastVerifiedAt?: string;
  /**
   * For facts: the fact + entity data.
   * For records: the record data.
   * For entities: the entity data.
   */
  data: FactItemData | RecordItemData | EntityItemData;
}

export interface FactItemData {
  kind: 'fact';
  entity: FBEntity;
  fact: Fact;
  propertyName: string;
  formattedValue: string;
}

export interface RecordItemData {
  kind: 'record';
  recordType: RecordType;
  recordId: string;
  fields: Record<string, string | number | null>;
  /** Entity ID for the parent entity (org for personnel/divisions, company for funding-rounds, etc.) */
  entityId?: string | null;
  /** Human-readable record description (persisted in verdict for name resolution) */
  displayName?: string | null;
  /** Human-readable entity name (persisted in verdict for name resolution) */
  entityDisplayName?: string | null;
}

export interface EntityItemData {
  kind: 'entity';
  entity: Entity;
  page?: PageEntry;
}

export interface VerifyResult {
  itemId: string;
  kind: VerifyItemKind;
  description: string;
  verdict: SourceCheckVerdict;
  confidence: number;
  extractedValue: string;
  reasoning: string;
  sourceUrl: string;
  errorType?: SourceFetchErrorType;
  /** 'deterministic-row-match' for snapshot matching, or undefined for LLM */
  checkerModel?: string;
}

export interface VerifyError {
  itemId: string;
  kind: VerifyItemKind;
  description: string;
  error: string;
  errorType?: SourceFetchErrorType;
}

export interface OrchestrationSummary {
  total: number;
  confirmed: number;
  contradicted: number;
  unverifiable: number;
  outdated: number;
  partial: number;
  errors: number;
  /** Number of items skipped because source URL is dead (subset of unverifiable) */
  deadLinks: number;
  /**
   * Number of items where the verdict was computed but the storage call
   * (storeSourceCheckEvidence/storeAggregateVerdict) failed. The verdict
   * was lost — operators should re-run the check after the underlying
   * issue is fixed. Drives a non-zero exit code. Issue #4017.
   */
  storageErrors: number;
  estimatedCost: number;
  actualVerified: number;
  byKind: Record<VerifyItemKind, { total: number; verified: number }>;
  results: VerifyResult[];
  failures: VerifyError[];
}

export interface SourceCheckedFactInfo {
  factId: string;
  verdict: string;
  checkedAt?: string;
  needsRecheck?: boolean;
}

export interface SourceCheckedRecordInfo {
  recordType: string;
  recordId: string;
  verdict: string;
  checkedAt?: string;
  needsRecheck?: boolean;
}

/** Entity types ordered by change frequency (most volatile first) */
export const ENTITY_TYPE_PRIORITY: string[] = [
  'ai-model',
  'organization',
  'person',
  'project',
  'policy',
  'event',
  'approach',
  'benchmark',
  'concept',
  'risk',
  'analysis',
  'capability',
  'safety-agenda',
  'crux',
  'historical',
];

/** Limit passed to wiki-server /all endpoints (must respect server-side MAX_PAGE_SIZE of 200) */
export const API_PAGE_LIMIT = 200;
