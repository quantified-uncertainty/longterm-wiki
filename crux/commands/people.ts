/**
 * People Command Handlers
 *
 * CLI tools for managing person entity data: discovery, career import,
 * and resource linking.
 *
 * Usage:
 *   crux people discover [--min-appearances=N] [--json]
 *   crux people create [--min-appearances=N]
 *   crux people import-careers              Preview career data (dry run)
 *   crux people import-careers --sync       Sync to wiki-server Postgres
 *   crux people link-resources [--apply] [--verbose]   Match resources/literature to person entities
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { extractAllCareers } from '../lib/career-import/extract.ts';
import { apiRequest, getServerUrl } from '../lib/wiki-server/client.ts';
import { CUSTOM_TAGS } from '../../packages/kb/src/loader.ts';

// ── Shared constants ──────────────────────────────────────────────────

const DATA_DIR = join(import.meta.dirname, '../../data');
const ROOT = path.resolve(import.meta.dirname, '../..');

// ── Types (shared) ────────────────────────────────────────────────────

interface CommandOptions extends BaseOptions {
  dryRun?: boolean;
  minAppearances?: string;
  create?: boolean;
  json?: boolean;
  ci?: boolean;
  sync?: boolean;
  apply?: boolean;
  verbose?: boolean;
}

// ── Types (link-resources) ────────────────────────────────────────────

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

interface LinkResourcesLiteratureCategory {
  id: string;
  name: string;
  papers: LiteraturePaper[];
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

// ── Types (discover/create) ──────────────────────────────────────────

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

interface KbThing {
  thing: { id: string; type: string; name?: string };
  facts?: Array<{ property: string; value: string | unknown }>;
}

interface DiscoverLiteratureCategory {
  papers?: Array<{ authors?: string[]; title?: string }>;
}

// ── Name matching (shared) ───────────────────────────────────────────

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

// ── link-resources command ───────────────────────────────────────────

async function linkResourcesCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const verbose = !!options.verbose;
  const apply = !!options.apply;

  // Load people entities
  const peoplePath = join(DATA_DIR, 'entities/people.yaml');
  if (!existsSync(peoplePath)) {
    return { exitCode: 1, output: 'Error: data/entities/people.yaml not found' };
  }
  const people: PersonEntity[] = parseYaml(readFileSync(peoplePath, 'utf8'));

  // Load literature
  const litPath = join(DATA_DIR, 'literature.yaml');
  if (!existsSync(litPath)) {
    return { exitCode: 1, output: 'Error: data/literature.yaml not found' };
  }
  const litData = parseYaml(readFileSync(litPath, 'utf8'));
  const categories: LinkResourcesLiteratureCategory[] = litData.categories || [];

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

    const outputPath = join(DATA_DIR, 'people-resources.yaml');
    const yamlOutput = stringifyYaml(outputData, { lineWidth: 120 });
    writeFileSync(outputPath, `# Auto-generated by: pnpm crux people link-resources --apply\n# Maps person entities to their publications from literature.yaml\n# Last generated: ${new Date().toISOString().split('T')[0]}\n\n${yamlOutput}`);
    lines.push(`\n  Wrote ${outputPath}`);
  } else {
    lines.push(`\n  (dry run — use --apply to write data/people-resources.yaml)`);
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Data loading helpers (discover/create) ───────────────────────────

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

function loadAllKbThings(): Array<{ thing: { id: string; type: string; name?: string } }> {
  const dir = path.join(ROOT, 'packages/kb/data/things');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const things: Array<{ thing: { id: string; type: string; name?: string } }> = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
    // KB YAML uses custom !ref, !date, !src tags — use the canonical tag handlers from kb/loader
    const parsed = yaml.parse(raw, {
      customTags: CUSTOM_TAGS,
    });
    if (parsed?.thing) {
      things.push(parsed);
    }
  }
  return things;
}

/** Names/patterns to exclude from literature author discovery */
const AUTHOR_BLOCKLIST = new Set([
  'et al.',
  'et al',
  'others',
]);

/** Patterns that indicate a team/org name rather than a person */
const TEAM_PATTERNS = [
  /\bteam\b/i,
  /\bgroup\b/i,
  /\bcollaboration\b/i,
];

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

