/**
 * Record field access utilities — safe accessors for untyped API response objects.
 *
 * Used by factbase-source-check and source-check-orchestrate to extract typed values
 * from raw API response rows without runtime type assertions.
 */

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
 * Returns the first non-empty string value found, or '(unknown)'.
 */
export function resolveName(item: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = item[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '(unknown)';
}

/**
 * Extract the entity ID to associate with a record's verification verdict.
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
    default:
      return null;
  }
}
