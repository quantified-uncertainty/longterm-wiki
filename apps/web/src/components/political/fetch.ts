/**
 * Server-side data fetching helpers for political components.
 *
 * These functions use `fetchFromWikiServer` to call the wiki-server API
 * and should be called from server components (not client components).
 * Pass the fetched data as props to the display components.
 *
 * Usage in a server component (e.g., person page):
 *
 *   import { fetchPoliticalScores, fetchPoliticalOffices } from "@/components/political";
 *   const scores = await fetchPoliticalScores(entity.stableId);
 *   const offices = await fetchPoliticalOffices(entity.stableId);
 *   return (
 *     <>
 *       <ScorecardDisplay scores={scores} />
 *       <OfficeHistory offices={offices} />
 *     </>
 *   );
 */

import { fetchFromWikiServer } from "@/lib/wiki-server";
import type {
  PoliticalScore,
  PoliticalScoresByEntityResponse,
  PoliticalOffice,
  PoliticalOfficesByEntityResponse,
  CampaignFinanceRecord,
  CampaignFinanceByEntityResponse,
  PoliticalVoteRecord,
  PoliticalVotesByEntityResponse,
  PoliticalVotesByLegislationResponse,
} from "./types";

/**
 * Fetch political scorecard ratings for an entity from the wiki-server.
 * Returns an empty array if the server is unavailable or no data exists.
 */
export async function fetchPoliticalScores(
  entityId: string
): Promise<PoliticalScore[]> {
  const data = await fetchFromWikiServer<PoliticalScoresByEntityResponse>(
    `/api/political-scores/by-entity/${encodeURIComponent(entityId)}`,
    { revalidate: 300, timeoutMs: 10_000 }
  );
  return data?.scores ?? [];
}

/**
 * Fetch political office history for an entity from the wiki-server.
 * Returns an empty array if the server is unavailable or no data exists.
 */
export async function fetchPoliticalOffices(
  entityId: string
): Promise<PoliticalOffice[]> {
  const data = await fetchFromWikiServer<PoliticalOfficesByEntityResponse>(
    `/api/political-offices/by-entity/${encodeURIComponent(entityId)}`,
    { revalidate: 300, timeoutMs: 10_000 }
  );
  return data?.offices ?? [];
}

/**
 * Fetch campaign finance records for an entity from the wiki-server.
 * Returns an empty array if the server is unavailable or no data exists.
 */
export async function fetchCampaignFinance(
  entityId: string
): Promise<CampaignFinanceRecord[]> {
  const data = await fetchFromWikiServer<CampaignFinanceByEntityResponse>(
    `/api/campaign-finance/by-entity/${encodeURIComponent(entityId)}`,
    { revalidate: 300, timeoutMs: 10_000 }
  );
  return data?.records ?? [];
}

/**
 * Fetch political vote records for an entity (politician) from the wiki-server.
 * Returns an empty array if the server is unavailable or no data exists.
 */
export async function fetchPoliticalVotes(
  entityId: string
): Promise<PoliticalVoteRecord[]> {
  const data = await fetchFromWikiServer<PoliticalVotesByEntityResponse>(
    `/api/political-votes/by-entity/${encodeURIComponent(entityId)}`,
    { revalidate: 300, timeoutMs: 10_000 }
  );
  return data?.votes ?? [];
}

/**
 * Fetch political vote records for a piece of legislation from the wiki-server.
 * Returns an empty array if the server is unavailable or no data exists.
 */
export async function fetchLegislationVotes(
  legislationEntityId: string
): Promise<PoliticalVoteRecord[]> {
  const data = await fetchFromWikiServer<PoliticalVotesByLegislationResponse>(
    `/api/political-votes/by-legislation/${encodeURIComponent(legislationEntityId)}`,
    { revalidate: 300, timeoutMs: 10_000 }
  );
  return data?.votes ?? [];
}
