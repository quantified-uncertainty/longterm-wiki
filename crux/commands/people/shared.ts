/**
 * Shared types, constants, and utility functions for people subcommands.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { CUSTOM_TAGS } from '../../../packages/kb/src/loader.ts';
import type { CommandOptions as BaseOptions } from '../../lib/command-types.ts';

export type { BaseOptions };

export const ROOT = path.resolve(import.meta.dirname, '../../..');
export const DATA_DIR = path.join(ROOT, 'data');

// Re-export yaml helpers used by link-resources under their expected names
export const { parse: parseYaml, stringify: stringifyYaml } = yaml;

// ---------------------------------------------------------------------------
// Shared option types
// ---------------------------------------------------------------------------

export interface DiscoverCommandOptions extends BaseOptions {
  minAppearances?: string;
  json?: boolean;
  ci?: boolean;
}

export interface LinkResourcesCommandOptions extends BaseOptions {
  apply?: boolean;
  verbose?: boolean;
}

export interface SuggestLinksCommandOptions extends BaseOptions {
  apply?: boolean;
  verbose?: boolean;
}

export interface PeopleCommandOptions extends BaseOptions {
  source?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  entity?: string;
  ci?: boolean;
  limit?: string;
}

// ---------------------------------------------------------------------------
// Types — discovery
// ---------------------------------------------------------------------------

export interface PersonCandidate {
  /** Slug-style ID (e.g. "sam-altman") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Total number of distinct data sources that mention this person */
  appearances: number;
  /** Which data sources reference this person */
  sources: DataSource[];
  /** Relevance score — higher means more prominent */
  score: number;
}

export interface DataSource {
  type:
    | 'expert'
    | 'org-keyPeople'
    | 'entity-relatedEntries'
    | 'kb-thing'
    | 'literature-author';
  /** Which file or entity references this person */
  context: string;
}

export interface EntityEntry {
  id: string;
  numericId?: string;
  type: string;
  title?: string;
  relatedEntries?: Array<{ id: string; type: string; relationship?: string }>;
  [key: string]: unknown;
}

export interface ExpertEntry {
  id: string;
  name: string;
  affiliation?: string;
  role?: string;
  [key: string]: unknown;
}

