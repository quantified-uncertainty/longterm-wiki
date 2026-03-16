/**
 * Shared utilities used across route categories.
 *
 * Covers: validation helpers, pagination, search, entity resolution,
 * page ID resolution, thing sync, reference checking.
 */
export {
  paginationQuery,
  noDuplicateIds,
  VALIDATION_ERROR,
  INVALID_JSON_ERROR,
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  dbError,
  firstOrThrow,
  escapeIlike,
  parseRange,
  zv,
} from "./utils.js";
export { checkRefsExist } from "./ref-check.js";
export { resolvePageIntId, resolvePageIntIds, allocateAndResolvePageIntIds } from "./page-id-helpers.js";
export { upsertThingsInTx, type ThingSyncInput } from "./thing-sync.js";
export { resolveEntityStableId } from "./entity-resolution.js";
export { buildSearchCondition, parseSort, paginationMeta, type PaginationMeta } from "./query-helpers.js";
