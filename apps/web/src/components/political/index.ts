/**
 * Political data components for person detail pages and the politicians directory.
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
 *   fetchPoliticalScores,
 *   fetchPoliticalOffices,
 * } from "@/components/political";
 *
 * // Inside the page component:
 * const [scores, offices] = await Promise.all([
 *   fetchPoliticalScores(entity.stableId),
 *   fetchPoliticalOffices(entity.stableId),
 * ]);
 *
 * // Add to the page JSX (e.g., after ExpertPositions):
 * <ScorecardDisplay scores={scores} />
 * <OfficeHistory offices={offices} />
 * ```
 *
 * ### Politicians directory table (apps/web/src/app/people/people-table.tsx)
 *
 * The PoliticianScoresCell is a client component for inline score display
 * with hover tooltip. Pre-fetch scores server-side and pass them as props:
 *
 * ```tsx
 * import { PoliticianScoresCell } from "@/components/political";
 *
 * // In a table cell:
 * <PoliticianScoresCell scores={person.politicalScores ?? []} />
 * ```
 *
 * ### Data fetching
 *
 * The fetch helpers (fetchPoliticalScores, fetchPoliticalOffices) are
 * server-side only -- they use fetchFromWikiServer which accesses env vars
 * and makes backend API calls. Do NOT import them in client components.
 *
 * The display components (ScorecardDisplay, OfficeHistory) are server
 * components that accept data as props. PoliticianScoresCell is the only
 * client component (for tooltip hover state).
 */

// Server-side fetch helpers (import only in server components)
export { fetchPoliticalScores, fetchPoliticalOffices } from "./fetch";

// Display components
export { ScorecardDisplay } from "./scorecard-display";
export type { ScorecardDisplayProps } from "./scorecard-display";

export { OfficeHistory } from "./office-history";
export type { OfficeHistoryProps } from "./office-history";

export { PoliticianScoresCell } from "./politician-scores-cell";
export type { PoliticianScoresCellProps } from "./politician-scores-cell";

// Types (for consumers that need to work with the data)
export type {
  PoliticalScore,
  PoliticalScoresByEntityResponse,
  PoliticalOffice,
  PoliticalOfficesByEntityResponse,
  EntityRef,
  OfficeStatus,
} from "./types";