export interface OrgEntry {
  id: string;
  name: string;
  keyPeople?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Types — link-resources
// ---------------------------------------------------------------------------

export interface LiteraturePaper {
  title: string;
  authors: string[];
  year?: number;
  type?: string;
  organization?: string;
  link?: string;
  linkLabel?: string;
  summary?: string;
  importance?: string;
}

export interface LiteratureCategoryFull {
  id: string;
  name: string;
  papers: LiteraturePaper[];
}

export interface LiteratureCategory {
  papers?: Array<{ authors?: string[]; title?: string }>;
}

export interface PersonEntity {
  id: string;
  title: string;
  numericId?: string;
}

export interface PersonResourceMatch {
  personId: string;
  personName: string;
  literature: Array<{
    title: string;
    year?: number;
    type?: string;
    link?: string;
    category: string;
  }>;
}

// ---------------------------------------------------------------------------
// Data loading helpers
// ---------------------------------------------------------------------------

export function loadYaml<T>(relativePath: string): T | null {
  const fullPath = path.join(ROOT, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  const raw = fs.readFileSync(fullPath, 'utf-8');
  return yaml.parse(raw) as T;
}

export function loadAllEntityFiles(): EntityEntry[] {
  const dir = path.join(ROOT, 'data/entities');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const entities: EntityEntry[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
    const parsed = yaml.parse(raw);
    if (Array.isArray(parsed)) {
      entities.push(...(parsed as EntityEntry[]));
    }
  }
  return entities;
}

export function loadAllKbThings(): Array<{
  thing: { id: string; type: string; name?: string };
}> {
  const dir = path.join(ROOT, 'packages/kb/data/things');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const things: Array<{ thing: { id: string; type: string; name?: string } }> =
    [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
    // KB YAML uses custom !ref, !date, and !src tags
    const parsed = yaml.parse(raw, {
      customTags: CUSTOM_TAGS,
    });
    if (parsed?.thing) {
      things.push(parsed);
    }
  }
  return things;
}

// ---------------------------------------------------------------------------
// Name matching helpers (shared)
// ---------------------------------------------------------------------------

/** Names/patterns to exclude from literature author discovery */
export const AUTHOR_BLOCKLIST = new Set(['et al.', 'et al', 'others']);

/** Patterns that indicate a team/org name rather than a person */
export const TEAM_PATTERNS = [/\bteam\b/i, /\bgroup\b/i, /\bcollaboration\b/i];

/** Check if a name looks like a real person (not a team or noise entry) */
export function isPersonName(name: string): boolean {
  if (AUTHOR_BLOCKLIST.has(name)) return false;
  if (TEAM_PATTERNS.some((p) => p.test(name))) return false;
  // Must have at least a first and last name (2+ words)
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return false;
  return true;
}

/** Normalize a person name to a slug id (e.g. "Dario Amodei" -> "dario-amodei") */
export function nameToSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Convert a slug to a title-case name (e.g. "dario-amodei" -> "Dario Amodei") */
export function slugToName(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Name matching (link-resources) ───────────────────────────────────

/**
 * Normalize a name for matching: lowercase, trim, remove accents.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .trim();
}

/**
 * Build a lookup map from author name variants to person entity IDs.
 * Includes the full name and common variations.
 */
export function buildAuthorLookup(people: PersonEntity[]): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const person of people) {
    // Clean the title (some have parenthetical descriptions)
    const cleanName = person.title.replace(/\s*\(.*?\)\s*$/, '').trim();
    const normalized = normalizeName(cleanName);
    lookup.set(normalized, person.id);

  }

  // Manual aliases for known variations in literature.yaml
  const aliases: Record<string, string> = {
    'nuno sempere': 'nuno-sempere',
    'gwern branwen': 'gwern',
    'gwern': 'gwern',
  };

  for (const [alias, entityId] of Object.entries(aliases)) {
    lookup.set(normalizeName(alias), entityId);
  }

  return lookup;
}

/**
 * Try to match an author string to a person entity.
 * Returns the entity ID if matched, null otherwise.
 */
export function matchAuthor(
  authorName: string,
  lookup: Map<string, string>,
): string | null {
  // Skip placeholder authors
  if (authorName === 'et al.' || authorName.endsWith(' et al.')) return null;
  if (authorName.includes(' Team')) return null;

  const normalized = normalizeName(authorName);
  return lookup.get(normalized) ?? null;
}

// ---------------------------------------------------------------------------
// Discovery logic (shared between discover and create commands)
// ---------------------------------------------------------------------------

export function discoverCandidates(): Map<string, PersonCandidate> {
  const candidates = new Map<string, PersonCandidate>();

  function addCandidate(id: string, name: string, source: DataSource): void {
    const existing = candidates.get(id);
    if (existing) {
      // Don't count the same source type + context twice
      const isDuplicate = existing.sources.some(
        (s) => s.type === source.type && s.context === source.context,
      );
      if (!isDuplicate) {
        existing.sources.push(source);
        existing.appearances++;
      }
      // Prefer a proper name over a slug-derived name
      if (name !== slugToName(id) && existing.name === slugToName(id)) {
        existing.name = name;
      }
    } else {
      candidates.set(id, {
        id,
        name,
        appearances: 1,
        sources: [source],
        score: 0,
      });
    }
  }

  // Load existing person entity IDs to exclude
  const allEntities = loadAllEntityFiles();
  const existingPersonIds = new Set(
    allEntities.filter((e) => e.type === 'person').map((e) => e.id),
  );

  // Source 1: experts.yaml — people listed as experts but not in people.yaml
  const experts = loadYaml<ExpertEntry[]>('data/experts.yaml');
  if (experts && Array.isArray(experts)) {
    for (const expert of experts) {
      if (!existingPersonIds.has(expert.id)) {
        addCandidate(expert.id, expert.name, {
          type: 'expert',
          context: `experts.yaml (${expert.role || 'no role'}${expert.affiliation ? ' @ ' + expert.affiliation : ''})`,
        });
      }
    }
  }

  // Source 2: data/organizations.yaml keyPeople
  const orgs = loadYaml<OrgEntry[]>('data/organizations.yaml');
  if (orgs && Array.isArray(orgs)) {
    for (const org of orgs) {
      if (org.keyPeople) {
        for (const personId of org.keyPeople) {
          if (!existingPersonIds.has(personId)) {
            addCandidate(personId, slugToName(personId), {
              type: 'org-keyPeople',
              context: `${org.name} (${org.id})`,
            });
          }
        }
      }
    }
  }

  // Source 3: entity YAML relatedEntries with type: person
  for (const entity of allEntities) {
    if (entity.relatedEntries) {
      for (const rel of entity.relatedEntries) {
        if (rel.type === 'person' && !existingPersonIds.has(rel.id)) {
          addCandidate(rel.id, slugToName(rel.id), {
            type: 'entity-relatedEntries',
            context: `${entity.title || entity.id} (${entity.type})`,
          });
        }
      }
    }
  }

  // Source 4: KB things of type person that are not in people.yaml
  const kbThings = loadAllKbThings();
  for (const kb of kbThings) {
    if (kb.thing.type === 'person' && !existingPersonIds.has(kb.thing.id)) {
      addCandidate(
        kb.thing.id,
        kb.thing.name || slugToName(kb.thing.id),
        {
          type: 'kb-thing',
          context: `packages/kb/data/things/${kb.thing.id}.yaml`,
        },
      );
    }
  }

  // Source 5: literature.yaml authors
  const literature = loadYaml<{ categories: LiteratureCategory[] }>(
    'data/literature.yaml',
  );
  if (literature?.categories) {
    for (const category of literature.categories) {
      if (category.papers) {
        for (const paper of category.papers) {
          if (paper.authors) {
            for (let authorName of paper.authors) {
              // Strip trailing "et al." from combined names like "Long Ouyang et al."
              authorName = authorName
                .replace(/\s+et\s+al\.?\s*$/i, '')
                .trim();
              if (!isPersonName(authorName)) continue;
              const authorSlug = nameToSlug(authorName);
              if (!existingPersonIds.has(authorSlug)) {
                addCandidate(authorSlug, authorName, {
                  type: 'literature-author',
                  context: `literature.yaml: "${paper.title}"`,
                });
              }
            }
          }
        }
      }
    }
  }

  // Compute scores based on source type weights
  const sourceWeights: Record<DataSource['type'], number> = {
    expert: 5,
    'org-keyPeople': 4,
    'entity-relatedEntries': 3,
    'kb-thing': 4,
    'literature-author': 2,
  };

  for (const candidate of candidates.values()) {
    candidate.score = candidate.sources.reduce(
      (sum, s) => sum + sourceWeights[s.type],
      0,
    );
  }

  return candidates;
}
