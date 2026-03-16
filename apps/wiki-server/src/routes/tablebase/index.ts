/**
 * TableBase routes — typed relational entity records (Postgres/YAML entities).
 *
 * Covers: entities, entity IDs, personnel, people, grants, divisions,
 * investments, funding rounds, equity positions, funding programs,
 * benchmarks, benchmark results, record verifications, things, research areas.
 */
export { entitiesRoute, type EntitiesRoute } from "./entities.js";
export { idsRoute, type IdsRoute } from "./ids.js";
export { personnelRoute, type PersonnelRoute } from "./personnel.js";
export { peopleRoute, type PeopleRoute } from "./people.js";
export { grantsRoute, type GrantsRoute } from "./grants.js";
export { divisionsRoute, type DivisionsRoute } from "./divisions.js";
export { divisionPersonnelRoute, type DivisionPersonnelRoute } from "./division-personnel.js";
export { investmentsRoute, type InvestmentsRoute } from "./investments.js";
export { fundingRoundsRoute, type FundingRoundsRoute } from "./funding-rounds.js";
export { equityPositionsRoute, type EquityPositionsRoute } from "./equity-positions.js";
export { fundingProgramsRoute, type FundingProgramsRoute } from "./funding-programs.js";
export { benchmarksRoute, type BenchmarksRoute } from "./benchmarks.js";
export { benchmarkResultsRoute, type BenchmarkResultsRoute } from "./benchmark-results.js";
export { recordVerificationsRoute, type RecordVerificationsRoute } from "./record-verifications.js";
export { thingsRoute, type ThingsRoute } from "./things.js";
export { researchAreasRoute, type ResearchAreasRoute } from "./research-areas.js";
