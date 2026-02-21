/**
 * Entity Lookup Utilities
 *
 * Provides functions to build entity lookup tables for LLM prompts.
 * This enables the LLM to write EntityLinks with numeric IDs (E##) directly,
 * rather than relying on slug-based IDs and post-processing.
 *
 * Usage:
 *   const table = buildEntityLookupForContent(existingContent, ROOT);
 *   // Include `table` in the LLM prompt
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { ENTITY_LINK_RE, NUMERIC_ID_RE } from './patterns.ts';

interface EntityEntry {
  id: string;      // slug, e.g. "anthropic"
  title: string;   // display name, e.g. "Anthropic"
  type?: string;   // entity type, e.g. "lab", "researcher", "risk"
}

interface IdRegistry {
  entities: Record<string, string>; // E## → slug
}

let _registry: IdRegistry | null = null;
let _entities: EntityEntry[] | null = null;
let _entityById: Map<string, EntityEntry> | null = null;
let _slugToEid: Record<string, string> | null = null;

/**
 * Load the ID registry from the built database.json.
 * Extracts the idRegistry.byNumericId map (E## → slug).
 * Requires build-data.mjs to have been run first.
 */
function loadRegistry(ROOT: string): IdRegistry {
  if (_registry) return _registry;
  const dbPath = path.join(ROOT, 'apps/web/src/data/database.json');
  const raw = fs.readFileSync(dbPath, 'utf-8');
  const db = JSON.parse(raw);
  _registry = { entities: db.idRegistry?.byNumericId || {} };
  return _registry!;
}

function loadSlugToEidMap(ROOT: string): Record<string, string> {
  if (_slugToEid) return _slugToEid;
  const registry = loadRegistry(ROOT);
  _slugToEid = {};
  for (const [eid, slug] of Object.entries(registry.entities)) {
    _slugToEid[slug] = eid;
  }
  return _slugToEid;
}

function loadAllEntities(ROOT: string): EntityEntry[] {
  if (_entities) return _entities;

  const entitiesDir = path.join(ROOT, 'data/entities');
  const files = fs.readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  _entities = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(entitiesDir, file), 'utf-8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as EntityEntry[] | null;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && entry.id && entry.title) {
            _entities.push({
              id: entry.id,
              title: entry.title,
              type: entry.type,
            });
          }
        }
      }
    } catch {
      // Skip malformed YAML files
    }
  }

  return _entities;
}

function loadEntityById(ROOT: string): Map<string, EntityEntry> {
  if (_entityById) return _entityById;
  _entityById = new Map(loadAllEntities(ROOT).map(e => [e.id, e]));
  return _entityById;
}

/**
 * Build a lookup table of entities relevant to the given content.
 *
 * Strategy:
 * 1. Find all existing EntityLink references in the content → include those
 * 2. Search entity titles against the content text → include matches
 * 3. Include high-frequency entities (major orgs, common concepts)
 *
 * Returns a formatted string for inclusion in an LLM prompt.
 */
export function buildEntityLookupForContent(content: string, ROOT: string): string {
  const slugToEid = loadSlugToEidMap(ROOT);
  const entities = loadAllEntities(ROOT);
  const entityById = loadEntityById(ROOT);

  const relevantEntities = new Map<string, { eid: string; title: string; type?: string; reason: string }>();

  // 1. Find existing EntityLink references (both E## and slug-based)
  const existingLinks = [...content.matchAll(ENTITY_LINK_RE)].map(m => m[1]);
  for (const id of existingLinks) {
    if (NUMERIC_ID_RE.test(id)) {
      // Already numeric — resolve to slug to find title
      const registry = loadRegistry(ROOT);
      const slug = registry.entities[id.toUpperCase()];
      if (slug) {
        const entity = entityById.get(slug);
        relevantEntities.set(slug, {
          eid: id.toUpperCase(),
          title: entity?.title || slug,
          type: entity?.type,
          reason: 'existing-link',
        });
      }
    } else {
      // Slug-based reference
      const eid = slugToEid[id];
      if (eid) {
        const entity = entityById.get(id);
        relevantEntities.set(id, {
          eid,
          title: entity?.title || id,
          type: entity?.type,
          reason: 'existing-link',
        });
      }
    }
  }

  // 2. Search entity titles against content text (case-insensitive)
  const contentLower = content.toLowerCase();
  for (const entity of entities) {
    if (relevantEntities.has(entity.id)) continue;
    const eid = slugToEid[entity.id];
    if (!eid) continue;

    // Match entity title in content (word boundary check)
    const titleLower = entity.title.toLowerCase();
    if (titleLower.length >= 4 && contentLower.includes(titleLower)) {
      relevantEntities.set(entity.id, {
        eid,
        title: entity.title,
        type: entity.type,
        reason: 'mentioned-in-content',
      });
    }
  }

  // 3. Always include high-frequency entities (top orgs, key concepts)
  const alwaysInclude = [
    'anthropic', 'openai', 'deepmind', 'miri', 'redwood-research',
    'arc', 'arc-evals', 'metr', 'epoch-ai', 'open-philanthropy',
    'lesswrong', 'cea', '80000-hours', 'fhi', 'cais',
    'eliezer-yudkowsky', 'paul-christiano', 'dario-amodei',
    'scheming', 'deceptive-alignment', 'interpretability',
    'scalable-oversight', 'constitutional-ai', 'rlhf',
  ];
  for (const slug of alwaysInclude) {
    if (relevantEntities.has(slug)) continue;
    const eid = slugToEid[slug];
    if (!eid) continue;
    const entity = entityById.get(slug);
    relevantEntities.set(slug, {
      eid,
      title: entity?.title || slug,
      type: entity?.type,
      reason: 'common',
    });
  }

  // Format as lookup table
  const rows = [...relevantEntities.entries()]
    .sort((a, b) => {
      // Sort by E## number
      const numA = parseInt(a[1].eid.slice(1));
      const numB = parseInt(b[1].eid.slice(1));
      return numA - numB;
    })
    .map(([slug, info]) => `${info.eid} = ${slug} → "${info.title}"${info.type ? ` (${info.type})` : ''}`);

  return rows.join('\n');
}

