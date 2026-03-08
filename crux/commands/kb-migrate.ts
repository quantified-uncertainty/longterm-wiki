/**
 * KB Migrate Command
 *
 * Migrates a single entity from the old data system (data/entities/*.yaml)
 * to the KB package (packages/kb/data/things/*.yaml).
 *
 * Usage:
 *   crux kb migrate <entity-slug> [--dry-run] [--stub-old]
 *
 *   --dry-run    Print the generated YAML without writing any files
 *   --stub-old   After migration, strip the old entity to a minimal stub
 */

import { join, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { generateStableId, generateFactId } from '../../packages/kb/src/ids.ts';

// ── Paths ─────────────────────────────────────────────────────────────

const ENTITIES_DIR = join(PROJECT_ROOT, 'data', 'entities');
const KB_THINGS_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data', 'things');

// ── Types ─────────────────────────────────────────────────────────────

interface OldEntity {
  id: string;
  numericId?: string;
  type: string;
  title?: string;
  name?: string;
  website?: string;
  description?: string;
  aliases?: string[];
  customFields?: Array<{ label: string; value: string }>;
  relatedEntries?: Array<{ id: string; type: string; relationship?: string }>;
  sources?: Array<{ title: string; url: string; author?: string; date?: string }>;
  tags?: string[];
  lastUpdated?: string;
  orgType?: string;
  summaryPage?: string;
  severity?: string;
  likelihood?: Record<string, unknown>;
  timeframe?: Record<string, unknown>;
  maturity?: string;
  clusters?: string[];
  path?: string;
  [key: string]: unknown;
}

interface KBCommandOptions extends BaseOptions {
  dryRun?: boolean;
  'dry-run'?: boolean;
  stubOld?: boolean;
  'stub-old'?: boolean;
}

// ── Entity type mapping ───────────────────────────────────────────────

/**
 * Maps old entity types to KB thing types.
 * Only types that need remapping are listed; others pass through.
 */
const TYPE_MAP: Record<string, string> = {
  crux: 'debate',
  'safety-agenda': 'approach',
  historical: 'event',
  model: 'analysis',
};

/**
 * KB types that have schemas (things that can actually live in KB).
 */
const VALID_KB_TYPES = new Set([
  'ai-model',
  'analysis',
  'approach',
  'argument',
  'capability',
  'concept',
  'debate',
  'event',
  'organization',
  'person',
  'policy',
  'project',
  'risk',
]);

// ── Helpers ───────────────────────────────────────────────────────────

/** Validate E-prefix numericId format (e.g., "E22") */
function isValidNumericId(numericId: string): boolean {
  return /^E\d+$/.test(numericId);
}

/** Get today's date as YYYY-MM (matches KB convention) */
function today(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Find an entity by slug across all entity YAML files.
 * Returns the entity and the source file path.
 */
function findEntity(slug: string): { entity: OldEntity; filePath: string; allEntities: OldEntity[] } | null {
  const files = readdirSync(ENTITIES_DIR).filter((f) => f.endsWith('.yaml'));

  for (const file of files) {
    const filePath = join(ENTITIES_DIR, file);
    const content = readFileSync(filePath, 'utf-8');
    const entities = parseYaml(content) as OldEntity[];
    if (!Array.isArray(entities)) continue;

    const entity = entities.find((e) => e.id === slug);
    if (entity) {
      return { entity, filePath, allEntities: entities };
    }
  }

  return null;
}

/**
 * Build the KB thing YAML structure from an old entity.
 */
function buildKBThing(entity: OldEntity): { yaml: string; warnings: string[] } {
  const warnings: string[] = [];
  const todayDate = today();

  // Map entity type
  const kbType = TYPE_MAP[entity.type] ?? entity.type;
  if (!VALID_KB_TYPES.has(kbType)) {
    warnings.push(`Type "${entity.type}" maps to "${kbType}" which is not a known KB type. The file will be created but may fail KB validation.`);
  }

  // Build thing section
  const thing: Record<string, unknown> = {
    id: entity.id,
    stableId: generateStableId(),
    type: kbType,
    name: entity.title || entity.name || entity.id,
  };
  if (entity.numericId && isValidNumericId(entity.numericId)) {
    thing.numericId = entity.numericId; // Keep E-prefix format (e.g., "E22")
  } else if (entity.numericId) {
    warnings.push(`numericId "${entity.numericId}" doesn't match E-prefix format. Skipped.`);
  }
  if (entity.aliases && entity.aliases.length > 0) {
    thing.aliases = entity.aliases;
  }

  // Build facts array
  const facts: Array<Record<string, unknown>> = [];

  // description -> facts.description
  if (entity.description) {
    // Clean up multi-paragraph descriptions (collapse double newlines)
    const cleanDesc = entity.description.replace(/\n\n+/g, '\n\n').trim();
    facts.push({
      id: generateFactId(),
      property: 'description',
      value: cleanDesc,
      asOf: todayDate,
      notes: 'Migrated from old entity system',
    });
  }

  // website -> facts.website
  if (entity.website) {
    facts.push({
      id: generateFactId(),
      property: 'website',
      value: entity.website,
    });
  }

  // Log warnings for unmapped fields
  if (entity.customFields && entity.customFields.length > 0) {
    const labels = entity.customFields.map((f) => f.label).join(', ');
    warnings.push(`Skipped ${entity.customFields.length} customFields: ${labels}. These need manual migration.`);
  }

  if (entity.relatedEntries && entity.relatedEntries.length > 0) {
    warnings.push(`Skipped ${entity.relatedEntries.length} relatedEntries. These remain in the old entity system.`);
  }

  if (entity.sources && entity.sources.length > 0) {
    warnings.push(`Entity has ${entity.sources.length} source(s). These are not migrated to KB facts — consider adding them as source fields on individual facts.`);
  }

  if (entity.tags && entity.tags.length > 0) {
    warnings.push(`Skipped ${entity.tags.length} tags: ${entity.tags.join(', ')}. KB does not have a tags system.`);
  }

  // Type-specific fields that are skipped
  const skippedFields: string[] = [];
  if (entity.orgType) skippedFields.push('orgType');
  if (entity.summaryPage) skippedFields.push('summaryPage');
  if (entity.severity) skippedFields.push('severity');
  if (entity.likelihood) skippedFields.push('likelihood');
  if (entity.timeframe) skippedFields.push('timeframe');
  if (entity.maturity) skippedFields.push('maturity');
  if (entity.clusters) skippedFields.push('clusters');
  if (entity.path) skippedFields.push('path');
  if (skippedFields.length > 0) {
    warnings.push(`Skipped type-specific fields: ${skippedFields.join(', ')}. These may need manual migration.`);
  }

  // Build the YAML document
  const doc: Record<string, unknown> = { thing };
  if (facts.length > 0) {
    doc.facts = facts;
  }

  // Stringify with options matching existing KB file style.
  // Use PLAIN default so simple identifiers (slugs, dates, property names)
  // stay unquoted, matching hand-authored KB files.
  const yaml = stringifyYaml(doc, {
    lineWidth: 120,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
    singleQuote: false,
  });

  return { yaml, warnings };
}

/**
 * Build a stubbed-out version of the old entity, keeping only essential fields.
 */
function buildStubEntity(entity: OldEntity): OldEntity {
  const stub: OldEntity = {
    id: entity.id,
    ...(entity.numericId && { numericId: entity.numericId }),
    type: entity.type,
    title: entity.title || entity.name,
  } as OldEntity;

  // Keep relatedEntries since they're not migrated to KB
  if (entity.relatedEntries && entity.relatedEntries.length > 0) {
    stub.relatedEntries = entity.relatedEntries;
  }

  return stub;
}

// ── Main command ──────────────────────────────────────────────────────

async function migrateCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const slug = args.find((a) => !a.startsWith('--'));
  const dryRun = options.dryRun || options['dry-run'] || false;
  const stubOld = options.stubOld || options['stub-old'] || false;

  if (!slug) {
    return {
      exitCode: 1,
      output: `Usage: crux kb migrate <entity-slug> [--dry-run] [--stub-old]

  Migrate an entity from data/entities/*.yaml to packages/kb/data/things/*.yaml.

Options:
  --dry-run    Print the generated YAML without writing any files
  --stub-old   After migration, strip the old entity to a minimal stub

Examples:
  crux kb migrate deepmind --dry-run
  crux kb migrate ajeya-cotra --stub-old
  crux kb migrate authentication-collapse`,
    };
  }

  // 1. Check if KB thing already exists
  const kbPath = join(KB_THINGS_DIR, `${slug}.yaml`);
  if (existsSync(kbPath)) {
    return {
      exitCode: 1,
      output: `KB thing already exists at ${kbPath}\nUse 'crux kb show ${slug}' to inspect it.`,
    };
  }

  // 2. Find the entity in old system
  const result = findEntity(slug);
  if (!result) {
    return {
      exitCode: 1,
      output: `Entity "${slug}" not found in data/entities/*.yaml`,
    };
  }

  const { entity, filePath, allEntities } = result;

  // 3. Build KB YAML
  const { yaml, warnings } = buildKBThing(entity);

  // 4. Output
  const lines: string[] = [];

  if (dryRun) {
    lines.push('\x1b[1m=== DRY RUN — KB Thing YAML ===\x1b[0m');
    lines.push(`Source: ${filePath}`);
    lines.push(`Target: ${kbPath}`);
    lines.push('');
    lines.push(yaml);
  } else {
    // Write KB thing file
    writeFileSync(kbPath, yaml, 'utf-8');
    lines.push(`\x1b[32mCreated KB thing:\x1b[0m ${kbPath}`);

    // Optionally stub the old entity
    if (stubOld) {
      const stubEntity = buildStubEntity(entity);
      const entityIndex = allEntities.findIndex((e) => e.id === slug);
      if (entityIndex >= 0) {
        allEntities[entityIndex] = stubEntity;
        const updatedYaml = stringifyYaml(allEntities, {
          lineWidth: 120,
        });
        // Add comment header and migration note
        const headerMatch = readFileSync(filePath, 'utf-8').match(/^#[^\n]*\n(?:#[^\n]*\n)*/);
        const header = headerMatch ? headerMatch[0] : '';
        // Write to temp file first, then atomic rename to avoid data loss on crash
        const tmpPath = join(dirname(filePath), `.${slug}.yaml.tmp`);
        writeFileSync(tmpPath, header + updatedYaml, 'utf-8');
        renameSync(tmpPath, filePath);
        lines.push(`\x1b[33mStubbed old entity in:\x1b[0m ${filePath}`);
        lines.push('  Kept: id, numericId, type, title, relatedEntries');
        lines.push('  Removed: description, website, sources, tags, customFields, type-specific fields');
      }
    }
  }

  // Show warnings
  if (warnings.length > 0) {
    lines.push('');
    lines.push('\x1b[33mWarnings:\x1b[0m');
    for (const w of warnings) {
      lines.push(`  - ${w}`);
    }
  }

  // Summary
  lines.push('');
  lines.push(`Entity: ${entity.title || entity.name} (${entity.id})`);
  lines.push(`Type: ${entity.type} -> ${TYPE_MAP[entity.type] ?? entity.type}`);
  if (entity.numericId) {
    lines.push(`NumericId: ${entity.numericId}`);
  }

  if (!dryRun) {
    lines.push('');
    lines.push('Next steps:');
    lines.push(`  1. Review and enrich: packages/kb/data/things/${slug}.yaml`);
    lines.push('  2. Add facts (born-year, role, employed-by, etc.) with sources');
    lines.push('  3. Validate: pnpm crux kb validate');
    lines.push('  4. Check: pnpm crux kb show ' + slug);
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Exports ───────────────────────────────────────────────────────────

export const commands = {
  default: migrateCommand,
};

export function getHelp(): string {
  return `
KB Migrate — Migrate entities from old system to KB

Usage:
  crux kb migrate <entity-slug> [--dry-run] [--stub-old]

  Reads an entity from data/entities/*.yaml and creates a new KB thing file
  at packages/kb/data/things/<slug>.yaml with the mapped structure.

Options:
  --dry-run    Print the generated YAML without writing any files
  --stub-old   After migration, strip the old entity down to a minimal stub
               (keeps id, numericId, type, title, relatedEntries)

Type Mapping:
  crux         -> debate
  safety-agenda -> approach
  historical   -> event
  (all others pass through unchanged)

What gets migrated:
  - id, numericId, type, name/title, aliases
  - description -> facts[].property: description
  - website -> facts[].property: website

What gets skipped (with warnings):
  - customFields (need manual migration)
  - relatedEntries (stay in old system)
  - sources (not auto-mapped to individual facts)
  - tags (KB has no tags system)
  - Type-specific fields (severity, likelihood, timeframe, etc.)

Examples:
  crux kb migrate deepmind --dry-run        Preview migration
  crux kb migrate ajeya-cotra               Create KB thing file
  crux kb migrate ajeya-cotra --stub-old    Create KB thing + strip old entity
`;
}
