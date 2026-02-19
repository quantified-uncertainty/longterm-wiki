/**
 * Pipeline phases for the page-improver.
 *
 * This file is a re-export barrel. Each phase lives in its own module
 * under phases/ for better testability and navigation.
 *
 * Individual phase modules:
 *   phases/analyze.ts              — LLM-based page analysis
 *   phases/research.ts             — Web and SCRY research
 *   phases/improve.ts              — Content improvement synthesis
 *   phases/review.ts               — Quality review
 *   phases/validate.ts             — In-process validation + auto-fixes
 *   phases/gap-fill.ts             — Fix remaining issues from review
 *   phases/triage.ts               — News-based tier auto-selection
 *   phases/adversarial-review.ts   — Adversarial reviewer (fact density, speculation, gaps)
 *   phases/adversarial-loop.ts     — Re-research feedback loop driven by adversarial review
 */

export {
  analyzePhase,
  researchPhase,
  improvePhase,
  reviewPhase,
  validatePhase,
  gapFillPhase,
  triagePhase,
} from './phases/index.ts';

export { adversarialReviewPhase } from './phases/adversarial-review.ts';
export { adversarialLoopPhase } from './phases/adversarial-loop.ts';