/**
 * Build a lookup table of entities relevant to a given topic (for page creation).
 *
 * Does keyword matching against entity titles and slugs.
 */
export function buildEntityLookupForTopic(topic: string, ROOT: string): string {
  const slugToEid = loadSlugToEidMap(ROOT);
  const entities = loadAllEntities(ROOT);
  const entityById = loadEntityById(ROOT);

  const relevantEntities = new Map<string, { eid: string; title: string; type?: string }>();

  // Tokenize topic into keywords
  const topicLower = topic.toLowerCase();
  const keywords = topicLower.split(/[\s\-_,]+/).filter(k => k.length >= 3);

  // Match entities by keyword overlap
  for (const entity of entities) {
    const eid = slugToEid[entity.id];
    if (!eid) continue;

    const titleLower = entity.title.toLowerCase();
    const slugLower = entity.id.toLowerCase();

    // Check if topic matches entity or vice versa
    const matched = keywords.some(kw =>
      titleLower.includes(kw) || slugLower.includes(kw) ||
      kw.includes(titleLower) || kw.includes(slugLower)
    ) || titleLower.includes(topicLower) || topicLower.includes(titleLower);

    if (matched) {
      relevantEntities.set(entity.id, { eid, title: entity.title, type: entity.type });
    }
  }

  // Always include common entities
  const alwaysInclude = [
    'anthropic', 'openai', 'deepmind', 'miri', 'redwood-research',
    'arc', 'arc-evals', 'metr', 'epoch-ai', 'open-philanthropy',
    'lesswrong', 'cea', '80000-hours', 'fhi', 'cais',
    'eliezer-yudkowsky', 'paul-christiano', 'dario-amodei',
    'scheming', 'deceptive-alignment', 'interpretability',
  ];
  for (const slug of alwaysInclude) {
    if (relevantEntities.has(slug)) continue;
    const eid = slugToEid[slug];
    if (!eid) continue;
    const entity = entityById.get(slug);
    relevantEntities.set(slug, { eid, title: entity?.title || slug, type: entity?.type });
  }

  const rows = [...relevantEntities.entries()]
    .sort((a, b) => parseInt(a[1].eid.slice(1)) - parseInt(b[1].eid.slice(1)))
    .map(([slug, info]) => `${info.eid} = ${slug} → "${info.title}"${info.type ? ` (${info.type})` : ''}`);

  return rows.join('\n');
}

/**
 * Get the full entity lookup table (all entities with E## IDs).
 * Use sparingly — this can be large (~685 entries).
 */
export function buildFullEntityLookup(ROOT: string): string {
  const registry = loadRegistry(ROOT);
  const entityById = loadEntityById(ROOT);

  const rows: string[] = [];
  for (const [eid, slug] of Object.entries(registry.entities)) {
    const entity = entityById.get(slug);
    rows.push(`${eid} = ${slug} → "${entity?.title || slug}"`);
  }

  return rows.sort((a, b) => {
    const numA = parseInt(a.match(/^E(\d+)/)![1]);
    const numB = parseInt(b.match(/^E(\d+)/)![1]);
    return numA - numB;
  }).join('\n');
}

/** Clear cached data (useful for testing) */
export function clearEntityLookupCache(): void {
  _registry = null;
  _entities = null;
  _slugToEid = null;
}
