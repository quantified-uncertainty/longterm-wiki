/**
 * Political data components for person detail pages, legislation pages,
 * and the politicians directory.
 *
 * ## Integration Guide
 *
 * ### Person detail page (apps/web/src/app/people/[slug]/page.tsx)
 *
 * Import the fetch helpers and display components, then add them inside the
 * person page's server component:
 *
 * ```tsx
 * import {
 *   ScorecardDisplay,
 *   OfficeHistory,
 *   CampaignFinance,
 *   VoteRecord,
 *   fetchPoliticalScores,
 *   fetchPoliticalOffices,
 *   fetchCampaignFinance,
 *   fetchPoliticalVotes,
 * } from "@/components/political";
 *
 * // Inside the page component:
 * const [scores, offices, finance, votes] = await Promise.all([
 *   fetchPoliticalScores(entity.stableId),
 *   fetchPoliticalOffices(entity.stableId),
 *   fetchCampaignFinance(entity.stableId),
 *   fetchPoliticalVotes(entity.stableId),
 * ]);
 *
 * // Add to the page JSX:
 * <ScorecardDisplay scores={scores} />
 * <OfficeHistory offices={offices} />
 * <CampaignFinance records={finance} />
 * <VoteRecord votes={votes} />
 * ```
 *
 * ### Legislation detail page
 *
 * ```tsx
 * import { LegislationVotes, fetchLegislationVotes } from "@/components/political";
 *
 * const votes = await fetchLegislationVotes(entity.stableId);
 * <LegislationVotes votes={votes} />
 * ```
 *
 * ### Politicians directory table (apps/web/src/app/people/people-table.tsx)
 *
 * The PoliticianScoresCell and CampaignFinanceCell are client components
 * for inline display with hover tooltips. Pre-fetch data server-side and
 * pass as props:
 *
 * ```tsx
 * import { PoliticianScoresCell, CampaignFinanceCell } from "@/components/political";
 *
 * // In a table cell:
 * <PoliticianScoresCell scores={person.politicalScores ?? []} />
 * <CampaignFinanceCell records={person.campaignFinance ?? []} />
 * ```
 *
 * ### Data fetching
 *
 * The fetch helpers (fetchPoliticalScores, fetchPoliticalOffices,
 * fetchCampaignFinance, fetchPoliticalVotes, fetchLegislationVotes) are
 * server-side only -- they use fetchFromWikiServer which accesses env vars
 * and makes backend API calls. Do NOT import them in client components.
 *
 * The display components (ScorecardDisplay, OfficeHistory, CampaignFinance,
 * VoteRecord, LegislationVotes) are server components that accept data as
 * props. PoliticianScoresCell and CampaignFinanceCell are the client
 * components (for tooltip hover state).
 */

// Server-side fetch helpers (import only in server components)
export {
  fetchPoliticalScores,
  fetchPoliticalOffices,
  fetchCampaignFinance,
  fetchPoliticalVotes,
  fetchLegislationVotes,
} from "./fetch";

// Display components
export { ScorecardDisplay } from "./scorecard-display";
export type { ScorecardDisplayProps } from "./scorecard-display";

export { OfficeHistory } from "./office-history";
export type { OfficeHistoryProps } from "./office-history";

export { PoliticianScoresCell } from "./politician-scores-cell";
export type { PoliticianScoresCellProps } from "./politician-scores-cell";

export { CampaignFinance } from "./campaign-finance";
export type { CampaignFinanceProps } from "./campaign-finance";

export { VoteRecord } from "./vote-record";
export type { VoteRecordProps } from "./vote-record";

export { LegislationVotes } from "./legislation-votes";
export type { LegislationVotesProps } from "./legislation-votes";

export { CampaignFinanceCell } from "./finance-cell";
export type { CampaignFinanceCellProps } from "./finance-cell";

// Types (for consumers that need to work with the data)
export type {
  PoliticalScore,
  PoliticalScoresByEntityResponse,
  PoliticalOffice,
  PoliticalOfficesByEntityResponse,
  CampaignFinanceRecord,
  CampaignFinanceByEntityResponse,
  PoliticalVoteRecord,
  PoliticalVotesByEntityResponse,
  PoliticalVotesByLegislationResponse,
  VoteValue,
  EntityRef,
  OfficeStatus,
} from "./types";
