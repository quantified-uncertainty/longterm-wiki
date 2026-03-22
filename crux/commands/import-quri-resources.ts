/**
 * Import QURI recommended reading list and videos from CSV files to wiki-server.
 *
 * Usage:
 *   pnpm crux tb import-quri-resources sync --dry-run   # Preview what would be synced
 *   pnpm crux tb import-quri-resources sync             # Sync to wiki-server
 *   pnpm crux tb import-quri-resources sync /path/to/resources.csv /path/to/videos.csv
 *
 * Default CSV paths (when no args given):
 *   ~/Downloads/Recommended Resources-Grid view.csv
 *   ~/Downloads/Videos-Gallery.csv
 */

import type { CommandResult } from '../lib/command-types.ts';
import { apiRequest, getServerUrl } from '../lib/wiki-server/client.ts';
import { parseCSVLine, reassembleCSVRows } from '../lib/grant-import/csv.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const QURI_ENTITY_ID = 'Khej79OA8g';

// ---------------------------------------------------------------------------
// CSV Parsing (reuses grant-import csv utilities)
// ---------------------------------------------------------------------------

function parseCSV(content: string): Record<string, string>[] {
  const headerLine = content.split('\n')[0];
  if (!headerLine) return [];
  const headers = parseCSVLine(headerLine);
  return reassembleCSVRows(content).map((line) => {
    const values = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (values[i] ?? '').trim();
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Field Mappers
// ---------------------------------------------------------------------------

function mapCategory(formats: string): string {
  if (!formats) return 'book';
  const f = formats.toLowerCase();
  if (f.includes('textbook')) return 'textbook';
  if (f.includes('video')) return 'video';
  if (f.includes('graphic novel')) return 'book';
  return 'book';
}

function mapTopics(topicsStr: string): string[] {
  if (!topicsStr) return [];
  const topics: string[] = [];
  if (topicsStr.includes('Estimation')) topics.push('estimation');
  if (topicsStr.includes('Epistemics')) topics.push('epistemics');
  if (topicsStr.includes('Forecasting')) topics.push('forecasting');
  if (topicsStr.includes('Ontology')) topics.push('ontology');
  if (topicsStr.includes('Software')) topics.push('software');
  return topics;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

async function syncCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const dryRun = !!options['dry-run'];
  const lines: string[] = [];

  if (!getServerUrl()) {
    return {
      exitCode: 1,
      output:
        'wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod.',
    };
  }

  lines.push('\n  QURI Recommended Resources Import');
  lines.push(`  ${'='.repeat(40)}`);

  const defaultDir = resolve(process.env.HOME ?? '.', 'Downloads');

  // ---- Parse recommended resources CSV ----
  const resourcesPath = args[0] || resolve(defaultDir, 'Recommended Resources-Grid view.csv');
  let resourceItems: Record<string, unknown>[] = [];
  try {
    const csv = readFileSync(resourcesPath, 'utf-8');
    const rows = parseCSV(csv);
    resourceItems = rows.map((row, i) => ({
      entityId: QURI_ENTITY_ID,
      title: row.Name || `Unknown Resource ${i}`,
      url: row.Url || null,
      authors: row.Authors || null,
      publishedDate: row.Year || null,
      category: mapCategory(row.Formats),
      topics: mapTopics(row.Topics),
      isSeminal: (row.Tags || '').includes('Top Recommendation'),
      sortOrder: i,
      notes: row.Review || null,
    }));
    lines.push(`  Found ${resourceItems.length} recommended resources`);
  } catch (err) {
    lines.push(`  WARNING: Could not read ${resourcesPath}: ${err}`);
  }

  // ---- Parse videos CSV ----
  const videosPath = args[1] || resolve(defaultDir, 'Videos-Gallery.csv');
  let videoItems: Record<string, unknown>[] = [];
  try {
    const csv = readFileSync(videosPath, 'utf-8');
    const rows = parseCSV(csv);
    videoItems = rows.map((row, i) => {
      const published = row.Published;
      let year: string | null = null;
      if (published) {
        const parts = published.split('/');
        if (parts.length === 3) year = parts[2];
        else year = published;
      }
      const notesParts = [
        row.Type ? `Type: ${row.Type}` : '',
        row.Description || '',
      ].filter(Boolean);
      return {
        entityId: QURI_ENTITY_ID,
        title: (row.Name || '').trim(),
        url: row.Url || null,
        publishedDate: year,
        category: 'video',
        topics: ['epistemics'],
        isSeminal: false,
        sortOrder: resourceItems.length + i,
        notes: notesParts.join('. ') || null,
      };
    });
    lines.push(`  Found ${videoItems.length} video resources`);
  } catch (err) {
    lines.push(`  WARNING: Could not read ${videosPath}: ${err}`);
  }

  const allItems = [...resourceItems, ...videoItems];

  if (allItems.length === 0) {
    lines.push('\n  No items to import');
    return { exitCode: 0, output: lines.join('\n') };
  }

  if (dryRun) {
    for (const item of allItems) {
      const seminal = item.isSeminal ? ' *' : '';
      lines.push(`    - [${item.category}] ${item.title}${seminal}`);
    }
    lines.push(`\n  DRY RUN: would sync ${allItems.length} items`);
    return { exitCode: 0, output: lines.join('\n') };
  }

  // ---- Sync in batches of 50 ----
  let synced = 0;
  const batchSize = 50;
  for (let i = 0; i < allItems.length; i += batchSize) {
    const batch = allItems.slice(i, i + batchSize);
    const result = await apiRequest('POST', '/api/entity-recommended-resources/sync', {
      items: batch,
    });
    if (!result.ok) {
      lines.push(
        `\n  Batch ${Math.floor(i / batchSize) + 1} failed: ${result.message}`,
      );
      return { exitCode: 1, output: lines.join('\n') };
    }
    synced += batch.length;
  }

  lines.push(`\n  Sync complete: ${synced} resources imported`);
  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// CLI interface
// ---------------------------------------------------------------------------

export const commands: Record<
  string,
  (args: string[], options: Record<string, unknown>) => Promise<CommandResult>
> = {
  sync: syncCommand,
  default: syncCommand,
};

export function getHelp(): string {
  return `
Import QURI Resources — Import recommended reading list and videos from CSV

Commands:
  sync [resources.csv] [videos.csv]   Sync resources to wiki-server (default)

Options:
  --dry-run     Preview resources without writing

Default CSV paths (when no args given):
  ~/Downloads/Recommended Resources-Grid view.csv
  ~/Downloads/Videos-Gallery.csv
`;
}
