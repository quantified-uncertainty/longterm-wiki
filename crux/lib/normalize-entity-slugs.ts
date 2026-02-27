/**
 * Normalize entity slugs in relatedEntities to canonical form.
 *
 * Used during claim extraction and in the normalization script
 * to ensure relatedEntities values match known entity slugs.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';

interface EntityEntry {
  id: string;
  title?: string;
}

/**
 * Build a normalization map: variant string -> canonical entity slug.
 *
 * Loads all entities from data/entities/*.yaml and creates mappings for:
 * - Space-to-hyphen variants ("far ai" -> "far-ai")
 * - Dot-to-hyphen variants ("far.ai" -> "far-ai")
 * - Title-to-slug mappings ("Machine Intelligence Research Institute" -> "miri")
 * - Known aliases (hardcoded for cases that can't be auto-derived)
 *
 * Returns a Map where keys are lowercase variants and values are canonical slugs.
 */
export function buildNormalizationMap(projectRoot: string): Map<string, string> {
  const entitiesDir = join(projectRoot, 'data/entities');
  const slugs = new Set<string>();
  const titleToSlug = new Map<string, string>();

  // Load all entity slugs and titles
  const files = readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  for (const file of files) {
    try {
      const raw = readFileSync(join(entitiesDir, file), 'utf-8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as EntityEntry[] | null;
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (entry?.id) {
          slugs.add(entry.id);
          if (entry.title) {
            titleToSlug.set(entry.title.toLowerCase(), entry.id);
          }
        }
      }
    } catch {
      // Skip malformed YAML files
    }
  }

  // Known aliases that can't be auto-derived
  const MANUAL_ALIASES: Record<string, string> = {
    'nanda': 'neel-nanda',
    'christiano': 'paul-christiano',
    'redwood': 'redwood-research',
    'machine intelligence research institute': 'miri',
    'cotra': 'ajeya-cotra',
    'google deepmind': 'deepmind',
    'future of life institute': 'fli',
    'future-of-life-institute': 'fli',
    'russell': 'stuart-russell',
    'manifold markets': 'manifold',
    'metaculus aggregate': 'metaculus',
    'kwa/metr': 'metr',
    'open philanthropy project': 'open-philanthropy',
    'survival and flourishing fund': 'sff',
    'far.labs': 'far-ai',
  };

  const normMap = new Map<string, string>();

  // Add manual aliases (only if target slug exists)
  for (const [alias, target] of Object.entries(MANUAL_ALIASES)) {
    if (slugs.has(target)) {
      normMap.set(alias, target);
    }
  }

  // Add title-to-slug mappings
  for (const [title, slug] of titleToSlug) {
    if (!normMap.has(title) && title !== slug) {
      normMap.set(title, slug);
    }
  }

  return normMap;
}

/**
 * Normalize a single entity slug.
 *
 * Tries in order:
 * 1. Exact match in known slugs -> return as-is
 * 2. Manual/title alias match -> return canonical slug
 * 3. Space-to-hyphen conversion -> check if result is a known slug
 * 4. Dot-to-hyphen conversion -> check if result is a known slug
 * 5. Return the lowercased original (for external entities without wiki pages)
 */
export function normalizeEntitySlug(
  value: string,
  slugs: Set<string>,
  normMap: Map<string, string>,
): string {
  const lower = value.toLowerCase().trim();

  // Already a valid slug
  if (slugs.has(lower)) return lower;

  // Check normalization map (manual aliases + title matches)
  const mapped = normMap.get(lower);
  if (mapped) return mapped;

  // Space to hyphen
  const hyphenated = lower.replace(/\s+/g, '-');
  if (slugs.has(hyphenated)) return hyphenated;

  // Dot to hyphen
  const dotCleaned = lower.replace(/\./g, '-').replace(/\s+/g, '-');
  if (slugs.has(dotCleaned)) return dotCleaned;

  // Return lowercased original for unknown entities
  return lower;
}

/**
 * Load entity slugs from data/entities/*.yaml.
 */
export function loadEntitySlugs(projectRoot: string): Set<string> {
  const entitiesDir = join(projectRoot, 'data/entities');
  const slugs = new Set<string>();
  const files = readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  for (const file of files) {
    try {
      const raw = readFileSync(join(entitiesDir, file), 'utf-8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as EntityEntry[] | null;
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (entry?.id) slugs.add(entry.id);
      }
    } catch {
      // Skip malformed files
    }
  }
  return slugs;
}

/**
 * Normalize an array of relatedEntities values.
 * Returns deduplicated, normalized array.
 */
export function normalizeRelatedEntities(
  entities: string[],
  slugs: Set<string>,
  normMap: Map<string, string>,
): string[] {
  const normalized = entities.map(e => normalizeEntitySlug(e, slugs, normMap));
  return [...new Set(normalized)];
}
