#!/usr/bin/env node
/**
 * Snapshot the prod wiki-server's `/api/sourcing/missing-sources` endpoint.
 *
 * Saves the per-table totals + grand total to a timestamped JSON in
 * dev/reports/ so before/after counts can be compared to measure what a
 * backfill run actually moved.
 *
 * The endpoint applies the same content filters the backfill uses
 * (SKIP_MEASURES for facts, nameIsUsable for entities, etc.), so this
 * matches the "892 records to process" figure the apply run prints —
 * unlike a raw `WHERE source IS NULL` count from psql.
 *
 * Usage:
 *   node dev/snapshot-missing-sources-endpoint.mjs
 *   node dev/snapshot-missing-sources-endpoint.mjs --label=before-rerun
 *
 * Reads PROD_LONGTERMWIKI_SERVER_URL + PROD_LONGTERMWIKI_SERVER_API_KEY
 * from .env at the repo root.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REPORTS_DIR = resolve(__dirname, 'reports');

function readEnv(name) {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  const line = env.split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not in .env`);
  return line.slice(name.length + 1).replace(/^["']|["']$/g, '');
}

const args = process.argv.slice(2);
const labelArg = args.find((a) => a.startsWith('--label='));
const label = labelArg ? labelArg.slice('--label='.length) : 'snapshot';

const baseUrl = readEnv('PROD_LONGTERMWIKI_SERVER_URL').replace(/\/$/, '');
const apiKey = readEnv('PROD_LONGTERMWIKI_SERVER_API_KEY');

// limit=1 — we only want the totals, not the records themselves.
const url = `${baseUrl}/api/sourcing/missing-sources?limit=1`;

const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  },
});
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const data = await res.json();

const perTable = Object.fromEntries(
  Object.entries(data.tables ?? {}).map(([table, payload]) => [
    table,
    payload.total,
  ]),
);

const snapshot = {
  capturedAt: new Date().toISOString(),
  label,
  totalMissing: data.totalMissing,
  perTable,
};

mkdirSync(REPORTS_DIR, { recursive: true });
const stamp = snapshot.capturedAt.replace(/[:.]/g, '-');
const outPath = resolve(REPORTS_DIR, `missing-sources-${label}-${stamp}.json`);
writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');

console.log(`Snapshot label: ${label}`);
console.log(`Total missing:  ${snapshot.totalMissing}`);
console.log('Per table:');
for (const [t, n] of Object.entries(perTable).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(22)} ${n}`);
}
console.log(`Saved to: ${outPath}`);
