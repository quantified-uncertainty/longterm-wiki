/**
 * Backfill stable IDs for existing entities.
 *
 * Reads stableIds from KB YAML files and pushes them to the wiki-server's
 * entity_ids table. Then generates new stableIds for any entities that
 * don't have KB entries.
 *
 * Usage:
 *   crux backfill-stable-ids run [--dry-run]
 */

import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import { loadGraphFull } from '../lib/kb-loader.ts';
import { apiRequest, getServerUrl, isServerAvailable } from '../lib/wiki-server/client.ts';

interface BackfillResult {
  updated: number;
  generated: number;
  totalMissing: number;
}

async function runCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const dryRun = options['dry-run'] === true || options['dry-run'] === 'true';

  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { exitCode: 1, output: 'Error: LONGTERMWIKI_SERVER_URL not configured' };
  }

  const available = await isServerAvailable();
  if (!available) {
    return { exitCode: 1, output: 'Error: Wiki server is not reachable' };
  }

  // Load KB graph to get stableIds from YAML
  const kb = await loadGraphFull();
  const allEntities = kb.graph.getAllEntities();

  const lines: string[] = [];
  lines.push(`Loaded ${allEntities.length} KB entities with stableIds`);

  // Build slug → stableId map from KB.
  // The KB graph keys entities by stableId (entity.id = stableId).
  // The filenameMap maps stableId → filename (slug).
  const slugToStableId: Array<{ slug: string; stableId: string }> = [];

  for (const entity of allEntities) {
    const filename = kb.filenameMap.get(entity.id);
    if (filename && entity.id.length === 10) {
      slugToStableId.push({ slug: filename, stableId: entity.id });
    }
  }

  lines.push(`Found ${slugToStableId.length} slug→stableId mappings from KB`);

  if (dryRun) {
    lines.push('');
    lines.push('Dry run — showing first 20 mappings:');
    for (const item of slugToStableId.slice(0, 20)) {
      lines.push(`  ${item.slug.padEnd(30)} → ${item.stableId}`);
    }
    lines.push('');
    lines.push('Run without --dry-run to apply.');
    return { exitCode: 0, output: lines.join('\n') };
  }

  // Send to server in batches of 200
  let totalUpdated = 0;
  let totalGenerated = 0;

  for (let i = 0; i < slugToStableId.length; i += 200) {
    const batch = slugToStableId.slice(i, i + 200);
    const result = await apiRequest<BackfillResult>(
      'POST',
      '/api/ids/backfill-stable-ids',
      { items: batch },
    );

    if (!result.ok) {
      lines.push(`Error in batch ${i}-${i + batch.length}: ${result.message}`);
      return { exitCode: 1, output: lines.join('\n') };
    }

    totalUpdated += result.data.updated;
    totalGenerated += result.data.generated;
  }

  lines.push(`Updated ${totalUpdated} existing entities with KB stableIds`);
  lines.push(`Generated ${totalGenerated} new stableIds for entities without KB entries`);

  return { exitCode: 0, output: lines.join('\n') };
}

export const commands = {
  run: runCommand,
};

export function getHelp(): string {
  return `
Backfill Stable IDs

Reads stableIds from KB YAML files (packages/kb/data/things/*.yaml) and
writes them to the wiki-server entity_ids table. Then generates new stableIds
for any entities that don't have KB entries.

Usage:
  crux backfill-stable-ids run              Run the backfill
  crux backfill-stable-ids run --dry-run    Preview without writing

This is a one-time migration command. After running, all entities in the
entity_ids table will have a stable_id column populated.
`;
}