// ── Discovery logic ──────────────────────────────────────────────────

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
      addCandidate(kb.thing.id, kb.thing.name || slugToName(kb.thing.id), {
        type: 'kb-thing',
        context: `packages/kb/data/things/${kb.thing.id}.yaml`,
      });
    }
  }

  // Source 5: literature.yaml authors
  const literature = loadYaml<{ categories: DiscoverLiteratureCategory[] }>(
    'data/literature.yaml',
  );
  if (literature?.categories) {
    for (const category of literature.categories) {
      if (category.papers) {
        for (const paper of category.papers) {
          if (paper.authors) {
            for (let authorName of paper.authors) {
              // Strip trailing "et al." from combined names like "Long Ouyang et al."
              authorName = authorName.replace(/\s+et\s+al\.?\s*$/i, '').trim();
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

// ── discover command ─────────────────────────────────────────────────

async function discoverCommand(
  _args: string[],
  options: CommandOptions,
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

// ── create command (generate YAML for candidates) ────────────────────

async function createCommand(
  _args: string[],
  options: CommandOptions,
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
  lines.push('# Entity IDs must be allocated via: pnpm crux ids allocate <slug>');
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
      const roleMatch = expertSource.context.match(/\(([^)]+?)(?:\s+@\s+[^)]+)?\)/);
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

// ── import-careers command ───────────────────────────────────────────

async function importCareersCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const doSync = options.sync === true;

  console.log('=== Career History Import ===\n');

  // Extract career entries from all sources
  const result = extractAllCareers();
  const { entries, stats } = result;

  // Print stats
  console.log('Sources:');
  console.log(`  KB career-history records: ${stats.fromRecords}`);
  console.log(`  KB employed-by/role facts: ${stats.fromFacts}`);
  console.log(`  experts.yaml affiliations: ${stats.fromExperts}`);
  console.log(`  Total (before dedup):      ${stats.totalBeforeDedup}`);
  console.log(`  Total (after dedup):       ${stats.totalAfterDedup}`);
  console.log(`  Unique persons:            ${stats.uniquePersons}`);
  console.log(`  Unique organizations:      ${stats.uniqueOrgs}`);
  console.log();

  // Print sample entries
  const sample = entries.slice(0, 10);
  console.log(`Sample entries (first ${sample.length}):`);
  for (const entry of sample) {
    const dates = [entry.startDate, entry.endDate ?? 'present']
      .filter(Boolean)
      .join(' \u2192 ');
    const founder = entry.isFounder ? ' [founder]' : '';
    console.log(
      `  ${entry.personId.substring(0, 6)}\u2026 \u2192 ${entry.organizationId.substring(0, 10).padEnd(10)} | ${entry.role}${founder} | ${dates} | ${entry.origin}`,
    );
  }
  console.log();

  if (!doSync) {
    console.log('Dry run complete. Use --sync to push to wiki-server.\n');
    return {
      exitCode: 0,
      output: `${stats.totalAfterDedup} career entries extracted`,
    };
  }

  // Sync to wiki-server
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    console.error(
      'Error: LONGTERMWIKI_SERVER_URL not set. Cannot sync to wiki-server.',
    );
    return { exitCode: 1, output: 'Wiki-server URL not configured' };
  }

  console.log(`Syncing ${entries.length} entries to ${serverUrl}...`);

  // Sync in batches of 100
  const BATCH_SIZE = 100;
  let totalSynced = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const syncItems = batch.map((e) => ({
      id: e.id,
      personId: e.personId,
      organizationId: e.organizationId,
      role: e.role,
      roleType: 'career' as const,
      startDate: e.startDate,
      endDate: e.endDate,
      isFounder: e.isFounder,
      source: e.source,
      notes: e.notes,
    }));

    const res = await apiRequest<{ upserted: number }>(
      'POST',
      '/api/personnel/sync',
      { items: syncItems },
    );

    if (!res.ok) {
      console.error(
        `  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${res.message}`,
      );
      return {
        exitCode: 1,
        output: `Sync failed after ${totalSynced} entries: ${res.message}`,
      };
    }

    totalSynced += res.data.upserted;
    console.log(
      `  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${res.data.upserted} upserted`,
    );
  }

  console.log(`\nDone: ${totalSynced} career entries synced to wiki-server.\n`);
  return { exitCode: 0, output: `${totalSynced} career entries synced` };
}

// ── Command dispatch ─────────────────────────────────────────────────

export const commands: Record<
  string,
  (args: string[], options: CommandOptions) => Promise<CommandResult>
> = {
  discover: discoverCommand,
  create: createCommand,
  'import-careers': importCareersCommand,
  'link-resources': linkResourcesCommand,
  default: discoverCommand,
};

export function getHelp(): string {
  return `
\x1b[1mPeople\x1b[0m — Person entity management tools

\x1b[1mCommands:\x1b[0m
  discover         Find people across data sources who are not in people.yaml (default)
  create           Generate YAML entity stubs for discovered candidates
  import-careers   Extract and preview career history data from KB
  link-resources   Match literature papers to person entities by author name

\x1b[1mOptions (discover/create):\x1b[0m
  --min-appearances=N   Only show people in N+ data sources (default: 1 for discover, 2 for create)
  --json                JSON output
  --ci                  JSON output (alias for --json)

\x1b[1mOptions (import-careers):\x1b[0m
  --sync                Push extracted career data to wiki-server

\x1b[1mOptions (link-resources):\x1b[0m
  --apply          Write results to data/people-resources.yaml
  --verbose        Show detailed output including unmatched authors

\x1b[1mCareer Import Sources (in priority order):\x1b[0m
  1. KB career-history records (packages/kb/data/things/)
  2. KB employed-by + role facts
  3. experts.yaml affiliation + role fields

\x1b[1mExamples:\x1b[0m
  crux people discover                     # List all candidates
  crux people discover --min-appearances=2 # Only people in 2+ sources
  crux people create                       # Generate YAML stubs (min 2 appearances)
  crux people import-careers               # Preview career extractions
  crux people import-careers --sync        # Push to wiki-server
  crux people link-resources               # Preview matches (dry run)
  crux people link-resources --apply       # Generate people-resources.yaml
  crux people link-resources --verbose     # Show all match details
`;
}
