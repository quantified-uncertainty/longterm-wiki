/**
 * TableBase routes — typed relational entity records (Postgres/YAML entities).
 *
 * Covers: entities, entity IDs, personnel, people, grants, divisions,
 * investments, funding rounds, equity positions, funding programs,
 * benchmarks, benchmark results, record source checks, things, research areas.
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
export { recordSourceChecksRoute, type RecordSourceChecksRoute } from "./record-source-checks.js";
// Deprecated aliases for backwards compat
export { recordVerificationsRoute, type RecordVerificationsRoute } from "./record-source-checks.js";
export { thingsRoute, type ThingsRoute } from "./things.js";
export { researchAreasRoute, type ResearchAreasRoute } from "./research-areas.js";
export { policyStakeholdersRoute, type PolicyStakeholdersRoute } from "./policy-stakeholders.js";
