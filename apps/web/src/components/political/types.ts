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

// ── Campaign Finance ────────────────────────────────────────────────

export interface CampaignFinanceRecord {
  id: string;
  politicianEntityId: string;
  politicianDisplayName: string | null;
  cycle: number;
  totalRaised: number | null;
  totalSpent: number | null;
  cashOnHand: number | null;
  individualContributions: number | null;
  pacContributions: number | null;
  smallDonorContributions: number | null;
  selfFunding: number | null;
  party: string | null;
  officeType: string | null;
  state: string | null;
  district: string | null;
  sourceUrl: string | null;
  dataAsOf: string | null;
}

export interface CampaignFinanceByEntityResponse {
  records: CampaignFinanceRecord[];
  total: number;
}

// ── Political Vote Record ───────────────────────────────────────────

export type VoteValue = "yea" | "nay" | "abstain" | "not_voting" | "present";

export interface PoliticalVoteRecord {
  id: string;
  politicianEntityId: string;
  politicianDisplayName: string | null;
  legislationEntityId: string | null;
  legislationTitle: string | null;
  vote: string;
  voteDate: string | null;
  chamber: string | null;
  rollCallNumber: number | null;
  congressNumber: number | null;
  sourceUrl: string | null;
}

export interface PoliticalVotesByEntityResponse {
  votes: PoliticalVoteRecord[];
  total: number;
}

export interface PoliticalVotesByLegislationResponse {
  votes: PoliticalVoteRecord[];
  total: number;
}
