/**
 * Error injectors for hallucination detection evals.
 *
 * Each injector takes a page's content and injects a specific type of error,
 * returning the corrupted content along with a manifest describing exactly
 * what was changed (for scoring).
 *
 * Injectors use LLMs to produce realistic corruptions — simple string
 * replacement would produce obviously wrong text that wouldn't test detectors
 * meaningfully. The LLM is asked to make the error plausible.
 */

export { injectWrongNumbers } from './wrong-numbers.ts';
export { injectFabricatedClaims } from './fabricated-claims.ts';
export { injectExaggerations } from './exaggerations.ts';
export { injectFabricatedCitations } from './fabricated-citations.ts';
export { injectMissingNuance } from './missing-nuance.ts';

export { injectErrors, type InjectionPlan } from './inject.ts';
