/**
 * TableBase route mount registry (QUA-454 Phase 1 of 3 replacing QUA-146).
 *
 * Centralizes the list of `{path, route}` pairs that `app.ts` mounts for
 * TableBase routes. Replaces ~33 hand-written `.route()` calls in `app.ts`.
 *
 * Adding a new tablebase route: import it here and append one entry to
 * `TABLEBASE_MOUNTS`. `app.ts` picks it up automatically on next restart.
 *
 * A validator (QUA-456) enforces that every route file on disk has a
 * matching entry here and vice versa, so the registry can't silently drift
 * from the filesystem.
 *
 * ## Exclusion list
 *
 * Five routes are deliberately mounted MANUALLY in `app.ts` rather than
 * through this registry, matching the sync-factory exclusion list in
 * `docs/agent-rules/tablebase-sync-factory.md`:
 *
 * - `entities` — slug displacement + statement_timeout overrides
 * - `things` — IT IS the cross-base index
 * - `bluesky` — only `/sync/:did`, no standard `/sync`
 * - `data-sources` — multi-table writes per call
 * - `ids` — sequence-based ID allocation
 *
 * Keeping these manual isolates any future deviation in their mount
 * behavior (custom middleware, alternate path prefixes, etc.) from the
 * common case.
 */

import type { Hono } from "hono";

import { benchmarkResultsRoute } from "./benchmark-results.js";
import { benchmarkResultsPendingRoute } from "./benchmark-results-pending.js";
import { benchmarksRoute } from "./benchmarks.js";
import { campaignFinanceRoute } from "./campaign-finance.js";
import { coverageScansRoute } from "./coverage-scans.js";
import { divisionPersonnelRoute } from "./division-personnel.js";
import { divisionsRoute } from "./divisions.js";
import { entityAssessmentsRoute } from "./entity-assessments.js";
import { entityEventsRoute } from "./entity-events.js";
import { entityProfileRoute } from "./entity-profile.js";
import { entityResourcesRoute } from "./entity-resources.js";
import { equityPositionsRoute } from "./equity-positions.js";
import { fundingProgramsRoute } from "./funding-programs.js";
import { fundingRoundsRoute } from "./funding-rounds.js";
import { grantsRoute } from "./grants.js";
import { investmentsRoute } from "./investments.js";
import { peopleRoute } from "./people.js";
import { personnelRoute } from "./personnel.js";
import { platformAccountsRoute } from "./platform-accounts.js";
import { policyStakeholdersRoute } from "./policy-stakeholders.js";
import { politicalOfficesRoute } from "./political-offices.js";
import { politicalRacesRoute } from "./political-races.js";
import { politicalScoresRoute } from "./political-scores.js";
import { politicalVotesRoute } from "./political-votes.js";
import { predictionMarketsRoute } from "./prediction-markets.js";
import { publicationsRoute } from "./publications.js";
import { recordLookupRoute } from "./record-lookup.js";
import { researchAreasRoute } from "./research-areas.js";
import { scannerResultsRoute } from "./scanner-results.js";
import { secondaryMarketPricesRoute } from "./secondary-market-prices.js";
import { talentFlowsRoute } from "./talent-flows.js";
import { websiteSourcesRoute } from "./website-sources.js";
import { modelAliasesRoute } from "./model-aliases.js";
import { modelSystemCardsRoute } from "./model-system-cards.js";
import { safetyFrameworksRoute } from "./safety-frameworks.js";
import { safetyFrameworkVersionsRoute } from "./safety-framework-versions.js";
import { frameworkCapabilityThresholdsRoute } from "./framework-capability-thresholds.js";
import { frameworkDiffsRoute } from "./framework-diffs.js";
import { frameworkDiffItemsRoute } from "./framework-diff-items.js";
import { frameworkIngestLogRoute } from "./framework-ingest-log.js";
import { scorecardSnapshotsRoute } from "./scorecard-snapshots.js";
import { scorecardGradesRoute } from "./scorecard-grades.js";
import { thirdPartyEvaluationsRoute } from "./third-party-evaluations.js";
import { aiIncidentsRoute } from "./ai-incidents.js";

/**
 * The widest Hono route type that still satisfies `app.route()`. Every
 * concrete route file in this package declares something narrower (e.g.,
 * `Hono<{ Variables: ResolvedEntityVars }, ...>` for the routes that use
 * the `resolveEntityId` middleware, with a schema type inferred from each
 * method-chain step), but they all assign to this shape because the
 * generic parameters are unconstrained.
 *
 * Using `Hono` (no generics) would default to `Hono<BlankEnv, BlankSchema>`
 * and reject narrowed variants — see the TS2322 errors QUA-454 hit on the
 * first-attempt typing. Parameterizing on `any` is the idiomatic escape
 * hatch for a mount-time heterogeneous collection.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHonoRoute = Hono<any, any, any>;

/** A single tablebase route mount entry. */
export interface TablebaseMount {
  /** Absolute API path prefix (always starts with `/api/`). */
  path: string;
  /** The Hono route to mount at that path. */
  route: AnyHonoRoute;
}

