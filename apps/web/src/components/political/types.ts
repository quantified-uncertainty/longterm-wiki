/**
 * Shared types for political data components.
 *
 * These types mirror the response shapes from the wiki-server
 * political-scores and political-offices API endpoints.
 */

// ── Political Score ──────────────────────────────────────────────────

export interface EntityRef {
  entityId: string | null;
  slug: string | null;
  name: string | null;
}

export interface PoliticalScore {
  id: string;
  politicianEntityId: string;
  politicianDisplayName: string | null;
  politician: EntityRef;
  scorerOrg: string;
  scorerEntityId: string | null;
  scorer: EntityRef;
  score: number;
  maxScore: number;
  year: number;
  scoreType: string | null;
  sourceUrl: string | null;
  notes: string | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PoliticalScoresByEntityResponse {
  scores: PoliticalScore[];
  total: number;
}

// ── Political Office ─────────────────────────────────────────────────

export type OfficeStatus = "incumbent" | "candidate" | "former";

export interface PoliticalOffice {
  id: string;
  politicianEntityId: string;
  politicianDisplayName: string | null;
  politician: EntityRef;
  officeType: string;
  jurisdiction: string;
  district: string | null;
  party: string | null;
  status: string;
  termStart: string | null;
  termEnd: string | null;
  sourceUrl: string | null;
  notes: string | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PoliticalOfficesByEntityResponse {
  offices: PoliticalOffice[];
  total: number;
}
