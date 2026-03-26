/**
 * Source-check utilities — shared by factbase-source-check and source-check-orchestrate.
 */

export { fetchSourceContent, isPrivateHost, htmlToText, extractWikidataQid, fetchWikidataContent, WIKIDATA_PROPERTIES, COMMON_ENTITY_LABELS } from './source-fetcher.ts';
export { callLlmForSourceCheck, validateVerdict, MODELS } from './llm-checker.ts';
export { storeSourceCheckEvidence, storeAggregateVerdict } from './verdict-handler.ts';
export { SOURCE_CHECK_CONSTANTS } from './types.ts';
export type { FetchSourceResult, LlmSourceCheckResult, WikiPageVerifyItem } from './types.ts';
export { extractWikiPageClaims, parseFootnotes, matchClaimToFootnote, detectStaleTemporal, parseNumericValue } from './wiki-page-claims.ts';
