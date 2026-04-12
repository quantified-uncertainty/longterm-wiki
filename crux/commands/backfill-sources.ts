/**
 * Backfill missing source URLs across all tables.
 *
 * For each record that has no source URL:
 *   1. Fetch the record from the wiki-server missing-sources endpoint
 *   2. Build a targeted web search query from the record's description
 *   3. Search using the research agent (Exa + Perplexity + SCRY)
 *   4. Check if any fetched page content supports the record's claim
 *   5. Update the record's source field via the appropriate sync API
 *
 * Usage:
 *   pnpm crux tb backfill-sources --dry-run              # Preview what would be updated
 *   pnpm crux tb backfill-sources --limit=20 --apply     # Process 20 records and update
 *   pnpm crux tb backfill-sources --table=facts --apply  # Only facts
 */

import { apiRequest } from '../lib/wiki-server/client.ts';
import { runResearch } from '../lib/search/research-agent.ts';
import { getTableConfig } from '../tablebase/table-registry.ts';
type CommandResult = { exitCode?: number; output?: string };
type CommandOptions = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A record returned by the missing-sources endpoint. */
export interface MissingSourceRecord {
  record_id: string;
  record_table: string;
  entity_id: string | null;
  entity_name: string;
  description: string;
  // Table-specific fields used for match term extraction
  [key: string]: unknown;
}

interface MissingSourcesResponse {
  tables: Record<string, {
    total: number;
    records: MissingSourceRecord[];
  }>;
  totalMissing: number;
}

// ---------------------------------------------------------------------------
// Match term extraction — exported for testing
// ---------------------------------------------------------------------------

/**
 * Extract lowercase search terms from a record that should appear in a source page
 * for it to be considered relevant. Returns empty array if the record can't be matched.
 */
export function extractMatchTerms(record: MissingSourceRecord): string[] {
  const table = record.record_table;

  switch (table) {
    case 'facts': {
      const label = String(record.label ?? '').trim();
      if (label.length > 3) return [label.toLowerCase()];
      const value = String(record.value ?? '').trim();
      if (value.length > 3 && value.length < 100) return [value.toLowerCase()];
      return [];
    }
    case 'personnel': {
      const person = String(record.person_name ?? '').trim();
      return person.length > 1 ? [person.toLowerCase()] : [];
    }
    case 'investments': {
      const company = String(record.company_name ?? '').trim();
      return company.length > 1 ? [company.toLowerCase()] : [];
    }
    case 'equity_positions': {
      const holder = String(record.holder_name ?? '').trim();
      if (holder.length > 1) return [holder.replace(/-/g, ' ').toLowerCase()];
      return [];
    }
    case 'policy_stakeholders': {
      const name = String(record.stakeholder_display_name ?? '').trim();
      return name.length > 1 ? [name.toLowerCase()] : [];
    }
    case 'divisions':
    case 'funding_programs': {
      const name = String(record.name ?? '').trim();
      return name.length > 1 ? [name.toLowerCase()] : [];
    }
    case 'funding_rounds': {
      const name = String(record.name ?? '').trim();
      return name.length > 1 ? [name.toLowerCase()] : [];
    }
    case 'publications': {
      const title = String(record.title ?? '').trim();
      return title.length > 3 ? [title.toLowerCase()] : [];
    }
    case 'page_citations': {
      const note = String(record.note ?? record.cit_title ?? '').trim();
      return note.length > 10 ? [note.toLowerCase().slice(0, 80)] : [];
    }
    default:
      return [];
  }
}

/**
 * Check if page content contains all match terms (case-insensitive).
 */
export function contentMatchesRecord(content: string, matchTerms: string[]): boolean {
  if (matchTerms.length === 0 || content.length === 0) return false;
  const lower = content.toLowerCase();
  return matchTerms.every(term => lower.includes(term));
}

// ---------------------------------------------------------------------------
// Record type → sync API mapping
// ---------------------------------------------------------------------------

/** Map from PG table name to the sourcing record type used by sync endpoints. */
function tableToRecordType(table: string): string {
  switch (table) {
    case 'personnel': return 'personnel';
    case 'investments': return 'investments';
    case 'equity_positions': return 'equity-positions';
    case 'policy_stakeholders': return 'policy-stakeholders';
    case 'divisions': return 'divisions';
    case 'funding_rounds': return 'funding-rounds';
    case 'funding_programs': return 'funding-programs';
    case 'publications': return 'publications';
    default: return table;
  }
}

// ---------------------------------------------------------------------------
// Core: process one record
// ---------------------------------------------------------------------------

