/**
 * Source-check utilities — shared by factbase-sourcing and sourcing-orchestrate.
 */

export { fetchSourceContent, isPrivateHost, htmlToText } from './source-fetcher.ts';
export { callLlmForSourcing, validateVerdict, LlmResponseSchema, MODELS } from './llm-checker.ts';
export { storeSourcingEvidence, storeAggregateVerdict } from './verdict-handler.ts';
export { SOURCE_CHECK_CONSTANTS } from './types.ts';
export type { FetchSourceResult, LlmSourcingResult, WikiPageVerifyItem } from './types.ts';
export { extractWikiPageClaims, parseFootnotes, matchClaimToFootnote, detectStaleTemporal, parseNumericValue } from './wiki-page-claims.ts';