/**
 * All TableBase routes mounted automatically by `app.ts`. Sorted by path
 * for easier review. The 5 excluded routes (entities, things, bluesky,
 * data-sources, ids) are NOT in this list — see the file header for why.
 *
 * Each route is declared narrowly (e.g. `Hono<Vars, ...>`). They widen to
 * plain `Hono` through the structural-assignability rules — no runtime
 * casts are needed.
 */
export const TABLEBASE_MOUNTS: readonly TablebaseMount[] = [
  { path: "/api/benchmark-results", route: benchmarkResultsRoute },
  { path: "/api/benchmark-results-pending", route: benchmarkResultsPendingRoute },
  { path: "/api/benchmarks", route: benchmarksRoute },
  { path: "/api/campaign-finance", route: campaignFinanceRoute },
  { path: "/api/coverage-scans", route: coverageScansRoute },
  { path: "/api/division-personnel", route: divisionPersonnelRoute },
  { path: "/api/divisions", route: divisionsRoute },
  { path: "/api/entity-assessments", route: entityAssessmentsRoute },
  { path: "/api/entity-events", route: entityEventsRoute },
  { path: "/api/entity-profile", route: entityProfileRoute },
  { path: "/api/entity-resources", route: entityResourcesRoute },
  { path: "/api/equity-positions", route: equityPositionsRoute },
  { path: "/api/funding-programs", route: fundingProgramsRoute },
  { path: "/api/funding-rounds", route: fundingRoundsRoute },
  { path: "/api/grants", route: grantsRoute },
  { path: "/api/investments", route: investmentsRoute },
  { path: "/api/people", route: peopleRoute },
  { path: "/api/personnel", route: personnelRoute },
  { path: "/api/platform-accounts", route: platformAccountsRoute },
  { path: "/api/policy-stakeholders", route: policyStakeholdersRoute },
  { path: "/api/political-offices", route: politicalOfficesRoute },
  { path: "/api/political-races", route: politicalRacesRoute },
  { path: "/api/political-scores", route: politicalScoresRoute },
  { path: "/api/political-votes", route: politicalVotesRoute },
  { path: "/api/prediction-markets", route: predictionMarketsRoute },
  { path: "/api/publications", route: publicationsRoute },
  { path: "/api/record-lookup", route: recordLookupRoute },
  { path: "/api/research-areas", route: researchAreasRoute },
  { path: "/api/scanner-results", route: scannerResultsRoute },
  { path: "/api/secondary-market-prices", route: secondaryMarketPricesRoute },
  { path: "/api/talent-flows", route: talentFlowsRoute },
  { path: "/api/website-sources", route: websiteSourcesRoute },
  { path: "/api/model-aliases", route: modelAliasesRoute },
  { path: "/api/model-system-cards", route: modelSystemCardsRoute },
  { path: "/api/safety-frameworks", route: safetyFrameworksRoute },
  { path: "/api/safety-framework-versions", route: safetyFrameworkVersionsRoute },
  { path: "/api/framework-capability-thresholds", route: frameworkCapabilityThresholdsRoute },
  { path: "/api/framework-diffs", route: frameworkDiffsRoute },
  { path: "/api/framework-diff-items", route: frameworkDiffItemsRoute },
  { path: "/api/framework-ingest-log", route: frameworkIngestLogRoute },
  { path: "/api/scorecard-snapshots", route: scorecardSnapshotsRoute },
  { path: "/api/scorecard-grades", route: scorecardGradesRoute },
  { path: "/api/third-party-evaluations", route: thirdPartyEvaluationsRoute },
  { path: "/api/ai-incidents", route: aiIncidentsRoute },
];

/**
 * Route files that are intentionally NOT auto-mounted. Kept in sync with
 * the header comment and the manual mounts in `app.ts`. Exposed for the
 * QUA-456 validator so it knows which files to exclude from the
 * "every route file has a registry entry" check.
 */
export const TABLEBASE_MANUAL_MOUNTS = [
  "entities",
  "ids",
  "things",
  "bluesky",
  "data-sources",
] as const;

/**
 * Files in `apps/wiki-server/src/routes/tablebase/` that are NOT Hono
 * route modules — shared helpers, schemas, the auto-mount registry itself,
 * etc. Single source of truth consumed by:
 *   - `apps/wiki-server/src/__tests__/mount-registry.test.ts`
 *   - `crux/validate/validate-tablebase-completeness.ts`
 *   - `crux/validate/validate-tablebase-registry.ts`
 *
 * Before this constant was extracted, all three consumers kept a hand-
 * maintained duplicate, and the lists drifted whenever a new helper was
 * added. Update this list when adding a new non-route module next to the
 * real routes.
 */
// Canonical definition lives in api-types.ts so the worker container can
// reach it; re-exported here for code that already imports from this file.
export { TABLEBASE_NON_ROUTE_FILES } from "../../api-types.js";
