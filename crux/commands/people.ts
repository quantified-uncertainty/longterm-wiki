/**
 * People Command Handlers
 *
 * CLI tools for managing person entity data.
 *
 * Usage:
 *   crux people discover [--min-appearances=N] [--json]
 *   crux people create [--min-appearances=N]
 *   crux people link-resources [--apply] [--verbose]   Match resources/literature to person entities
 *   crux people enrich --source=wikidata --dry-run              Preview all enrichment
 *   crux people enrich --source=wikidata --apply                Write new facts to YAML
 *   crux people enrich --source=wikidata --entity=dario-amodei  Single entity
 *   crux people enrich --source=wikidata --dry-run --ci         JSON output
 *   crux people import-key-persons [--sync] [--dry-run] [--verbose]   Sync key-persons from YAML to PG
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { CUSTOM_TAGS } from '../../packages/kb/src/loader.ts';
import {
  extractKeyPersons,
  toSyncItems,
  syncKeyPersons,
} from '../lib/key-persons-import.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { loadGraphFull, resolveEntity, KB_DATA_DIR } from '../lib/kb-loader.ts';
import {
  readEntityDocument,
  appendFact,
  writeEntityDocument,
  findEntityFilePath,
} from '../lib/kb-writer.ts';
import type { RawFactInput } from '../lib/kb-writer.ts';
import type { Entity, Fact } from '../../packages/kb/src/types.ts';
import type { Graph } from '../../packages/kb/src/graph.ts';
// Re-export yaml helpers used by link-resources under their expected names
const { parse: parseYaml, stringify: stringifyYaml } = yaml;

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');

// ---------------------------------------------------------------------------
// Shared option types
// ---------------------------------------------------------------------------

interface DiscoverCommandOptions extends BaseOptions {
  minAppearances?: string;
  json?: boolean;
  ci?: boolean;
}

interface LinkResourcesCommandOptions extends BaseOptions {
  apply?: boolean;
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Types — discovery
// ---------------------------------------------------------------------------

interface PersonCandidate {
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

interface DataSource {
  type:
    | 'expert'
    | 'org-keyPeople'
    | 'entity-relatedEntries'
    | 'kb-thing'
    | 'literature-author';
  /** Which file or entity references this person */
  context: string;
}

interface EntityEntry {
  id: string;
  numericId?: string;
  type: string;
  title?: string;
  relatedEntries?: Array<{ id: string; type: string; relationship?: string }>;
  [key: string]: unknown;
}

interface ExpertEntry {
  id: string;
  name: string;
  affiliation?: string;
  role?: string;
  [key: string]: unknown;
}

