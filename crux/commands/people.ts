/**
 * People Command Handlers
 *
 * CLI tools for managing person entity data.
 *
 * Usage:
 *   crux people link-resources [--apply] [--verbose]   Match resources/literature to person entities
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';

const DATA_DIR = join(import.meta.dirname, '../../data');

interface PeopleCommandOptions extends BaseOptions {
  apply?: boolean;
  verbose?: boolean;
}

// ── Types ────────────────────────────────────────────────────────────

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

interface LiteratureCategory {
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

// ── Name matching ────────────────────────────────────────────────────

/**
 * Normalize a name for matching: lowercase, trim, remove accents.
 */
function normalizeName(name: string): string {
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
function buildAuthorLookup(people: PersonEntity[]): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const person of people) {
    // Clean the title (some have parenthetical descriptions)
    const cleanName = person.title.replace(/\s*\(.*?\)\s*$/, '').trim();
    const normalized = normalizeName(cleanName);
    lookup.set(normalized, person.id);

    // Also index by "First Last" if the title had extra info
    if (cleanName !== person.title) {
      lookup.set(normalizeName(person.title), person.id);
    }
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
function matchAuthor(
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
  options: PeopleCommandOptions,
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
  const categories: LiteratureCategory[] = litData.categories || [];

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

// ── Command dispatch ─────────────────────────────────────────────────

export const commands = {
  'link-resources': linkResourcesCommand,
  default: linkResourcesCommand,
};

export function getHelp(): string {
  return `
\x1b[1mPeople\x1b[0m — Person entity management tools

\x1b[1mCommands:\x1b[0m
  link-resources   Match literature papers to person entities by author name

\x1b[1mOptions:\x1b[0m
  --apply          Write results to data/people-resources.yaml
  --verbose        Show detailed output including unmatched authors

\x1b[1mExamples:\x1b[0m
  crux people link-resources                  Preview matches (dry run)
  crux people link-resources --apply          Generate people-resources.yaml
  crux people link-resources --verbose        Show all match details
`;
}
