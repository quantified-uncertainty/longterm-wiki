#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Page Improvement Pipeline — shim entry point.
 *
 * Delegates to page-improver/index.ts. This file exists for backward
 * compatibility with scripts that reference the original path.
 */

export {
  runPipeline,
  triagePhase,
  loadPages,
  findPage,
  getFilePath,
} from './page-improver/index.ts';
export type { TriageResult, PipelineResults, PageData, PipelineOptions } from './page-improver/types.ts';

// When run directly as a script, delegate to the index module
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import('./page-improver/index.ts');
}
