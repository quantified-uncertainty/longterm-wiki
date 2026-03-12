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
   * Despite the name, this stores the human-readable display name (not an entity
   * stableId). The wiki-server grants schema expects this field name, so it cannot
   * be renamed without a coordinated server migration. Compare with RawGrant.granteeId,
   * which IS an entity stableId (or null if unmatched).
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
