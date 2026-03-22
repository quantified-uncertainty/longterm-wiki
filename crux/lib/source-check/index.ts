/**
 * Source-check utilities — shared by factbase-source-check and source-check-orchestrate.
 */

export { fetchSourceContent, isPrivateHost, htmlToText } from './source-fetcher.ts';
export { callLlmForSourceCheck, validateVerdict, MODELS } from './llm-checker.ts';
export { storeSourceCheckEvidence, storeAggregateVerdict } from './verdict-handler.ts';
export { SOURCE_CHECK_CONSTANTS } from './types.ts';
export type { FetchSourceResult, LlmSourceCheckResult } from './types.ts';

// Deprecated aliases
/** @deprecated Use callLlmForSourceCheck */
export { callLlmForSourceCheck as callLlmForVerification } from './llm-checker.ts';
/** @deprecated Use storeSourceCheckEvidence */
export { storeSourceCheckEvidence as storeVerificationEvidence } from './verdict-handler.ts';
/** @deprecated Use SOURCE_CHECK_CONSTANTS */
export { SOURCE_CHECK_CONSTANTS as VERIFICATION_CONSTANTS } from './types.ts';
