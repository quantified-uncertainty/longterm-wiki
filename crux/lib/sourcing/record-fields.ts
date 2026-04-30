/**
 * Record field access utilities — safe accessors for untyped API response objects.
 *
 * Used by factbase-sourcing and sourcing-orchestrate to extract typed values
 * from raw API response rows without runtime type assertions.
 */

import { isAnySid } from '../../../packages/id-utils/src/index.ts';

/** Get a string field value, falling back to String() or empty string */
export function str(item: Record<string, unknown>, key: string): string {
  const v = item[key];
  return typeof v === 'string' ? v : String(v ?? '');
}

/** Get a string field value or null if the field is null/undefined */
export function strOrNull(item: Record<string, unknown>, key: string): string | null {
  const v = item[key];
  return v == null ? null : String(v);
}

/** Get a numeric field value or null if the field is not a number */
export function numOrNull(item: Record<string, unknown>, key: string): number | null {
  const v = item[key];
  return typeof v === 'number' ? v : null;
}

/**
 * Resolve a human-readable name from multiple possible field names.
 * Returns the first non-empty string value found that is not an opaque stableId.
 * Falls back to '(unknown)' if all values are null, empty, or stableId-like.
 */
export function resolveName(item: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = item[key];
    if (typeof v === 'string' && v.length > 0 && !isAnySid(v)) return v;
  }
  return '(unknown)';
}

/**
 * Check if the resolved name is actually usable for LLM sourcing.
 * Returns false for '(unknown)' or stableId-like values that the LLM can't interpret.
 */
export function isResolvableName(name: string): boolean {
  return name.length > 0 && name !== '(unknown)' && !isAnySid(name);
}

/**
 * Extract the entity ID to associate with a record's sourcing verdict.
 *
 * Maps each record type to the most relevant parent entity ID:
 * - Personnel: orgEntityId (org context), falling back to personEntityId
 * - Division: parentOrgId (the parent organization), falling back to organizationId
 * - Grant: orgEntityId (funder), falling back to granteeEntityId
 * - Funding round: companyEntityId
 * - Investment: investorEntityId, falling back to companyEntityId
 * - Equity position: companyEntityId
 * - Funding program: orgEntityId
 * - Policy stakeholder: stakeholderEntityId
 *
 * Returns null if no entity ID is available.
 */
/**
 * Extract the display name for the parent entity (org, company, etc.).
 * Used to persist a human-readable entity name alongside the entity ID in verdicts.
 */
export function extractEntityDisplayName(recordType: string, item: Record<string, unknown>): string | null {
  switch (recordType) {
    case 'personnel':
      return strOrNull(item, 'orgResolvedName') ?? strOrNull(item, 'orgDisplayName') ?? null;
    case 'division':
      return strOrNull(item, 'parentOrgName') ?? strOrNull(item, 'name') ?? null;
    case 'grant':
      return strOrNull(item, 'orgResolvedName') ?? strOrNull(item, 'orgDisplayName') ?? null;
    case 'funding-round':
      return strOrNull(item, 'companyResolvedName') ?? strOrNull(item, 'companyDisplayName') ?? null;
    case 'investment':
      return strOrNull(item, 'investorResolvedName') ?? strOrNull(item, 'investorDisplayName') ?? null;
    case 'equity-position':
      return strOrNull(item, 'companyResolvedName') ?? strOrNull(item, 'companyDisplayName') ?? null;
    case 'funding-program':
      return strOrNull(item, 'orgResolvedName') ?? strOrNull(item, 'orgDisplayName') ?? null;
    case 'policy-stakeholder':
      return strOrNull(item, 'stakeholderResolvedName') ?? strOrNull(item, 'stakeholderDisplayName') ?? null;
    case 'ai-model':
      // QUA-685: entityDisplayName is the model's title (used for grouping
      // rollups by the model's own stableId, see extractEntityId).
      // Returns null (not the slug) when the title is missing — slugs leak
      // into source_check_verdicts.entity_display_name otherwise and render
      // as "claude-2" instead of a human name.
      return strOrNull(item, 'title');
    case 'scorecard_grade':
      // QUA-864: scorecard_grade verdicts roll up under the scored entity
      // (the org being graded), not the publishing scorecard, so each org's
      // sourcing summary aggregates verdicts about its own grades. Use the
      // joined entityTitle when present (human-readable) and only fall back
      // to entityDisplayName — never to the raw stableId — for the same
      // reason ai-model returns null on missing title (avoid sid_ leak).
      return strOrNull(item, 'entityTitle') ?? strOrNull(item, 'entityDisplayName');
    default:
      return null;
  }
}

export function extractEntityId(recordType: string, item: Record<string, unknown>): string | null {
  switch (recordType) {
    case 'personnel':
      return strOrNull(item, 'orgEntityId') ?? strOrNull(item, 'personEntityId');
    case 'division':
      return strOrNull(item, 'parentOrgId') ?? strOrNull(item, 'organizationId');
    case 'grant':
      return strOrNull(item, 'orgEntityId') ?? strOrNull(item, 'granteeEntityId');
    case 'funding-round':
      return strOrNull(item, 'companyEntityId');
    case 'investment':
      return strOrNull(item, 'investorEntityId') ?? strOrNull(item, 'companyEntityId');
    case 'equity-position':
      return strOrNull(item, 'companyEntityId');
    case 'funding-program':
      return strOrNull(item, 'orgEntityId');
    case 'policy-stakeholder':
      return strOrNull(item, 'stakeholderEntityId');
    case 'ai-model':
      // QUA-685: ai-model verdicts group under the model's own stableId, so
      // `fetchEntitySourcingSummary(modelStableId)` returns the model's rollup.
      // This differs from grants/personnel (which group under the parent org)
      // because each ai-model row gets its own dot on the Products & Models table.
      //
      // Side effect: ai-model verdicts do NOT bubble into the developer org's
      // headline rollup verdict. Per-model dots use a separate per-recordId
      // lookup (see apps/web/src/app/organizations/[slug]/page.tsx). Whether to
      // also dual-key by developer is tracked in QUA-870 — keeping the simpler
      // per-model design here pending that decision.
      return strOrNull(item, 'stableId') ?? strOrNull(item, 'id');
    case 'scorecard_grade':
      // QUA-864: scorecard_grade.entityId is already the scored org's stableId
      // (FK to entities.stable_id, see scorecard_grades schema). Verdicts
      // grouped under this entity surface in the org's sourcing rollup
      // alongside its other records, so the org-level dot reflects whether
      // its scorecard cells have been verified.
      return strOrNull(item, 'entityId');
    default:
      return null;
  }
}
