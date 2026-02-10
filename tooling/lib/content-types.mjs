/**
 * Content Type Utilities for Scripts
 *
 * Centralized definitions for content types, their paths, and configurations.
 */

import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

/**
 * Project root directory (current working directory)
 */
export const PROJECT_ROOT = process.cwd();

/**
 * Content type configurations
 */
export const CONTENT_TYPES = {
  model: {
    pathPattern: /\/models\//,
    directory: 'knowledge-base/models',
    requiredSections: [
      { pattern: /^##\s+overview/im, name: 'Overview' },
    ],
    recommendedSections: [
      { pattern: /^##\s+(quantitative|analysis|magnitude)/im, name: 'Quantitative Analysis' },
      { pattern: /^##\s+limitations?/im, name: 'Limitations' },
      { pattern: /^##\s+strategic\s+importance/im, name: 'Strategic Importance' },
      { pattern: /^###?\s+key\s+crux/im, name: 'Key Cruxes' },
    ],
    stalenessThreshold: 90,
  },
  risk: {
    pathPattern: /\/risks\//,
    directory: 'knowledge-base/risks',
    requiredSections: [
      { pattern: /^##\s+overview/im, name: 'Overview' },
    ],
    recommendedSections: [
      { pattern: /^###?\s+risk\s+assessment/im, name: 'Risk Assessment' },
      { pattern: /^###?\s+responses?\s+(that\s+)?address/im, name: 'Responses That Address This Risk' },
      { pattern: /^##\s+key\s+uncertainties/im, name: 'Key Uncertainties' },
    ],
    stalenessThreshold: 60,
  },
  response: {
    pathPattern: /\/responses\//,
    directory: 'knowledge-base/responses',
    requiredSections: [
      { pattern: /^##\s+overview/im, name: 'Overview' },
    ],
    recommendedSections: [
      { pattern: /^###?\s+quick\s+assessment/im, name: 'Quick Assessment' },
      { pattern: /^###?\s+risks?\s+addressed/im, name: 'Risks Addressed' },
      { pattern: /^##\s+how\s+it\s+works/im, name: 'How It Works' },
    ],
    stalenessThreshold: 120,
  },
};

/**
 * Default staleness threshold for unclassified content
 */
export const DEFAULT_STALENESS_THRESHOLD = 180;

/**
 * Determine content type from file path
 * @param {string} filePath - Path to content file
 * @returns {string|null} Content type name or null if no match
 */
export function getContentType(filePath) {
  for (const [type, config] of Object.entries(CONTENT_TYPES)) {
    if (config.pathPattern.test(filePath)) {
      return type;
    }
  }
  return null;
}

/**
 * Get staleness threshold for a content type
 * @param {string} type - Content type name
 * @returns {number} Threshold in days
 */
export function getStalenessThreshold(type) {
  const config = CONTENT_TYPES[type];
  return config?.stalenessThreshold || DEFAULT_STALENESS_THRESHOLD;
}

/**
 * Check if a file is an index/overview page
 * @param {string} filePath - Path to content file
 * @returns {boolean} True if file is an index page
 */
export function isIndexPage(filePath) {
  return filePath.endsWith('index.mdx') || filePath.endsWith('index.md');
}

/**
 * Extract entity ID from file path
 * @param {string} filePath - Path to content file
 * @returns {string|null} Entity ID or null
 */
export function extractEntityId(filePath) {
  // Extract the filename without extension
  const match = filePath.match(/([^/]+)\.(mdx?|md)$/);
  if (!match) return null;

  const filename = match[1];
  // Skip index files
  if (filename === 'index') return null;

  return filename;
}

/**
 * Base content directory (relative path from repo root)
 */
export const CONTENT_DIR = 'content/docs';

/**
 * Data directory (relative path from repo root)
 */
export const DATA_DIR = 'data';

/**
 * Absolute path to content directory
 */
export const CONTENT_DIR_ABS = join(PROJECT_ROOT, CONTENT_DIR);

/**
 * Absolute path to data directory (YAML sources)
 */
export const DATA_DIR_ABS = join(PROJECT_ROOT, DATA_DIR);

/**
 * Generated data directory (JSON build artifacts: database.json, pages.json, etc.)
 */
export const GENERATED_DATA_DIR = 'app/src/data';

/**
 * Absolute path to generated data directory
 */
export const GENERATED_DATA_DIR_ABS = join(PROJECT_ROOT, GENERATED_DATA_DIR);

// ---------------------------------------------------------------------------
// Generated JSON loaders (app/src/data/*.json)
// ---------------------------------------------------------------------------

/**
 * Load a JSON file from the generated data directory.
 * Returns the fallback value if the file doesn't exist.
 */
export function loadGeneratedJson(filename, fallback) {
  const filepath = join(GENERATED_DATA_DIR_ABS, filename);
  if (!existsSync(filepath)) return fallback;
  return JSON.parse(readFileSync(filepath, 'utf-8'));
}

export function loadEntities() {
  return loadGeneratedJson('entities.json', []);
}

export function loadBacklinks() {
  return loadGeneratedJson('backlinks.json', {});
}

export function loadPathRegistry() {
  return loadGeneratedJson('pathRegistry.json', {});
}

export function loadPages() {
  return loadGeneratedJson('pages.json', []);
}

export function loadOrganizations() {
  return loadGeneratedJson('organizations.json', []);
}

export function loadExperts() {
  return loadGeneratedJson('experts.json', []);
}

export function loadDatabase() {
  return loadGeneratedJson('database.json', {});
}

/**
 * Build-breaking validation rules (must all pass before deployment)
 */
export const CRITICAL_RULES = [
  'dollar-signs',
  'comparison-operators',
  'frontmatter-schema',
  'entitylink-ids',
  'internal-links',
  'fake-urls',
  'component-props',
  'citation-urls'
];

/**
 * Quality validation rules (should pass, but won't block deployment)
 */
export const QUALITY_RULES = [
  'tilde-dollar',
  'markdown-lists',
  'consecutive-bold-labels',
  'placeholders',
  'vague-citations',
  'temporal-artifacts'
];
