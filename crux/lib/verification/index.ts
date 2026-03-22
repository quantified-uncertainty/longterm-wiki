/**
 * Verification utilities — shared by records-verify and verify-orchestrate.
 */

export { fetchSourceContent, isPrivateHost, htmlToText } from './source-fetcher.ts';
export { callLlmForVerification, validateVerdict, MODELS } from './llm-verifier.ts';
export { storeVerificationEvidence, storeAggregateVerdict } from './verdict-handler.ts';
export { VERIFICATION_CONSTANTS } from './types.ts';
export type { FetchSourceResult, LlmVerificationResult } from './types.ts';
