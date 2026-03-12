export interface EntityMatch {
  stableId: string;
  slug: string;
  name: string;
}

export interface EntityMatcher {
  match: (name: string) => EntityMatch | null;
  allNames: Map<string, EntityMatch>;
}

export interface RawGrant {
  source: string;
  funderId: string;
  granteeName: string;
  /**
   * Matched entity stableId (e.g. "OwXl35e7bg") from the entity matcher,
   * or null if the grantee name could not be matched to a known entity.
   * Used by toSyncGrant() to populate SyncGrant.granteeId.
   */
  granteeId: string | null;
  name: string;
  amount: number | null;
  /** ISO 4217 currency code. Defaults to "USD" if omitted. */
  currency?: string;
  date: string | null;
  focusArea: string | null;
  description: string | null;
  sourceUrl?: string | null;
}

export interface SyncGrant {
  id: string;
  organizationId: string;
  /**
   * Entity stableId when the grantee was matched to a known entity (e.g. "OwXl35e7bg"),
   * or the raw display name as a fallback when no entity match was found.
   * Compare with organizationId which is always an entity stableId.
   */
  granteeId: string | null;
  name: string;
  amount: number | null;
  currency: string;
  date: string | null;
  status: string | null;
  source: string | null;
  notes: string | null;
  /** Soft reference to funding_programs.id (nullable -- most grants won't have one) */
  programId?: string | null;
}

export interface GrantSource {
  id: string;
  name: string;
  sourceUrl: string;
  ensureData(): void | Promise<void>;
  parse(matcher: EntityMatcher): RawGrant[] | Promise<RawGrant[]>;
  printAnalysis?(grants: RawGrant[]): void;
}
