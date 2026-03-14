/**
 * Backfill stableIds into entity YAML files.
 *
 * For each entity in data/entities/*.yaml that lacks a stableId:
 *   1. Checks packages/kb/data/things/{slug}.yaml for an existing stableId
 *   2. If none, generates a new random 10-char alphanumeric ID
 *   3. Inserts the stableId line right after the `id:` line in the YAML
 *
 * Uses string manipulation (not parse+stringify) to preserve existing formatting.
 *
 * Usage:
 *   crux backfill-yaml-stable-ids run              Run the backfill
 *   crux backfill-yaml-stable-ids run --dry-run     Preview without writing
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { generateId } from '../../packages/kb/src/ids.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';

const ENTITIES_DIR = join(PROJECT_ROOT, 'data', 'entities');
const KB_THINGS_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data', 'things');

interface KBThing {
  thing?: {
    id?: string;
    stableId?: string;
  };
}

/**
 * Load stableId from a KB thing file if it exists.
 */
function getKBStableId(slug: string): string | null {
  const kbPath = join(KB_THINGS_DIR, `${slug}.yaml`);
  if (!existsSync(kbPath)) return null;

  try {
    const raw = readFileSync(kbPath, 'utf-8');
    const parsed = parseYaml(raw) as KBThing;
    return parsed?.thing?.stableId ?? null;
  } catch {
    return null;
  }
}

/**
 * Collect all existing stableIds from entity YAML files to prevent collisions.
 */
function collectExistingStableIds(): Set<string> {
  const ids = new Set<string>();
  const files = readdirSync(ENTITIES_DIR).filter((f) => f.endsWith('.yaml'));

  for (const file of files) {
    const raw = readFileSync(join(ENTITIES_DIR, file), 'utf-8');
    const matches = raw.matchAll(/^\s+stableId:\s+(\S+)/gm);
    for (const match of matches) {
      ids.add(match[1]);
    }
  }

  // Also collect from KB thing files
  if (existsSync(KB_THINGS_DIR)) {
    const kbFiles = readdirSync(KB_THINGS_DIR).filter((f) => f.endsWith('.yaml'));
    for (const file of kbFiles) {
      try {
        const raw = readFileSync(join(KB_THINGS_DIR, file), 'utf-8');
        const match = raw.match(/stableId:\s+(\S+)/);
        if (match) ids.add(match[1]);
      } catch {
        // Skip unreadable KB files
      }
    }
  }

  return ids;
}

/**
 * Generate a unique stableId that doesn't collide with existing ones.
 */
function generateUniqueId(existing: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = generateId();
    if (!existing.has(id)) {
      existing.add(id);
      return id;
    }
  }
  throw new Error('Failed to generate unique stableId after 100 attempts');
}

/**
 * Process a single entity YAML file, adding stableIds where missing.
 * Returns the modified content and stats.
 */
function processFile(
  filePath: string,
  existingIds: Set<string>,
  dryRun: boolean,
): { content: string; added: number; fromKB: number; alreadyHad: number } {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const result: string[] = [];
  let added = 0;
  let fromKB = 0;
  let alreadyHad = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Match entity start: "- id: some-slug"
    const idMatch = line.match(/^- id:\s+(.+)$/);
    if (idMatch) {
      const slug = idMatch[1].trim();
      result.push(line);
      i++;

      // Check if next line already has stableId
      if (i < lines.length && lines[i].match(/^\s+stableId:\s+/)) {
        // Already has stableId, keep it
        alreadyHad++;
        result.push(lines[i]);
        i++;
        continue;
      }

      // Need to add stableId — check KB first, then generate
      let stableId = getKBStableId(slug);
      let source: 'kb' | 'generated';

      if (stableId) {
        source = 'kb';
        // Make sure it's not a collision with a different entity
        if (existingIds.has(stableId)) {
          console.warn(`  WARN: KB stableId ${stableId} for ${slug} already in use — generating new one`);
          stableId = generateUniqueId(existingIds);
          source = 'generated';
        } else {
          existingIds.add(stableId);
        }
        if (source === 'kb') fromKB++;
      } else {
        stableId = generateUniqueId(existingIds);
        source = 'generated';
      }

      // Insert stableId line with 2-space indent (matching other fields)
      result.push(`  stableId: ${stableId}`);
      added++;
      continue;
    }

    result.push(line);
    i++;
  }

  const content = result.join('\n');

  if (!dryRun && added > 0) {
    writeFileSync(filePath, content, 'utf-8');
  }

  return { content, added, fromKB, alreadyHad };
}

async function runCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const dryRun = options['dry-run'] === true || options['dry-run'] === 'true'
    || options['dryRun'] === true || options['dryRun'] === 'true';

  const lines: string[] = [];
  lines.push(dryRun ? '=== DRY RUN ===' : '=== Backfilling stableIds into entity YAML files ===');
  lines.push('');

  // Collect all existing stableIds first
  const existingIds = collectExistingStableIds();
  lines.push(`Found ${existingIds.size} existing stableIds across entity and KB files`);
  lines.push('');

  const files = readdirSync(ENTITIES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort();

  let totalAdded = 0;
  let totalFromKB = 0;
  let totalAlreadyHad = 0;

  for (const file of files) {
    const filePath = join(ENTITIES_DIR, file);
    const result = processFile(filePath, existingIds, dryRun);

    const status = result.added > 0
      ? `+${result.added} added (${result.fromKB} from KB, ${result.added - result.fromKB} generated)`
      : 'all present';
    lines.push(`${file}: ${result.alreadyHad} already had, ${status}`);

    totalAdded += result.added;
    totalFromKB += result.fromKB;
    totalAlreadyHad += result.alreadyHad;
  }

  lines.push('');
  lines.push(`Total: ${totalAlreadyHad} already had stableIds, ${totalAdded} added`);
  lines.push(`  From KB: ${totalFromKB}`);
  lines.push(`  Generated: ${totalAdded - totalFromKB}`);
  lines.push(`  Unique IDs total: ${existingIds.size}`);

  if (dryRun) {
    lines.push('');
    lines.push('Run without --dry-run to apply.');
  }

  return { exitCode: 0, output: lines.join('\n') };
}

export const commands = {
  run: runCommand,
};

export function getHelp(): string {
  return `
Backfill stableIds into Entity YAML Files

Reads entity YAML files from data/entities/*.yaml and inserts a stableId
field for any entity that doesn't have one. StableIds are sourced from
KB thing files (packages/kb/data/things/*.yaml) when available, otherwise
a new random 10-char alphanumeric ID is generated.

Usage:
  crux backfill-yaml-stable-ids run              Run the backfill
  crux backfill-yaml-stable-ids run --dry-run     Preview without writing

The stableId is inserted as the second field after \`id:\`, matching the
existing convention in the entity YAML files.
`;
}
