/**
 * Political data utilities
 *
 * Exports:
 *   - office-parser: Extract structured office data from entity descriptions
 *   - stakeholder-resolver: Resolve stakeholder names to entity IDs
 */

export { parseOffice, toStateAbbrev } from "./office-parser.ts";
export type {
  OfficeType,
  Party,
  OfficeStatus,
  ParsedOffice,
} from "./office-parser.ts";

export {
  buildEntityLookup,
  resolveStakeholderName,
  resolveAllStakeholders,
} from "./stakeholder-resolver.ts";
export type {
  EntityRecord,
  StakeholderMatch,
  ResolverResult,
} from "./stakeholder-resolver.ts";

export {
  generateVoteId,
  buildSampleVotes,
  syncVotesToServer,
  fetchCongressGovRollCall,
} from "./votes-ingest.ts";
export type {
  VoteRecord,
  VoteIngestResult,
} from "./votes-ingest.ts";
