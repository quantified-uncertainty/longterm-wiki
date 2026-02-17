/**
 * Content Type Utilities for Scripts
 *
 * Centralized definitions for content types, their paths, and configurations.
 * Typed loaders for generated JSON files (app/src/data/*.json).
 */

import { join, dirname } from 'path';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Types for generated JSON (match what build-data.mjs produces)
// ---------------------------------------------------------------------------

/**
 * MDX frontmatter fields used across wiki pages.
 * Known fields get type hints; arbitrary fields still allowed via index signature.
 */
export interface Frontmatter {
  title?: string;
  description?: string;
  sidebar?: { label?: string; order?: number; hidden?: boolean; badge?: unknown };
  pageType?: 'content' | 'stub' | 'documentation';
  entityType?: string;
  quality?: number;
  readerImportance?: number;
  tractability?: number;
  neglectedness?: number;
  uncertainty?: number;
  llmSummary?: string;
  lastEdited?: string;
  lastUpdated?: Date | string | boolean;
  createdAt?: Date | string;
  todo?: string;
  todos?: string[];
  seeAlso?: string;
  ratings?: {
    novelty?: number;
    rigor?: number;
    actionability?: number;
    completeness?: number;
    changeability?: number;
    xriskImpact?: number;
    trajectoryImpact?: number;
    uncertainty?: number;
  };
  metrics?: {
    wordCount?: number;
    citations?: number;
    tables?: number;
    diagrams?: number;
  };
  maturity?: string;
  fullWidth?: boolean;
  update_frequency?: number;
  evergreen?: boolean;
  entityId?: string;
  roles?: string[];
  pageTemplate?: string;
  draft?: boolean;
  // Allow arbitrary additional fields
  [key: string]: any;
}

export interface Entity {
  id: string;
  type: string;
  entityType?: string;  // Legacy alias for type, used by some scripts
  title: string;
  numericId?: string;
  description?: string;
  aliases?: string[];
  status?: string;
  lastUpdated?: string;
  tags?: string[];
  severity?: string;
  likelihood?: string | { level: string; status?: string; confidence?: string; notes?: string };
  timeframe?: string | { median: number; earliest?: number; latest?: number };
  maturity?: string;
  website?: string;
  relatedTopics?: string[];
  relatedEntries?: Array<{ id: string; relationship: string }>;
  sources?: Array<{ title: string; url?: string; date?: string }>;
  resources?: string[];
  clusters?: string[];
  content?: Record<string, unknown>;
  customFields?: Array<{ label: string; value: string }>;
}

export interface BacklinkEntry {
  id: string;
  type: string;
  title: string;
  relationship: string;
}

export type BacklinksMap = Record<string, BacklinkEntry[]>;

export type PathRegistry = Record<string, string>;

export interface PageEntry {
  id: string;
  path: string;
  filePath?: string;
  title: string;
  quality?: number;
  readerImportance?: number | null;
  tractability?: number | null;
  neglectedness?: number | null;
  uncertainty?: number | null;
  causalLevel?: string | null;
  lastUpdated?: string | null;
  llmSummary?: string | null;
  description?: string | null;
  ratings?: Record<string, unknown> | null;
  category?: string;
  subcategory?: string | null;
  clusters?: string[];
  metrics?: {
    wordCount: number;
    tableCount: number;
    diagramCount: number;
    internalLinks: number;
    externalLinks: number;
    bulletRatio: number;
    sectionCount: number;
    hasOverview: boolean;
    structuralScore: number;
  };
  suggestedQuality?: number;
  updateFrequency?: number | null;
  evergreen?: boolean;
  changeHistory?: Array<{
    date: string;
    branch: string;
    title: string;
    summary: string;
  }>;
  wordCount?: number;
  unconvertedLinks?: Array<{ url: string; text: string; line: number }>;
  unconvertedLinkCount?: number;
  convertedLinkCount?: number;
  backlinkCount?: number;
  redundancy?: {
    maxSimilarity: number;
    similarPages: Array<{ id: string; similarity: number }>;
  };
}

export interface OrganizationEntry {
  id: string;
  name: string;
  shortName?: string;
  type?: string;
  founded?: string;
  headquarters?: string;
  website?: string;
  description?: string;
  keyPeople?: string[];
  funding?: string;
  employees?: string;
  safetyFocus?: string;
  parentOrg?: string;
}

export interface ExpertEntry {
  id: string;
  name: string;
  affiliation?: string;
  role?: string;
  website?: string;
  twitter?: string;
  knownFor?: string[];
  background?: string;
}

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

/** Project root directory (derived from this file's location: crux/lib/) */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_ROOT: string = join(__dirname, '../..');

/** Base content directory (relative path from repo root) */
export const CONTENT_DIR: string = 'content/docs';

