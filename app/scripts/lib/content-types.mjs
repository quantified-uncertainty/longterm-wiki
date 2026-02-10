/**
 * Content Type Utilities for App Build Scripts
 *
 * Re-exports shared content type definitions from tooling,
 * and adds app-specific path constants (relative to app/ directory).
 */

import { join } from 'path';

// Shared content type definitions from tooling
export {
  CONTENT_TYPES,
  DEFAULT_STALENESS_THRESHOLD,
  getContentType,
  getStalenessThreshold,
  isIndexPage,
  extractEntityId,
} from '../../../tooling/lib/content-types.js';

/**
 * Project root directory (app/ directory, current working directory)
 */
export const PROJECT_ROOT = process.cwd();

/**
 * Repository root (parent of the app/ directory).
 */
export const REPO_ROOT = join(PROJECT_ROOT, '..');

/**
 * Content directory — MDX pages at repo root.
 */
export const CONTENT_DIR = join(REPO_ROOT, 'content/docs');

/**
 * Source data directory — YAML files, id-registry, etc. at repo root.
 */
export const DATA_DIR = join(REPO_ROOT, 'data');

/**
 * Output data directory — generated JSON files for the app.
 */
export const OUTPUT_DIR = join(PROJECT_ROOT, 'src/data');

/**
 * Absolute path to content directory (alias for CONTENT_DIR, already absolute).
 */
export const CONTENT_DIR_ABS = CONTENT_DIR;

/**
 * Absolute path to data directory (alias for DATA_DIR, already absolute).
 */
export const DATA_DIR_ABS = DATA_DIR;
