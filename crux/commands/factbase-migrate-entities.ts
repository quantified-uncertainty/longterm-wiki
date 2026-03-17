/**
 * FactBase Entity Migration — Transform YAML files from `thing:` blocks to `entity:` references
 *
 * Transforms FactBase YAML files from the full `thing:` block format to the minimal
 * `entity: <stableId>` format, as part of Entity Unification Phase 4.
 *
 * Before:
 *   thing:
 *     id: anthropic
 *     stableId: mK9pX3rQ7n
 *     type: organization
 *     name: Anthropic
 *     wikiId: "E22"
 *     aliases: [Anthropic PBC]
 *   facts:
 *     - ...
 *
 * After:
 *   entity: mK9pX3rQ7n
 *   facts:
 *     - ...
 *
 * Usage:
 *   crux factbase-migrate-entities run [--dry-run]    Transform all YAML files
 *   crux factbase-migrate-entities status              Show migration status
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';

const KB_THINGS_DIR = join(PROJECT_ROOT, 'packages', 'factbase', 'data', 'things');

interface MigrateOptions extends BaseOptions {
  dryRun?: boolean;
  'dry-run'?: boolean;
}

/**
 * Extract the stableId from a thing: block in YAML text.
 * Handles both old format (stableId field) and new format (id is the stableId).
 */
function extractStableId(thingBlock: string): string | null {
  // Try stableId field first (old format)
  const stableIdMatch = thingBlock.match(/^\s+stableId:\s*(\S+)/m);
  if (stableIdMatch) {
    return stableIdMatch[1];
  }

  // New format: id is the stableId (10-char alphanum), and slug field exists
  const slugMatch = thingBlock.match(/^\s+slug:\s*\S+/m);
  if (slugMatch) {
    const idMatch = thingBlock.match(/^\s+id:\s*(\S+)/m);
    if (idMatch) {
      return idMatch[1];
    }
  }

  return null;
}

/**
 * Transform a single YAML file from thing: block to entity: reference.
 * Uses text-based replacement to preserve comments and formatting.
 *
 * Returns { transformed: true, stableId } on success,
 *         { transformed: false, reason } on skip.
 */
function transformFile(
  content: string,
): { transformed: true; stableId: string; result: string } | { transformed: false; reason: string } {
  // Already in new format?
  if (content.match(/^entity:\s*\S+/m) && !content.match(/^thing:/m)) {
    return { transformed: false, reason: 'already migrated' };
  }

  // Find the thing: block. It starts with "thing:" at the beginning of a line
  // and ends at the next top-level key (facts:, _sources:, or end of file).
  // The regex also matches blank lines (whitespace-only) within the indented block
  // to avoid truncating thing: blocks that contain blank lines in their headers.
  const thingMatch = content.match(/^thing:\n((?:(?:[ \t]+.*|[ \t]*)\n)*)/m);
  if (!thingMatch) {
    return { transformed: false, reason: 'no thing: block found' };
  }

  const fullThingBlock = thingMatch[0]; // "thing:\n  id: ...\n  stableId: ...\n..."
  const thingBody = thingMatch[1]; // The indented content after "thing:"

  const stableId = extractStableId(thingBody);
  if (!stableId) {
    return { transformed: false, reason: 'could not extract stableId from thing: block' };
  }

  // Replace the thing: block with entity: <stableId>
  // The thing: block may or may not have a trailing blank line before the next section
  const result = content.replace(fullThingBlock, `entity: ${stableId}\n`);

  return { transformed: true, stableId, result };
}

// ── run command ────────────────────────────────────────────────────────

async function runCommand(
  args: string[],
  options: MigrateOptions,
): Promise<CommandResult> {
  const dryRun = options.dryRun || options['dry-run'] || false;
  const entries = readdirSync(KB_THINGS_DIR);
  const yamlFiles = entries.filter(
    (e) => extname(e) === '.yaml' || extname(e) === '.yml',
  );

  const lines: string[] = [];
  let transformed = 0;
  let skipped = 0;
  let errors = 0;

  lines.push(`\x1b[1mFactBase Entity Migration${dryRun ? ' (DRY RUN)' : ''}\x1b[0m`);
  lines.push(`Scanning ${yamlFiles.length} YAML files in packages/factbase/data/things/\n`);

  for (const filename of yamlFiles.sort()) {
    const filePath = join(KB_THINGS_DIR, filename);
    const content = readFileSync(filePath, 'utf-8');

    const result = transformFile(content);

    if (!result.transformed) {
      if (result.reason !== 'already migrated') {
        lines.push(`  \x1b[33mSKIP\x1b[0m ${filename}: ${result.reason}`);
      }
      skipped++;
      continue;
    }

    transformed++;
    lines.push(`  \x1b[32m OK \x1b[0m ${filename} -> entity: ${result.stableId}`);

    if (!dryRun) {
      writeFileSync(filePath, result.result, 'utf-8');
    }
  }

  lines.push('');
  lines.push(`\x1b[1mResults:\x1b[0m`);
  lines.push(`  Transformed: ${transformed}`);
  lines.push(`  Skipped: ${skipped}`);
  if (errors > 0) {
    lines.push(`  \x1b[31mErrors: ${errors}\x1b[0m`);
  }
  if (dryRun) {
    lines.push(`\n  \x1b[33mDry run — no files were modified. Run without --dry-run to apply.\x1b[0m`);
  }

  return { exitCode: errors > 0 ? 1 : 0, output: lines.join('\n') };
}

// ── status command ────────────────────────────────────────────────────

async function statusCommand(
  _args: string[],
  _options: MigrateOptions,
): Promise<CommandResult> {
  const entries = readdirSync(KB_THINGS_DIR);
  const yamlFiles = entries.filter(
    (e) => extname(e) === '.yaml' || extname(e) === '.yml',
  );

  let oldFormat = 0;
  let newFormat = 0;
  let unknown = 0;

  for (const filename of yamlFiles) {
    const filePath = join(KB_THINGS_DIR, filename);
    const content = readFileSync(filePath, 'utf-8');

    if (content.match(/^entity:\s*\S+/m) && !content.match(/^thing:/m)) {
      newFormat++;
    } else if (content.match(/^thing:/m)) {
      oldFormat++;
    } else {
      unknown++;
    }
  }

  const lines: string[] = [];
  lines.push(`\x1b[1mFactBase Entity Migration Status\x1b[0m`);
  lines.push(`Total files: ${yamlFiles.length}`);
  lines.push(`  Old format (thing:): ${oldFormat}`);
  lines.push(`  New format (entity:): ${newFormat}`);
  if (unknown > 0) {
    lines.push(`  \x1b[33mUnknown format: ${unknown}\x1b[0m`);
  }

  const pct = yamlFiles.length > 0
    ? Math.round((newFormat / yamlFiles.length) * 100)
    : 0;
  lines.push(`\nMigration progress: ${pct}%`);

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Exports ─────────────────────────────────────────────────────────

export const commands = {
  run: runCommand,
  status: statusCommand,
};

export function getHelp(): string {
  return `
FactBase Entity Migration — Transform YAML files from thing: blocks to entity: references

Commands:
  run [--dry-run]     Transform all YAML files from thing: to entity: format
  status              Show migration status (how many files in each format)

Options:
  --dry-run           Preview changes without modifying files

Examples:
  crux factbase-migrate-entities run --dry-run    Preview migration
  crux factbase-migrate-entities run              Apply migration
  crux factbase-migrate-entities status           Check progress
`;
}
