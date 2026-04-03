/**
 * Shared types for political data components.
 *
 * These types are inferred from the wiki-server Hono RPC route definitions
 * via `InferResponseType<>`, ensuring the frontend stays in sync with the
 * server response shapes at compile time.
 */

import type {
  RpcPoliticalScore,
  RpcPoliticalScoresByEntityResult,
  RpcPoliticalOffice,
  RpcPoliticalOfficesByEntityResult,
  RpcCampaignFinanceRecord,
  RpcCampaignFinanceByEntityResult,
  RpcPoliticalVoteRecord,
  RpcPoliticalVotesByEntityResult,
  RpcPoliticalVotesByLegislationResult,
} from "@/lib/wiki-server";

// ── Political Score ──────────────────────────────────────────────────

export type PoliticalScore = RpcPoliticalScore;
export type PoliticalScoresByEntityResponse = RpcPoliticalScoresByEntityResult;

// ── Political Office ─────────────────────────────────────────────────

export type PoliticalOffice = RpcPoliticalOffice;
export type PoliticalOfficesByEntityResponse = RpcPoliticalOfficesByEntityResult;

// ── Campaign Finance ────────────────────────────────────────────────

export type CampaignFinanceRecord = RpcCampaignFinanceRecord;
export type CampaignFinanceByEntityResponse = RpcCampaignFinanceByEntityResult;

// ── Political Vote Record ───────────────────────────────────────────

export type PoliticalVoteRecord = RpcPoliticalVoteRecord;
export type PoliticalVotesByEntityResponse = RpcPoliticalVotesByEntityResult;
export type PoliticalVotesByLegislationResponse = RpcPoliticalVotesByLegislationResult;

// ── UI-only types (not derived from server responses) ───────────────

/** Possible vote values for display styling. */
export type VoteValue = "yea" | "nay" | "abstain" | "not_voting" | "present";

/** Possible office statuses for display styling. */
export type OfficeStatus = "incumbent" | "candidate" | "former";

/** Entity reference shape (inferred from server via the score/office types). */
export type EntityRef = PoliticalScore["politician"];
