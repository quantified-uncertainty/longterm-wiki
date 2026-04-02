/**
 * Data Sources CLI — manage structured data sources and snapshots.
 *
 * Usage:
 *   crux tb data-sources-list                          List all registered data sources
 *   crux tb data-sources-show <id>                     Show details + snapshot history
 *   crux tb data-sources-snapshot <id>                 Capture a new snapshot
 *   crux tb data-sources-snapshot --all                Capture snapshots for all sources
 *   crux tb data-sources-health                        Check mapping validity, staleness
 *
 * Part of Phase 4: Data Source Resources (Discussion #3567).
 */

import type { CommandResult } from '../lib/command-types.ts';

interface Options {
  all?: boolean;
  dryRun?: boolean;
  'dry-run'?: boolean;
  limit?: string;
  source?: string;
}

async function listCommand(_args: string[], _options: Options): Promise<CommandResult> {
  const { listDataSources } = await import('../lib/wiki-server/data-sources.ts');
  const result = await listDataSources();

  if (!result.ok) {
    return { exitCode: 1, output: `Failed to list data sources: ${result.error}` };
  }

  const sources = (result.data as { dataSources: Array<Record<string, unknown>> }).dataSources;

  if (sources.length === 0) {
    console.log('No data sources registered yet.');
    console.log('Run `pnpm crux tb import-grants sync` to register grant sources and capture snapshots.');
    return { exitCode: 0, output: '' };
  }

  console.log(`\n${'ID'.padEnd(25)} ${'Name'.padEnd(40)} ${'Format'.padEnd(10)} ${'Records'.padEnd(8)} ${'Last Snapshot'.padEnd(22)} Status`);
  console.log('-'.repeat(120));

  for (const s of sources) {
    const lastSnapshot = s.lastSnapshotAt
      ? new Date(s.lastSnapshotAt as string).toISOString().slice(0, 16).replace('T', ' ')
      : 'never';
    console.log(
      `${String(s.id).padEnd(25)} ${String(s.name).slice(0, 38).padEnd(40)} ${String(s.dataFormat).padEnd(10)} ${String(s.snapshotRecordCount ?? '-').padEnd(8)} ${lastSnapshot.padEnd(22)} ${s.sourceStatus}`
    );
  }

  console.log(`\nTotal: ${sources.length} data sources`);
  return { exitCode: 0, output: '' };
}

async function showCommand(args: string[], _options: Options): Promise<CommandResult> {
  const id = args[0];
  if (!id) {
    return { exitCode: 1, output: 'Usage: crux tb data-sources-show <id>' };
  }

  const { getDataSource, listSnapshots } = await import('../lib/wiki-server/data-sources.ts');

  const result = await getDataSource(id);
  if (!result.ok) {
    return { exitCode: 1, output: `Data source not found: ${id}` };
  }

  const ds = result.data as Record<string, unknown>;
  console.log(`\nData Source: ${ds.name}`);
  console.log(`  ID:              ${ds.id}`);
  console.log(`  Format:          ${ds.dataFormat}`);
  console.log(`  Access Method:   ${ds.accessMethod}`);
  console.log(`  Record Type:     ${ds.recordType}`);
  console.log(`  Fetch URL:       ${ds.fetchUrl ?? '(none)'}`);
  console.log(`  Publisher:       ${ds.publisherEntityId ?? '(none)'}`);
  console.log(`  Update Freq:     ${ds.updateFrequency ?? '(none)'}`);
  console.log(`  Status:          ${ds.sourceStatus}`);
  console.log(`  Last Snapshot:   ${ds.lastSnapshotAt ?? 'never'}`);
  console.log(`  Records:         ${ds.snapshotRecordCount ?? '-'}`);

  // Column mapping
  const columnMapping = ds.columnMapping as Record<string, string> | null | undefined;
  if (columnMapping && Object.keys(columnMapping).length > 0) {
    console.log(`\n  Column Mapping:`);
    for (const [source, internal] of Object.entries(columnMapping)) {
      console.log(`    ${source} → ${internal}`);
    }
  } else {
    console.log(`\n  Column Mapping:  (none)`);
  }

  // Verification config
  const verificationConfig = ds.verificationConfig as Record<string, unknown> | null | undefined;
  if (verificationConfig && Object.keys(verificationConfig).length > 0) {
    console.log(`\n  Verification Config:`);
    for (const [key, value] of Object.entries(verificationConfig)) {
      const formatted = Array.isArray(value) ? value.join(', ') : String(value);
      console.log(`    ${key}: ${formatted}`);
    }
  } else {
    console.log(`\n  Verification Config:  (none)`);
  }

  // Show snapshot history
  const snapResult = await listSnapshots(id, 10);
  if (snapResult.ok) {
    const data = snapResult.data as { snapshots: Array<Record<string, unknown>>; total: number };
    console.log(`\n  Snapshot History (${data.total} total):`);
    if (data.snapshots.length === 0) {
      console.log('    (no snapshots yet)');
    }
    for (const snap of data.snapshots) {
      const fetchedAt = new Date(snap.fetchedAt as string).toISOString().slice(0, 16).replace('T', ' ');
      const hash = String(snap.snapshotHash).slice(0, 12);
      const valid = snap.mappingValid ? '✓' : '✗';
      console.log(`    ${fetchedAt}  ${hash}...  ${snap.recordCount ?? '?'} records  ${valid} mapping`);
    }
  }

  return { exitCode: 0, output: '' };
}

