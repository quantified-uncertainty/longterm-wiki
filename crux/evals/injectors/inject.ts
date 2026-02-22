/**
 * Error injection orchestrator.
 *
 * Takes a golden page and an injection plan, then applies multiple error
 * injectors to produce a corrupted page with a full error manifest.
 */

import { randomUUID } from 'node:crypto';
import type { ErrorCategory, ErrorManifest, InjectedError } from '../types.ts';
import { injectWrongNumbers } from './wrong-numbers.ts';
import { injectFabricatedClaims } from './fabricated-claims.ts';
import { injectExaggerations } from './exaggerations.ts';
import { injectFabricatedCitations } from './fabricated-citations.ts';
import { injectMissingNuance } from './missing-nuance.ts';

// ---------------------------------------------------------------------------
// Injection plan
// ---------------------------------------------------------------------------

export interface InjectionPlan {
  /** How many errors to inject per category. */
  errorsPerCategory?: number;
  /** Which categories to inject (default: all). */
  categories?: ErrorCategory[];
  /** Use LLM for realistic corruptions (costs money) vs. deterministic (free). */
  useLlm?: boolean;
}

const DEFAULT_PLAN: Required<InjectionPlan> = {
  errorsPerCategory: 1,
  categories: [
    'wrong-number',
    'fabricated-claim',
    'exaggeration',
    'fabricated-citation',
    'missing-nuance',
  ],
  useLlm: false,
};

// ---------------------------------------------------------------------------
// Category → injector mapping
// ---------------------------------------------------------------------------

type Injector = (
  content: string,
  count: number,
  useLlm: boolean,
) => Promise<{ content: string; errors: InjectedError[] }>;

const INJECTORS: Partial<Record<ErrorCategory, Injector>> = {
  'wrong-number': injectWrongNumbers,
  'fabricated-claim': injectFabricatedClaims,
  'exaggeration': injectExaggerations,
  'fabricated-citation': injectFabricatedCitations,
  'missing-nuance': injectMissingNuance,
};

// ---------------------------------------------------------------------------
// Main injection function
// ---------------------------------------------------------------------------

/**
 * Inject errors into a golden page according to the given plan.
 *
 * Errors are applied sequentially (each injector receives the output of the
 * previous one) so they don't collide. The manifest records the full chain.
 */
export async function injectErrors(
  pageId: string,
  originalContent: string,
  plan: InjectionPlan = {},
): Promise<ErrorManifest> {
  // Filter out undefined values so they don't override defaults
  const cleanPlan: InjectionPlan = {};
  if (plan.errorsPerCategory != null) cleanPlan.errorsPerCategory = plan.errorsPerCategory;
  if (plan.categories != null) cleanPlan.categories = plan.categories;
  if (plan.useLlm != null) cleanPlan.useLlm = plan.useLlm;
  const resolved: Required<InjectionPlan> = { ...DEFAULT_PLAN, ...cleanPlan };
  const allErrors: InjectedError[] = [];
  let content = originalContent;

  for (const category of resolved.categories) {
    const injector = INJECTORS[category];
    if (!injector) {
      console.warn(`No injector for category "${category}", skipping`);
      continue;
    }

    const result = await injector(content, resolved.errorsPerCategory, resolved.useLlm);
    content = result.content;

    // Stamp each error with a unique ID
    for (const error of result.errors) {
      error.id = error.id || `${category}-${randomUUID().slice(0, 8)}`;
      allErrors.push(error);
    }
  }

  return {
    pageId,
    originalContent,
    corruptedContent: content,
    errors: allErrors,
    injectedAt: new Date().toISOString(),
  };
}
