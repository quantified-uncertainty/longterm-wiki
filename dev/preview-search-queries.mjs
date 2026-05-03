#!/usr/bin/env node
/**
 * Hit the local wiki-server for a sample of missing-source records, then show
 * (old query) vs (new query) side by side using the actual buildSearchQuery.
 */
import { buildSearchQuery } from '../crux/lib/backfill-sources/build-search-query.ts';

const SERVER = process.env.LONGTERMWIKI_SERVER_URL || 'http://localhost:3100';
const LIMIT = 4;

const tables = ['personnel', 'facts', 'investments', 'equity_positions', 'page_citations', 'divisions'];

function oldQuery(record) {
  const entityName = (record.entity_name ?? '').trim();
  return `${entityName} ${record.description}`.trim().slice(0, 400);
}

for (const table of tables) {
  const url = `${SERVER}/api/sourcing/missing-sources?limit=${LIMIT}&table=${table}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`[${table}] ${resp.status} ${resp.statusText}`);
    continue;
  }
  const json = await resp.json();
  const records = json.tables?.[table]?.records ?? [];
  if (records.length === 0) {
    console.log(`\n=== ${table} (0 records) ===`);
    continue;
  }
  console.log(`\n=== ${table} ===`);
  for (const r of records) {
    const before = oldQuery(r);
    const after = buildSearchQuery(r);
    console.log(`  BEFORE: ${before}`);
    console.log(`  AFTER:  ${after}`);
    console.log();
  }
}