async function processRecord(
  record: MissingSourceRecord,
  options: { dryRun: boolean; apply: boolean },
): Promise<{ matched: boolean; url?: string; cost: number }> {
  const matchTerms = extractMatchTerms(record);
  if (matchTerms.length === 0) {
    return { matched: false, cost: 0 };
  }

  // Build a targeted search query
  const entityName = record.entity_name || '';
  const searchQuery = `${entityName} ${record.description}`.trim().slice(0, 200);

  let researchResult;
  try {
    researchResult = await runResearch({
      topic: searchQuery,
      pageContext: { title: entityName, type: 'unknown' },
      config: {
        maxResultsPerSource: 3,
        maxUrlsToFetch: 5,
        extractFacts: false,
        useGitHub: false,
        useSemanticScholar: false,
        useFederalRegister: false,
      },
      budgetCap: 0.10,
    });
  } catch (err: unknown) {
    console.warn(`  Search failed: ${err instanceof Error ? err.message : String(err)}`);
    return { matched: false, cost: 0 };
  }

  const cost = researchResult.metadata.totalCost;

  // Check each source for match terms
  for (const source of researchResult.sources) {
    const content = source.content || '';
    if (content.length < 50) continue;

    if (contentMatchesRecord(content, matchTerms)) {
      console.log(`  ✓ Match: ${source.url}`);

      if (options.apply && !options.dryRun) {
        await updateRecordSource(record, source.url);
      }

      return { matched: true, url: source.url, cost };
    }
  }

  return { matched: false, cost };
}

// ---------------------------------------------------------------------------
// Update source field via sync API
// ---------------------------------------------------------------------------

async function updateRecordSource(record: MissingSourceRecord, url: string): Promise<boolean> {
  const table = record.record_table;

  if (table === 'facts') {
    // Facts use /api/facts/sync with { facts: [{ entityId, factId, source }] }
    const result = await apiRequest<{ upserted?: number }>('POST', '/api/facts/sync', {
      facts: [{
        entityId: record.entity_id,
        factId: record.fact_id,
        source: url,
        // Preserve existing fields
        label: record.label ?? null,
        value: record.value ?? null,
        numeric: record.numeric ?? null,
        measure: record.measure ?? null,
        asOf: record.as_of ?? null,
        format: record.format ?? null,
      }],
    });
    return result.ok;
  }

  if (table === 'page_citations') {
    // No sync endpoint for page citations — skip
    console.warn(`  Skipping page_citation update (no sync endpoint)`);
    return false;
  }

  // Standard tablebase records — use table registry
  const registryName = tableToRecordType(table);
  const config = getTableConfig(registryName);
  if (!config) {
    console.warn(`  No table config for ${registryName}`);
    return false;
  }

  const result = await apiRequest<{ upserted?: number; updated?: number }>(
    config.syncMethod,
    config.syncPath,
    { [config.syncBodyKey]: [{ id: record.record_id, source: url }] },
  );
  return result.ok;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

async function backfillSourcesCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const dryRun = !!options.dryRun;
  const apply = !!options.apply;
  const limit = options.limit ? parseInt(options.limit as string, 10) : 20;
  const tableFilter = (options as Record<string, unknown>).table as string | undefined;

  if (!apply && !dryRun) {
    return {
      exitCode: 1,
      output: 'Specify --dry-run (preview) or --apply (update records). Use --dry-run first.',
    };
  }

  // 1. Fetch records missing sources
  const qs = new URLSearchParams({ limit: String(limit) });
  if (tableFilter) qs.set('table', tableFilter);

  console.log(`Fetching records without source URLs...`);
  const response = await apiRequest<MissingSourcesResponse>(
    'GET',
    `/api/sourcing/missing-sources?${qs.toString()}`,
  );

  if (!response.ok) {
    return { exitCode: 1, output: `Failed to fetch missing sources: ${response.message}` };
  }

  const { tables, totalMissing } = response.data;
  console.log(`Found ${totalMissing} records without sources.\n`);

  // Flatten all records into a single list
  const allRecords: MissingSourceRecord[] = [];
  for (const [tableName, { records }] of Object.entries(tables)) {
    for (const r of records) {
      allRecords.push(r);
    }
  }

  if (allRecords.length === 0) {
    return { exitCode: 0, output: 'No records without sources found.' };
  }

  // 2. Process each record
  let matched = 0;
  let skipped = 0;
  let totalCost = 0;

  for (let i = 0; i < allRecords.length; i++) {
    const record = allRecords[i];
    const terms = extractMatchTerms(record);
    if (terms.length === 0) {
      skipped++;
      continue;
    }

    console.log(`[${i + 1}/${allRecords.length}] ${record.record_table}: ${record.description.slice(0, 80)}`);

    const result = await processRecord(record, { dryRun, apply });
    totalCost += result.cost;
    if (result.matched) {
      matched++;
    }
  }

  const mode = apply ? 'apply' : 'dry-run';
  const summary = [
    `[backfill-sources] ${mode}`,
    `  Records processed: ${allRecords.length - skipped}`,
    `  Skipped (no match terms): ${skipped}`,
    `  Sources found: ${matched}`,
    `  Cost: $${totalCost.toFixed(4)}`,
  ].join('\n');

  return { exitCode: 0, output: summary };
}

export const commands = {
  default: backfillSourcesCommand,
};
