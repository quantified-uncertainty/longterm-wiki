#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Grade Content Script — shim entry point.
 *
 * Delegates to grading/index.ts. This file exists for backward
 * compatibility with scripts that reference the original path.
 */

export {
  computeMetrics,
  computeQuality,
  getContent,
  detectContentType,
  runAutomatedWarnings,
  runChecklistReview,
  formatWarningsSummary,
  gradePage,
} from './grading/steps.ts';
export type {
  Frontmatter, Ratings, Metrics, PageInfo, Warning,
  ChecklistWarning, GradeResult, PageResult, Options,
} from './grading/types.ts';

// When run directly as a script, delegate to the index module
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import('./grading/index.ts');
}