async function snapshotCommand(args: string[], options: Options): Promise<CommandResult> {
  const { captureSourceSnapshot, captureAllSnapshots } = await import('../lib/grant-import/snapshot-capture.ts');
  const { MANIFESTS } = await import('../lib/grant-import/manifests/index.ts');
  const { ALL_SOURCES } = await import('../lib/grant-import/sources/index.ts');
  if (options.all) {
    // Ensure data is downloaded first
    for (const src of ALL_SOURCES) {
      console.log(`Downloading ${src.name}...`);
      try {
        await src.ensureData();
      } catch (e: unknown) {
        console.warn(`  Failed to download ${src.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await captureAllSnapshots(Object.keys(MANIFESTS));
    return { exitCode: 0, output: '' };
  }

  const id = args[0];
  if (!id) {
    return { exitCode: 1, output: 'Usage: crux tb data-sources-snapshot <id> or --all' };
  }

  if (!MANIFESTS[id]) {
    return { exitCode: 1, output: `Unknown data source: ${id}. Available: ${Object.keys(MANIFESTS).join(', ')}` };
  }

  // Ensure data is downloaded
  const src = ALL_SOURCES.find(s => s.id === id);
  if (src) {
    console.log(`Downloading ${src.name}...`);
    await src.ensureData();
  }

  await captureSourceSnapshot(id);
  return { exitCode: 0, output: '' };
}

async function healthCommand(_args: string[], _options: Options): Promise<CommandResult> {
  const { listDataSources } = await import('../lib/wiki-server/data-sources.ts');
  const { MANIFESTS } = await import('../lib/grant-import/manifests/index.ts');

  const result = await listDataSources();
  if (!result.ok) {
    return { exitCode: 1, output: `Failed to list data sources: ${result.error}` };
  }

  const sources = (result.data as { dataSources: Array<Record<string, unknown>> }).dataSources;
  const registered = new Set(sources.map(s => s.id as string));

  console.log('\nData Source Health Check\n');

  // Check which manifests are registered
  let issues = 0;
  for (const [id, manifest] of Object.entries(MANIFESTS)) {
    const isRegistered = registered.has(id);
    const source = sources.find(s => s.id === id);
    const hasSnapshot = source?.lastSnapshotAt != null;
    const hasFields = manifest.schema.fields.length > 0;

    // Check persisted column mapping and verification config
    const hasColumnMapping = source?.columnMapping != null && Object.keys(source.columnMapping as Record<string, unknown>).length > 0;
    const hasVerificationConfig = source?.verificationConfig != null && Object.keys(source.verificationConfig as Record<string, unknown>).length > 0;

    const status = [];
    if (!isRegistered) { status.push('NOT REGISTERED'); issues++; }
    if (!hasSnapshot) { status.push('NO SNAPSHOT'); issues++; }
    if (!hasFields) { status.push('NO SCHEMA'); issues++; }
    if (isRegistered && !hasColumnMapping) { status.push('NO COLUMN MAPPING'); issues++; }
    if (isRegistered && !hasVerificationConfig) { status.push('NO VERIFICATION CONFIG'); issues++; }

    const icon = status.length === 0 ? '✓' : '✗';
    console.log(`  ${icon} ${id.padEnd(25)} ${status.length > 0 ? status.join(', ') : 'OK'}`);
  }

  // Check for stale snapshots (older than 90 days)
  const now = Date.now();
  for (const s of sources) {
    if (s.lastSnapshotAt) {
      const age = now - new Date(s.lastSnapshotAt as string).getTime();
      const days = Math.floor(age / (1000 * 60 * 60 * 24));
      if (days > 90) {
        console.log(`  ⚠ ${String(s.id).padEnd(25)} STALE (${days} days since last snapshot)`);
        issues++;
      }
    }
  }

  console.log(`\n${issues === 0 ? 'All healthy' : `${issues} issue(s) found`}`);
  return { exitCode: issues > 0 ? 1 : 0, output: '' };
}

function defaultCommand(_args: string[], _options: Options): Promise<CommandResult> {
  console.log(getHelp());
  return Promise.resolve({ exitCode: 0, output: '' });
}

export const commands = {
  list: listCommand,
  show: showCommand,
  snapshot: snapshotCommand,
  health: healthCommand,
  default: defaultCommand,
};

export function getHelp(): string {
  return `
Data Sources — Manage structured data sources and snapshots

Commands:
  list                          List all registered data sources
  show <id>                     Show details + snapshot history
  snapshot <id>                 Capture a new snapshot for a data source
  snapshot --all                Capture snapshots for all sources
  health                       Check mapping validity, staleness

Examples:
  crux tb data-sources-list
  crux tb data-sources-show coefficient-giving
  crux tb data-sources-snapshot sff
  crux tb data-sources-snapshot --all
  crux tb data-sources-health
`;
}