/** Data directory (relative path from repo root) */
export const DATA_DIR: string = 'data';

/** Absolute path to content directory */
export const CONTENT_DIR_ABS: string = join(PROJECT_ROOT, CONTENT_DIR);

/** Absolute path to data directory (YAML sources) */
export const DATA_DIR_ABS: string = join(PROJECT_ROOT, DATA_DIR);

/** Generated data directory (JSON build artifacts) */
export const GENERATED_DATA_DIR: string = 'app/src/data';

/** Absolute path to generated data directory */
export const GENERATED_DATA_DIR_ABS: string = join(PROJECT_ROOT, GENERATED_DATA_DIR);

// ---------------------------------------------------------------------------
// Content type configurations
// ---------------------------------------------------------------------------

interface SectionMatcher {
  pattern: RegExp;
  name: string;
}

interface ContentTypeConfig {
  pathPattern: RegExp;
  directory: string;
  requiredSections: SectionMatcher[];
  recommendedSections: SectionMatcher[];
  stalenessThreshold: number;
}

export const CONTENT_TYPES: Record<string, ContentTypeConfig> = {
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

/** Default staleness threshold for unclassified content */
export const DEFAULT_STALENESS_THRESHOLD: number = 180;

// ---------------------------------------------------------------------------
// Content type helpers
// ---------------------------------------------------------------------------

export function getContentType(filePath: string): string | null {
  for (const [type, config] of Object.entries(CONTENT_TYPES)) {
    if (config.pathPattern.test(filePath)) {
      return type;
    }
  }
  return null;
}

export function getStalenessThreshold(type: string): number {
  const config = CONTENT_TYPES[type];
  return config?.stalenessThreshold || DEFAULT_STALENESS_THRESHOLD;
}

export function isIndexPage(filePath: string): boolean {
  return filePath.endsWith('index.mdx') || filePath.endsWith('index.md');
}

export function extractEntityId(filePath: string): string | null {
  const match = filePath.match(/([^/]+)\.(mdx?|md)$/);
  if (!match) return null;

  const filename = match[1];
  if (filename === 'index') return null;

  return filename;
}

// ---------------------------------------------------------------------------
// Generated JSON loaders (app/src/data/*.json)
// ---------------------------------------------------------------------------

/**
 * Load a JSON file from the generated data directory.
 * Returns the fallback value if the file doesn't exist.
 */
export function loadGeneratedJson<T>(filename: string, fallback: T): T {
  const filepath = join(GENERATED_DATA_DIR_ABS, filename);
  if (!existsSync(filepath)) return fallback;
  return JSON.parse(readFileSync(filepath, 'utf-8'));
}

export function loadEntities(): Entity[] {
  return loadGeneratedJson<Entity[]>('entities.json', []);
}

export function loadBacklinks(): BacklinksMap {
  return loadGeneratedJson<BacklinksMap>('backlinks.json', {});
}

export function loadPathRegistry(): PathRegistry {
  return loadGeneratedJson<PathRegistry>('pathRegistry.json', {});
}

export function loadPages(): PageEntry[] {
  return loadGeneratedJson<PageEntry[]>('pages.json', []);
}

export function loadOrganizations(): OrganizationEntry[] {
  return loadGeneratedJson<OrganizationEntry[]>('organizations.json', []);
}

export function loadExperts(): ExpertEntry[] {
  return loadGeneratedJson<ExpertEntry[]>('experts.json', []);
}

/**
 * Shape of database.json as produced by build-data.mjs.
 * Only the fields actually consumed by crux rules are listed here;
 * the real file may contain additional keys.
 */
export interface DatabaseSchema {
  entities?: Entity[];
  experts?: ExpertEntry[];
  organizations?: OrganizationEntry[];
  facts?: Record<string, {
    value?: string;
    computed?: boolean;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export function loadDatabase(): DatabaseSchema {
  return loadGeneratedJson<DatabaseSchema>('database.json', {});
}

// ---------------------------------------------------------------------------
// Validation rule sets
// ---------------------------------------------------------------------------

/** Build-breaking validation rules (must all pass before deployment) */
export const CRITICAL_RULES: string[] = [
  'dollar-signs',
  'comparison-operators',
  'frontmatter-schema',
  'entitylink-ids',
  'internal-links',
  'fake-urls',
  'component-props',
  'citation-urls',
];

/** Quality validation rules (should pass, but won't block deployment) */
export const QUALITY_RULES: string[] = [
  'tilde-dollar',
  'markdown-lists',
  'consecutive-bold-labels',
  'placeholders',
  'vague-citations',
  'temporal-artifacts',
  'citation-doi-mismatch',
  'mermaid-style',
];
