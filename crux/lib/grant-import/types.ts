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
  granteeId: string | null;
  name: string;
  amount: number | null;
  currency: string;
  date: string | null;
  status: string | null;
  source: string | null;
  notes: string | null;
}

export interface GrantSource {
  id: string;
  name: string;
  sourceUrl: string;
  ensureData(): void | Promise<void>;
  parse(matcher: EntityMatcher): RawGrant[] | Promise<RawGrant[]>;
  printAnalysis?(grants: RawGrant[]): void;
}