interface OrgEntry {
  id: string;
  name: string;
  keyPeople?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Types — link-resources
// ---------------------------------------------------------------------------

interface LiteraturePaper {
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

interface LiteratureCategoryFull {
  id: string;
  name: string;
  papers: LiteraturePaper[];
}

interface LiteratureCategory {
  papers?: Array<{ authors?: string[]; title?: string }>;
}

interface PersonEntity {
  id: string;
  title: string;
  numericId?: string;
}

interface PersonResourceMatch {
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

function loadYaml<T>(relativePath: string): T | null {
  const fullPath = path.join(ROOT, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  const raw = fs.readFileSync(fullPath, 'utf-8');
  return yaml.parse(raw) as T;
}

function loadAllEntityFiles(): EntityEntry[] {
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

function loadAllKbThings(): Array<{
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
const AUTHOR_BLOCKLIST = new Set(['et al.', 'et al', 'others']);

/** Patterns that indicate a team/org name rather than a person */
const TEAM_PATTERNS = [/\bteam\b/i, /\bgroup\b/i, /\bcollaboration\b/i];

/** Check if a name looks like a real person (not a team or noise entry) */
function isPersonName(name: string): boolean {
  if (AUTHOR_BLOCKLIST.has(name)) return false;
  if (TEAM_PATTERNS.some((p) => p.test(name))) return false;
  // Must have at least a first and last name (2+ words)
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return false;
  return true;
}

/** Normalize a person name to a slug id (e.g. "Dario Amodei" -> "dario-amodei") */
function nameToSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Convert a slug to a title-case name (e.g. "dario-amodei" -> "Dario Amodei") */
function slugToName(slug: string): string {
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
// Discovery logic
// ---------------------------------------------------------------------------

function discoverCandidates(): Map<string, PersonCandidate> {
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

// ---------------------------------------------------------------------------
// discover command
// ---------------------------------------------------------------------------

async function discoverCommand(
  _args: string[],
  options: DiscoverCommandOptions,
): Promise<CommandResult> {
  const minAppearances = options.minAppearances
    ? parseInt(options.minAppearances, 10)
    : 1;

  const candidates = discoverCandidates();

  // Filter by min appearances
  const filtered = Array.from(candidates.values())
    .filter((c) => c.appearances >= minAppearances)
    .sort((a, b) => b.score - a.score || b.appearances - a.appearances);

  if (options.json || options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify(
        {
          totalCandidates: candidates.size,
          filteredCount: filtered.length,
          minAppearances,
          candidates: filtered,
        },
        null,
        2,
      ),
    };
  }

  if (filtered.length === 0) {
    return {
      exitCode: 0,
      output:
        minAppearances > 1
          ? `No candidates found with ${minAppearances}+ appearances. Try lowering --min-appearances.`
          : 'No new person candidates found in the data.',
    };
  }

  const lines: string[] = [];
  lines.push('\x1b[1mPeople Discovery Report\x1b[0m');
  lines.push(
    `Found ${filtered.length} candidate(s) not in people.yaml (of ${candidates.size} total, min appearances: ${minAppearances})`,
  );
  lines.push('');

  // Group by score tier
  const highScore = filtered.filter((c) => c.score >= 8);
  const medScore = filtered.filter((c) => c.score >= 4 && c.score < 8);
  const lowScore = filtered.filter((c) => c.score < 4);

  if (highScore.length > 0) {
    lines.push('\x1b[32m--- High Priority (score >= 8) ---\x1b[0m');
    for (const c of highScore) {
      lines.push(formatCandidate(c));
    }
    lines.push('');
  }

  if (medScore.length > 0) {
    lines.push('\x1b[33m--- Medium Priority (score 4-7) ---\x1b[0m');
    for (const c of medScore) {
      lines.push(formatCandidate(c));
    }
    lines.push('');
  }

  if (lowScore.length > 0) {
    lines.push('\x1b[2m--- Lower Priority (score < 4) ---\x1b[0m');
    for (const c of lowScore) {
      lines.push(formatCandidate(c));
    }
    lines.push('');
  }

  lines.push(
    '\x1b[2mRun `crux people create` to generate YAML stubs for top candidates.\x1b[0m',
  );

  return { exitCode: 0, output: lines.join('\n') };
}

function formatCandidate(c: PersonCandidate): string {
  const details = c.sources
    .map((s) => `    - [${s.type}] ${s.context}`)
    .join('\n');
  return `  \x1b[1m${c.name}\x1b[0m (${c.id})  score: ${c.score}, appearances: ${c.appearances}\n${details}`;
}

// ---------------------------------------------------------------------------
// create command (generate YAML for candidates)
// ---------------------------------------------------------------------------

async function createCommand(
  _args: string[],
  options: DiscoverCommandOptions,
): Promise<CommandResult> {
  const minAppearances = options.minAppearances
    ? parseInt(options.minAppearances, 10)
    : 2;

  const candidates = discoverCandidates();

  const filtered = Array.from(candidates.values())
    .filter((c) => c.appearances >= minAppearances)
    .sort((a, b) => b.score - a.score || b.appearances - a.appearances);

  if (filtered.length === 0) {
    return {
      exitCode: 0,
      output: `No candidates with ${minAppearances}+ appearances to create.`,
    };
  }

  const lines: string[] = [];
  lines.push('# Candidate person entity YAML entries');
  lines.push('# Generated by `crux people create`');
  lines.push('# Review each entry before adding to data/entities/people.yaml');
  lines.push(
    '# Entity IDs must be allocated via: pnpm crux ids allocate <slug>',
  );
  lines.push('');

  for (const c of filtered) {
    // Collect related org IDs from sources
    const relatedOrgs = new Set<string>();
    for (const s of c.sources) {
      if (s.type === 'org-keyPeople') {
        const match = s.context.match(/\(([a-z0-9-]+)\)$/);
        if (match) relatedOrgs.add(match[1]);
      }
    }

    // Find role from experts.yaml source
    let role = '';
    const expertSource = c.sources.find((s) => s.type === 'expert');
    if (expertSource) {
      const roleMatch = expertSource.context.match(
        /\(([^)]+?)(?:\s+@\s+[^)]+)?\)/,
      );
      if (roleMatch && roleMatch[1] !== 'no role') {
        role = roleMatch[1];
      }
    }

    lines.push(`- id: ${c.id}`);
    lines.push(`  numericId: # Run: pnpm crux ids allocate ${c.id}`);
    lines.push('  type: person');
    lines.push(`  title: ${c.name}`);

    if (role) {
      lines.push('  customFields:');
      lines.push('    - label: Role');
      lines.push(`      value: "${role}"`);
    }

    if (relatedOrgs.size > 0) {
      lines.push('  relatedEntries:');
      for (const orgId of relatedOrgs) {
        lines.push(`    - id: ${orgId}`);
        lines.push('      type: organization');
      }
    }

    const sourceTypes = [...new Set(c.sources.map((s) => s.type))].join(', ');
    lines.push('  description: >-');
    lines.push(
      `    TODO: Add description for ${c.name}. Discovered from: ${sourceTypes}.`,
    );
    lines.push('');
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── link-resources command ───────────────────────────────────────────

async function linkResourcesCommand(
  _args: string[],
  options: LinkResourcesCommandOptions,
): Promise<CommandResult> {
  const verbose = !!options.verbose;
  const apply = !!options.apply;

  // Load people entities
  const peoplePath = path.join(DATA_DIR, 'entities/people.yaml');
  if (!fs.existsSync(peoplePath)) {
    return { exitCode: 1, output: 'Error: data/entities/people.yaml not found' };
  }
  const people: PersonEntity[] = parseYaml(fs.readFileSync(peoplePath, 'utf8'));

  // Load literature
  const litPath = path.join(DATA_DIR, 'literature.yaml');
  if (!fs.existsSync(litPath)) {
    return { exitCode: 1, output: 'Error: data/literature.yaml not found' };
  }
  const litData = parseYaml(fs.readFileSync(litPath, 'utf8'));
  const categories: LiteratureCategoryFull[] = litData.categories || [];

  // Build name lookup
  const authorLookup = buildAuthorLookup(people);

  if (verbose) {
    console.log(`Loaded ${people.length} people entities`);
    console.log(`Loaded ${categories.length} literature categories`);
    console.log(`Author lookup has ${authorLookup.size} name variants`);
  }

  // Match papers to people
  const matchMap = new Map<string, PersonResourceMatch>();

  // Initialize entries for all people
  for (const person of people) {
    const cleanName = person.title.replace(/\s*\(.*?\)\s*$/, '').trim();
    matchMap.set(person.id, {
      personId: person.id,
      personName: cleanName,
      literature: [],
    });
  }

  let totalPapers = 0;
  let matchedPapers = 0;
  const unmatchedAuthors = new Set<string>();

  for (const category of categories) {
    for (const paper of category.papers) {
      totalPapers++;
      let paperMatched = false;

      for (const author of paper.authors) {
        const entityId = matchAuthor(author, authorLookup);
        if (entityId) {
          const entry = matchMap.get(entityId);
          if (entry) {
            entry.literature.push({
              title: paper.title,
              year: paper.year,
              type: paper.type,
              link: paper.link,
              category: category.name,
            });
            paperMatched = true;
          }
        } else {
          unmatchedAuthors.add(author);
        }
      }

      if (paperMatched) matchedPapers++;
    }
  }

  // Build output
  const lines: string[] = [];
  lines.push(`\n  People-Resource Linking Report`);
  lines.push(`  ${'='.repeat(40)}`);
  lines.push(`  Total papers in literature.yaml: ${totalPapers}`);
  lines.push(`  Papers matched to at least one person: ${matchedPapers}`);
  lines.push(`  Unmatched papers: ${totalPapers - matchedPapers}`);

  // People with matches
  const peopleWithMatches = [...matchMap.values()].filter(
    (m) => m.literature.length > 0,
  );
  peopleWithMatches.sort((a, b) => b.literature.length - a.literature.length);

  lines.push(`\n  People with linked publications: ${peopleWithMatches.length} / ${people.length}`);
  lines.push('');

  for (const match of peopleWithMatches) {
    lines.push(`  ${match.personName} (${match.personId}): ${match.literature.length} publications`);
    if (verbose) {
      for (const lit of match.literature) {
        lines.push(`    - ${lit.title} (${lit.year ?? 'n/a'})`);
      }
    }
  }

  if (verbose && unmatchedAuthors.size > 0) {
    lines.push(`\n  Unmatched authors (${unmatchedAuthors.size}):`);
    for (const author of [...unmatchedAuthors].sort()) {
      lines.push(`    - ${author}`);
    }
  }

  // Write mapping file if --apply
  if (apply) {
    const outputData = peopleWithMatches.map((match) => ({
      personId: match.personId,
      personName: match.personName,
      publications: match.literature.map((lit) => ({
        title: lit.title,
        year: lit.year,
        type: lit.type,
        link: lit.link,
        category: lit.category,
      })),
    }));

    const outputPath = path.join(DATA_DIR, 'people-resources.yaml');
    const yamlOutput = stringifyYaml(outputData, { lineWidth: 120 });
    fs.writeFileSync(outputPath, `# Auto-generated by: pnpm crux people link-resources --apply\n# Maps person entities to their publications from literature.yaml\n# Last generated: ${new Date().toISOString().split('T')[0]}\n\n${yamlOutput}`);
    lines.push(`\n  Wrote ${outputPath}`);
  } else {
    lines.push(`\n  (dry run — use --apply to write data/people-resources.yaml)`);
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Enrich command — Wikidata enrichment
// ---------------------------------------------------------------------------

interface PeopleCommandOptions extends BaseOptions {
  source?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  entity?: string;
  ci?: boolean;
  limit?: string;
}

interface WikidataSearchResult {
  id: string;
  label: string;
  description?: string;
}

interface WikidataClaim {
  mainsnak: {
    snaktype: string;
    datatype?: string;
    datavalue?: {
      type: string;
      value: unknown;
    };
  };
}

interface EnrichmentProposal {
  entityId: string;
  entityName: string;
  wikidataQid: string;
  wikidataDescription: string;
  proposals: FactProposal[];
}

interface FactProposal {
  property: string;
  propertyName: string;
  value: string | number;
  source: string;
  notes?: string;
  action: 'add' | 'skip-exists';
  existingValue?: string;
}

// ── Wikidata API helpers ────────────────────────────────────────────

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const RATE_LIMIT_MS = 1000; // 1s between requests to respect Wikidata limits
const MAX_RETRIES = 3;
// Wikidata requires a proper User-Agent; requests without one get blocked.
const USER_AGENT = 'longterm-wiki-bot/1.0 (https://longtermwiki.com; bot@longtermwiki.com)';
const FETCH_HEADERS = { 'User-Agent': USER_AGENT };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with retry on 429 (rate limit) responses.
 * Backs off exponentially: 2s, 4s, 8s.
 */
async function fetchWithRetry(url: string): Promise<Response> {
  const totalAttempts = MAX_RETRIES + 1; // initial + retries
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      const resp = await fetch(url, { headers: FETCH_HEADERS });
      if (resp.status === 429 && attempt < totalAttempts - 1) {
        const backoff = Math.pow(2, attempt + 1) * 1000;
        process.stderr.write(`Rate limited (429), retrying in ${backoff / 1000}s...\n`);
        await sleep(backoff);
        continue;
      }
      return resp;
    } catch (e: unknown) {
      if (attempt < totalAttempts - 1) {
        const backoff = Math.pow(2, attempt + 1) * 1000;
        process.stderr.write(`Fetch error, retrying in ${backoff / 1000}s...\n`);
        await sleep(backoff);
        continue;
      }
      throw e;
    }
  }
  // Should not reach here, but TypeScript needs a return
  return fetch(url, { headers: FETCH_HEADERS });
}

/**
 * Search Wikidata for a person by name.
 * Returns candidates sorted by relevance.
 */
async function searchWikidata(name: string): Promise<WikidataSearchResult[]> {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language: 'en',
    format: 'json',
    type: 'item',
    limit: '5',
  });

  let resp: Response;
  try {
    resp = await fetchWithRetry(`${WIKIDATA_API}?${params}`);
  } catch (e: unknown) {
    console.warn(`Wikidata search failed for "${name}": ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  if (!resp.ok) {
    console.warn(`Wikidata search failed for "${name}": HTTP ${resp.status}`);
    return [];
  }

  const data = (await resp.json()) as {
    search?: Array<{ id: string; label: string; description?: string }>;
  };
  return (data.search ?? []).map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description,
  }));
}

/**
 * Get claims (structured properties) for a Wikidata entity by QID.
 */
async function getWikidataClaims(
  qid: string,
): Promise<Record<string, WikidataClaim[]>> {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: qid,
    format: 'json',
    props: 'claims|labels',
  });

  const resp = await fetchWithRetry(`${WIKIDATA_API}?${params}`);
  if (!resp.ok) {
    console.warn(`Wikidata entity fetch failed for ${qid}: HTTP ${resp.status}`);
    return {};
  }

  const data = (await resp.json()) as {
    entities?: Record<
      string,
      { claims?: Record<string, WikidataClaim[]> }
    >;
  };
  return data.entities?.[qid]?.claims ?? {};
}

/**
 * Get the label (name) of a Wikidata entity by QID.
 * Used to resolve employer/education institution QIDs to human-readable names.
 */
async function getWikidataLabel(qid: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: qid,
    format: 'json',
    props: 'labels',
    languages: 'en',
  });

  const resp = await fetchWithRetry(`${WIKIDATA_API}?${params}`);
  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    entities?: Record<
      string,
      { labels?: Record<string, { value: string }> }
    >;
  };
  return data.entities?.[qid]?.labels?.en?.value ?? null;
}

// ── Relevance filtering ─────────────────────────────────────────────

/**
 * Negative keywords that disqualify a match outright.
 * Prevents matching politicians, athletes, etc.
 */
const DISQUALIFY_KEYWORDS = [
  'politician',
  'footballer',
  'soccer',
  'rugby',
  'basketball',
  'baseball',
  'cricketer',
  'actor',
  'actress',
  'singer',
  'musician',
  'painter',
  'sculptor',
];

/**
 * Positive keywords that indicate AI/tech/academic relevance.
 * Only these count — no nationality-only matches.
 */
const RELEVANT_KEYWORDS = [
  'computer scientist',
  'artificial intelligence',
  'machine learning',
  'deep learning',
  'researcher',
  'professor',
  'entrepreneur',
  'ceo',
  'investor',
  'philanthropist',
  'philosopher',
  'physicist',
  'mathematician',
  'cognitive',
  'neuroscien',
  'engineer',
  'developer',
  'technology',
  'writer',
  'author',
  'blogger',
  'forecaster',
  'statistician',
  'economist',
  'effective altruism',
  'ai safety',
  'openai',
  'anthropic',
  'deepmind',
  'google',
  'meta',
  'microsoft',
  'venture capital',
  'venture-capital',
  'capitalist',
  'billionaire',
  'software',
  'psychologist',
  'psycholinguist',
  'linguist',
  'academic',
  'science',
  'nonprofit',
  'silicon valley',
  'executive',
  'business',
  'ethicist',
];

/**
 * Check if a Wikidata description suggests this is a relevant person
 * (AI/tech/policy/academic). Returns true if description contains
 * relevant keywords and no disqualifying ones.
 */
function isRelevantMatch(description: string | undefined): boolean {
  if (!description) return false;

  const desc = description.toLowerCase();

  // Reject if any disqualifying keyword appears
  if (DISQUALIFY_KEYWORDS.some((kw) => desc.includes(kw))) return false;

  // Accept if any positive keyword appears
  return RELEVANT_KEYWORDS.some((kw) => desc.includes(kw));
}

// ── Wikidata property extraction ────────────────────────────────────

/**
 * Extract birth year from Wikidata P569 (date of birth).
 */
function extractBirthYear(
  claims: Record<string, WikidataClaim[]>,
): number | null {
  const birthClaims = claims['P569'];
  if (!birthClaims || birthClaims.length === 0) return null;

  const claim = birthClaims[0];
  if (claim.mainsnak.snaktype !== 'value') return null;

  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'time') return null;

  const timeValue = dv.value as { time: string };
  // Time format: +1983-01-01T00:00:00Z
  const match = timeValue.time.match(/[+-](\d{4})/);
  if (!match) return null;

  return parseInt(match[1], 10);
}

/**
 * Extract education institutions from Wikidata P69 (educated at).
 * Returns a formatted education string.
 */
async function extractEducation(
  claims: Record<string, WikidataClaim[]>,
): Promise<string | null> {
  const eduClaims = claims['P69'];
  if (!eduClaims || eduClaims.length === 0) return null;

  const institutions: string[] = [];

  for (const claim of eduClaims) {
    if (claim.mainsnak.snaktype !== 'value') continue;
    const dv = claim.mainsnak.datavalue;
    if (!dv || dv.type !== 'wikibase-entityid') continue;

    const entityId = (dv.value as { id: string }).id;
    const label = await getWikidataLabel(entityId);
    if (label) {
      institutions.push(label);
    }
    await sleep(RATE_LIMIT_MS);
  }

  if (institutions.length === 0) return null;
  return institutions.join('; ');
}

/**
 * Extract employer from Wikidata P108 (employer).
 * Returns the most recent employer name.
 */
async function extractEmployer(
  claims: Record<string, WikidataClaim[]>,
): Promise<string | null> {
  const employerClaims = claims['P108'];
  if (!employerClaims || employerClaims.length === 0) return null;

  // Take the first (most recent) employer
  const claim = employerClaims[0];
  if (claim.mainsnak.snaktype !== 'value') return null;
  const dv = claim.mainsnak.datavalue;
  if (!dv || dv.type !== 'wikibase-entityid') return null;

  const entityId = (dv.value as { id: string }).id;
  const label = await getWikidataLabel(entityId);
  return label;
}

/**
 * Extract occupation from Wikidata P106 (occupation).
 * Returns a comma-separated list of occupations.
 */
async function extractOccupation(
  claims: Record<string, WikidataClaim[]>,
): Promise<string | null> {
  const occupationClaims = claims['P106'];
  if (!occupationClaims || occupationClaims.length === 0) return null;

  const occupations: string[] = [];

  // Limit to first 3 occupations
  for (const claim of occupationClaims.slice(0, 3)) {
    if (claim.mainsnak.snaktype !== 'value') continue;
    const dv = claim.mainsnak.datavalue;
    if (!dv || dv.type !== 'wikibase-entityid') continue;

    const entityId = (dv.value as { id: string }).id;
    const label = await getWikidataLabel(entityId);
    if (label) {
      occupations.push(label);
    }
    await sleep(RATE_LIMIT_MS);
  }

  if (occupations.length === 0) return null;
  return occupations.join(', ');
}

// ── Core enrichment logic ───────────────────────────────────────────

/**
 * Strip parenthetical annotations from entity names.
 * e.g. "Marc Andreessen (AI Investor)" -> "Marc Andreessen"
 */
function cleanName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Check if two names are equivalent: all words in name A appear in name B
 * (case-insensitive, handles middle initials like "Stuart J. Russell").
 */
function namesMatch(nameA: string, nameB: string): boolean {
  const wordsA = cleanName(nameA).toLowerCase().replace(/[.]/g, '').split(/\s+/).filter(Boolean);
  const wordsB = cleanName(nameB).toLowerCase().replace(/[.]/g, '').split(/\s+/).filter(Boolean);
  // All words from A must appear in B (allows B to have extra words like middle names)
  return wordsA.every((w) => wordsB.includes(w));
}

/**
 * Try to find a relevant match from a list of Wikidata search results.
 */
function findBestMatch(
  results: WikidataSearchResult[],
  entity: Entity,
): WikidataSearchResult | null {
  // Priority 1: exact name match + relevant description
  for (const r of results) {
    if (!isRelevantMatch(r.description)) continue;
    if (r.label.toLowerCase() === entity.name.toLowerCase()) {
      return r;
    }
  }

  // Priority 2: fuzzy name match (all words present) + relevant description
  for (const r of results) {
    if (!isRelevantMatch(r.description)) continue;
    if (namesMatch(entity.name, r.label) || namesMatch(r.label, entity.name)) {
      return r;
    }
  }

  // Priority 3: entity aliases match Wikidata label + relevant description
  for (const r of results) {
    if (!isRelevantMatch(r.description)) continue;
    for (const alias of entity.aliases ?? []) {
      if (namesMatch(alias, r.label) || namesMatch(r.label, alias)) {
        return r;
      }
    }
  }

  return null;
}

/**
 * Find the best Wikidata match for a person entity.
 * Requires the description to contain relevant keywords and no disqualifying ones.
 * Tries primary name first; only searches aliases if no match found (reduces API calls).
 */
async function findWikidataMatch(
  entity: Entity,
): Promise<WikidataSearchResult | null> {
  // First try: search by cleaned primary name (strip parenthetical annotations)
  const searchName = cleanName(entity.name);
  const primaryResults = await searchWikidata(searchName);
  await sleep(RATE_LIMIT_MS);

  const primaryMatch = findBestMatch(primaryResults, entity);
  if (primaryMatch) return primaryMatch;

  // Second try: search by aliases (only if primary name failed)
  const aliases = entity.aliases ?? [];
  for (const alias of aliases) {
    const cleanAlias = cleanName(alias);
    // Skip very short aliases (single names) and aliases identical to search name
    if (cleanAlias.length < 4 || cleanAlias.toLowerCase() === searchName.toLowerCase()) continue;

    const aliasResults = await searchWikidata(cleanAlias);
    await sleep(RATE_LIMIT_MS);

    const aliasMatch = findBestMatch(aliasResults, entity);
    if (aliasMatch) return aliasMatch;
  }

  return null;
}

/**
 * Build enrichment proposals for a single entity from Wikidata data.
 */
async function buildProposals(
  entity: Entity,
  graph: Graph,
  qid: string,
  description: string,
): Promise<EnrichmentProposal> {
  const claims = await getWikidataClaims(qid);
  await sleep(RATE_LIMIT_MS);

  const existingFacts = graph.getFacts(entity.id);
  const existingProps = new Map<string, Fact[]>();
  for (const f of existingFacts) {
    const existing = existingProps.get(f.propertyId);
    if (existing) {
      existing.push(f);
    } else {
      existingProps.set(f.propertyId, [f]);
    }
  }

  const proposals: FactProposal[] = [];
  const wikidataUrl = `https://www.wikidata.org/wiki/${qid}`;

  // 1. Birth year (P569 -> born-year)
  const birthYear = extractBirthYear(claims);
  if (birthYear) {
    const existing = existingProps.get('born-year');
    if (existing && existing.length > 0) {
      proposals.push({
        property: 'born-year',
        propertyName: 'Birth Year',
        value: birthYear,
        source: wikidataUrl,
        action: 'skip-exists',
        existingValue: 'value' in existing[0].value ? String(existing[0].value.value) : JSON.stringify(existing[0].value),
      });
    } else {
      proposals.push({
        property: 'born-year',
        propertyName: 'Birth Year',
        value: birthYear,
        source: wikidataUrl,
        notes: `From Wikidata ${qid}`,
        action: 'add',
      });
    }
  }

  // 2. Education (P69 -> education)
  const education = await extractEducation(claims);
  if (education) {
    const existing = existingProps.get('education');
    if (existing && existing.length > 0) {
      proposals.push({
        property: 'education',
        propertyName: 'Education',
        value: education,
        source: wikidataUrl,
        action: 'skip-exists',
        existingValue: 'value' in existing[0].value ? String(existing[0].value.value) : JSON.stringify(existing[0].value),
      });
    } else {
      proposals.push({
        property: 'education',
        propertyName: 'Education',
        value: education,
        source: wikidataUrl,
        notes: `From Wikidata ${qid}`,
        action: 'add',
      });
    }
  }

  return {
    entityId: entity.id,
    entityName: entity.name,
    wikidataQid: qid,
    wikidataDescription: description,
    proposals,
  };
}

// ── Command handler ─────────────────────────────────────────────────

async function enrichCommand(
  args: string[],
  options: PeopleCommandOptions,
): Promise<CommandResult> {
  const source = options.source;
  const dryRun = options['dry-run'] || options.dryRun;
  const apply = options.apply;
  const entityFilter = options.entity;
  const ci = options.ci;
  const limit = options.limit ? parseInt(String(options.limit), 10) : undefined;

  if (source !== 'wikidata') {
    return {
      exitCode: 1,
      output: `Unknown source: "${source ?? '(none)'}". Currently supported: wikidata\n\nUsage:\n  crux people enrich --source=wikidata --dry-run\n  crux people enrich --source=wikidata --apply\n  crux people enrich --source=wikidata --entity=dario-amodei`,
    };
  }

  if (!dryRun && !apply) {
    return {
      exitCode: 1,
      output: `Must specify either --dry-run or --apply.\n\nUsage:\n  crux people enrich --source=wikidata --dry-run\n  crux people enrich --source=wikidata --apply`,
    };
  }

  const kb = await loadGraphFull();
  const { graph, filenameMap } = kb;

  // Get person entities
  let persons = graph.getAllEntities().filter((e) => e.type === 'person');

  if (entityFilter) {
    const entity = resolveEntity(entityFilter, kb);
    if (!entity) {
      return {
        exitCode: 1,
        output: `Entity not found: "${entityFilter}"`,
      };
    }
    if (entity.type !== 'person') {
      return {
        exitCode: 1,
        output: `Entity "${entity.name}" is type "${entity.type}", not "person"`,
      };
    }
    persons = [entity];
  }

  if (limit && limit > 0) {
    persons = persons.slice(0, limit);
  }

  const lines: string[] = [];
  const allProposals: EnrichmentProposal[] = [];
  let matched = 0;
  let notMatched = 0;
  let totalAdded = 0;
  let totalSkipped = 0;

  if (!ci) {
    lines.push(
      `\x1b[1mWikidata Enrichment${dryRun ? ' (DRY RUN)' : ''}\x1b[0m`,
    );
    lines.push(`Processing ${persons.length} person entities...`);
    lines.push('');
  }

  for (const person of persons) {
    if (!ci) {
      process.stderr.write(`  Searching: ${person.name}...\r`);
    }

    const match = await findWikidataMatch(person);
    await sleep(RATE_LIMIT_MS);

    if (!match) {
      notMatched++;
      if (!ci) {
        lines.push(`  \x1b[90m- ${person.name}: no Wikidata match\x1b[0m`);
      }
      continue;
    }

    matched++;
    const proposal = await buildProposals(
      person,
      graph,
      match.id,
      match.description ?? '',
    );
    allProposals.push(proposal);

    const adds = proposal.proposals.filter((p) => p.action === 'add');
    const skips = proposal.proposals.filter((p) => p.action === 'skip-exists');
    totalAdded += adds.length;
    totalSkipped += skips.length;

    if (!ci) {
      if (adds.length === 0 && skips.length === 0) {
        lines.push(
          `  \x1b[90m${person.name} (${match.id}): no new facts available\x1b[0m`,
        );
      } else {
        lines.push(
          `  \x1b[1m${person.name}\x1b[0m (${match.id}: ${match.description ?? 'no description'})`,
        );

        for (const p of adds) {
          lines.push(
            `    \x1b[32m+ ${p.propertyName}: ${p.value}\x1b[0m`,
          );
        }
        for (const p of skips) {
          lines.push(
            `    \x1b[90m= ${p.propertyName}: already exists (${p.existingValue})\x1b[0m`,
          );
        }
      }
    }

    // Apply if requested
    if (apply && adds.length > 0) {
      const slug = filenameMap.get(person.id);
      if (!slug) {
        lines.push(
          `    \x1b[31m! Cannot find filename for ${person.id}\x1b[0m`,
        );
        continue;
      }

      const filePath = findEntityFilePath(slug, KB_DATA_DIR);
      if (!filePath) {
        lines.push(
          `    \x1b[31m! Cannot find YAML file for ${slug}\x1b[0m`,
        );
        continue;
      }

      const doc = readEntityDocument(filePath);

      for (const p of adds) {
        const factInput: RawFactInput = {
          property: p.property,
          value: p.value,
          source: p.source,
          ...(p.notes && { notes: p.notes }),
        };
        const factId = appendFact(doc, factInput);
        if (!ci) {
          lines.push(`    \x1b[32m  -> wrote ${factId}\x1b[0m`);
        }
      }

      writeEntityDocument(filePath, doc);
    }
  }

  // Clear the progress line
  if (!ci) {
    process.stderr.write('                                          \r');
  }

  // Summary
  if (ci) {
    const data = {
      source: 'wikidata',
      mode: apply ? 'apply' : 'dry-run',
      totalPersons: persons.length,
      matched,
      notMatched,
      factsAdded: totalAdded,
      factsSkipped: totalSkipped,
      proposals: allProposals,
    };
    return { exitCode: 0, output: JSON.stringify(data, null, 2) };
  }

  lines.push('');
  lines.push(`\x1b[1mSummary:\x1b[0m`);
  lines.push(`  Persons processed: ${persons.length}`);
  lines.push(`  Wikidata matches:  ${matched}`);
  lines.push(`  No match:          ${notMatched}`);
  lines.push(
    `  Facts to add:      \x1b[32m${totalAdded}\x1b[0m`,
  );
  lines.push(
    `  Facts skipped:     \x1b[90m${totalSkipped} (already exist)\x1b[0m`,
  );

  if (dryRun && totalAdded > 0) {
    lines.push('');
    lines.push(
      `\x1b[33mRe-run with --apply to write these facts.\x1b[0m`,
    );
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── import-key-persons command ────────────────────────────────────────

async function importKeyPersonsCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const verbose = !!options.verbose;
  const sync = !!options.sync;
  const dryRun = !!options['dry-run'];

  const lines: string[] = [];
  lines.push('\n  Key Persons Import');
  lines.push(`  ${'='.repeat(40)}`);

  // Extract from YAML
  lines.push('  Extracting key-persons from KB YAML files...');
  const { records, unresolved } = await extractKeyPersons();

  lines.push(`  Found ${records.length} key-person entries across ${new Set(records.map(r => r.orgSlug)).size} organizations`);

  if (unresolved.length > 0) {
    lines.push(`\n  WARNING: ${unresolved.length} unresolved person slug(s):`);
    for (const u of unresolved) {
      lines.push(`    - ${u.orgSlug}/${u.yamlKey}: person="${u.personSlug}" not found`);
    }
  }

  // Group by org for display
  const byOrg = new Map<string, typeof records>();
  for (const rec of records) {
    const existing = byOrg.get(rec.orgSlug) ?? [];
    existing.push(rec);
    byOrg.set(rec.orgSlug, existing);
  }

  if (verbose) {
    lines.push('\n  By organization:');
    for (const [orgSlug, orgRecords] of [...byOrg.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`    ${orgSlug}: ${orgRecords.length} key persons`);
      for (const rec of orgRecords) {
        const status = rec.personEntityId ? 'OK' : 'UNRESOLVED';
        const founderTag = rec.isFounder ? ' [founder]' : '';
        lines.push(`      - ${rec.personSlug}: ${rec.title}${founderTag} (${status})`);
      }
    }
  }

  // Convert to sync items
  const syncItems = toSyncItems(records);
  lines.push(`\n  Sync items: ${syncItems.length} (${records.length - syncItems.length} skipped due to unresolved persons)`);

  // Sync to PG if requested
  if (sync) {
    try {
      const result = await syncKeyPersons(syncItems, dryRun);
      if (dryRun) {
        lines.push(`\n  DRY RUN: would sync ${syncItems.length} records`);
      } else {
        lines.push(`\n  Sync complete: ${result.upserted} upserted, ${result.failed} batch(es) failed`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push(`\n  Sync failed: ${message}`);
      return { exitCode: 1, output: lines.join('\n') };
    }
  } else {
    lines.push('\n  (preview only -- use --sync to write to PG, or --sync --dry-run to preview sync)');
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

export const commands: Record<
  string,
  (args: string[], options: BaseOptions) => Promise<CommandResult>
> = {
  discover: discoverCommand,
  create: createCommand,
  'link-resources': linkResourcesCommand,
  enrich: enrichCommand,
  'import-key-persons': importKeyPersonsCommand,
  default: discoverCommand,
};

export function getHelp(): string {
  return `
\x1b[1mPeople\x1b[0m — Person entity discovery and data tools

\x1b[1mCommands:\x1b[0m
  discover             Find people across data sources who are not in people.yaml (default)
  create               Generate YAML entity stubs for discovered candidates
  link-resources       Match literature papers to person entities by author name
  enrich               Enrich person KB entities with data from external sources
  import-key-persons   Extract key-persons from KB YAML and sync to PG

\x1b[1mDiscover/Create Options:\x1b[0m
  --min-appearances=N   Only show people in N+ data sources (default: 1 for discover, 2 for create)
  --json                JSON output
  --ci                  JSON output (alias for --json)

\x1b[1mLink-Resources Options:\x1b[0m
  --apply          Write results to data/people-resources.yaml
  --verbose        Show detailed output including unmatched authors

\x1b[1mEnrich Options:\x1b[0m
  --source=wikidata     Data source (currently only wikidata is supported)
  --dry-run             Preview what would be added without writing
  --apply               Actually write new facts to YAML files
  --entity=<slug>       Process a single entity (for testing)
  --limit=N             Limit number of entities to process
  --ci                  JSON output

\x1b[1mData Sources Scanned (discover):\x1b[0m
  1. data/experts.yaml — expert entries not in people.yaml
  2. data/organizations.yaml — keyPeople references
  3. data/entities/*.yaml — relatedEntries with type: person
  4. packages/kb/data/things/ — KB things with type: person
  5. data/literature.yaml — paper authors

\x1b[1mScoring:\x1b[0m
  expert = 5pts, kb-thing = 4pts, org-keyPeople = 4pts,
  entity-relatedEntries = 3pts, literature-author = 2pts

\x1b[1mEnrich Details:\x1b[0m
  Only adds facts that don't already exist — never overwrites.
  Requires high-confidence Wikidata matching (name + description relevance check).
  Currently extracts: born-year (P569), education (P69)

\x1b[1mOptions (import-key-persons):\x1b[0m
  --sync           Actually sync to wiki-server PG
  --dry-run        Preview sync without writing
  --verbose        Show per-org details

\x1b[1mExamples:\x1b[0m
  crux people discover                     # List all candidates
  crux people discover --min-appearances=2 # Only people in 2+ sources
  crux people discover --json              # JSON output
  crux people create                       # Generate YAML stubs (min 2 appearances)
  crux people create --min-appearances=1   # Include single-mention candidates
  crux people link-resources               # Preview matches (dry run)
  crux people link-resources --apply       # Generate people-resources.yaml
  crux people link-resources --verbose     # Show all match details
  crux people enrich --source=wikidata --dry-run
  crux people enrich --source=wikidata --apply
  crux people enrich --source=wikidata --entity=dario-amodei --dry-run
  crux people import-key-persons              # Preview extracted key-persons
  crux people import-key-persons --verbose    # Show per-org details
  crux people import-key-persons --sync       # Sync to wiki-server PG
  crux people import-key-persons --sync --dry-run   # Preview sync (no writes)
`;
}
