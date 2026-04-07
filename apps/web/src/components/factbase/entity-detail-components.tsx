/**
 * Barrel re-export for backward compatibility.
 *
 * This file was split into domain-focused modules:
 *   - entity-detail-shared.ts      — types, constants, helpers
 *   - entity-verdict.tsx            — VerdictBadge, SourceCheckSummary
 *   - entity-fact-display.tsx       — SourceCell, FactValueDisplay, StatCard, CategoryFactSection
 *   - entity-section-header.tsx     — SectionHeader
 *   - entity-person-cards.tsx       — PersonCard
 *   - entity-collection-records.tsx — FundingRoundRow, ProductCard, ModelReleaseRow
 *   - entity-collection-table.tsx   — GenericCollectionTable
 *
 * Prefer importing directly from the specific module for new code.
 */

export type { VerdictRow, VerdictsResponse, VerdictType } from "./entity-detail-shared";
export {
  VERDICT_STYLES,
  HERO_STAT_PROPERTIES,
  SPECIAL_COLLECTIONS,
  field,
  sortByDateField,
} from "./entity-detail-shared";

export { VerdictBadge, SourceCheckSummary } from "./entity-verdict";
export { SourceCell, FactValueDisplay, StatCard, CategoryFactSection } from "./entity-fact-display";
export { SectionHeader } from "./entity-section-header";
export { PersonCard } from "./entity-person-cards";
export { FundingRoundRow, ProductCard, ModelReleaseRow } from "./entity-collection-records";
export { GenericCollectionTable } from "./entity-collection-table";
