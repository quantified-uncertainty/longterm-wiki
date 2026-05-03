#!/usr/bin/env node
/**
 * Snapshot of source-URL coverage and verdict distribution across the
 * 10 backfill-eligible tables. Run before/after a backfill+verify run
 * to measure what moved.
 *
 * Usage:
 *   node dev/snapshot-source-status.mjs                           # print to stdout
 *   node dev/snapshot-source-status.mjs > dev/reports/before.json # save snapshot
 *   node dev/snapshot-source-status.mjs --diff dev/reports/before.json  # diff vs saved
 *
 * Reads DATABASE_URL from the running wiki-server (mirrors verify-backfill-db.mjs).
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
const postgres = (await import('../apps/wiki-server/node_modules/postgres/cjs/src/index.js')).default;

const args = process.argv.slice(2);
const diffMode = args[0] === '--diff';
const baselinePath = diffMode ? args[1] : null;

// Per-table source-URL column. Mirrors apps/wiki-server/src/routes/sourcing/missing-sources/queries.ts.
const TABLES = [
  { name: 'facts',               sourceCol: 'source' },
  { name: 'personnel',           sourceCol: 'source' },
  { name: 'investments',         sourceCol: 'source' },
  { name: 'policy_stakeholders', sourceCol: 'source' },
  { name: 'equity_positions',    sourceCol: 'source' },
  { name: 'divisions',           sourceCol: 'source' },
  { name: 'funding_rounds',      sourceCol: 'source' },
  { name: 'funding_programs',    sourceCol: 'source' },
  { name: 'publications',        sourceCol: 'url'    },
  { name: 'page_citations',      sourceCol: 'url'    },
];

function loadDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const pid = execSync(
    "ps -eo pid,args | grep -E 'wiki-server|tsx.*src/index' | grep -v grep | head -1 | awk '{print $1}'",
    { encoding: 'utf8' },
  ).trim();
  if (!pid) throw new Error('Could not find running wiki-server PID; set DATABASE_URL manually.');
  const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  const line = env.find(l => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error(`DATABASE_URL not found in PID ${pid} env.`);
  return line.slice('DATABASE_URL='.length);
}

const sql = postgres(loadDbUrl(), { max: 4, idle_timeout: 5 });

async function snapshotTable({ name, sourceCol }) {
  const [{ total }] = await sql.unsafe(`SELECT count(*)::int AS total FROM ${name}`);
  const [{ withSource }] = await sql.unsafe(
    `SELECT count(*)::int AS "withSource" FROM ${name} WHERE ${sourceCol} IS NOT NULL AND ${sourceCol} <> ''`,
  );

  // Verdict distribution joined via source_check_verdicts.record_type / .record_id.
  // record_id is text; numeric-PK tables (facts, page_citations) need a cast.
  const idCast = (name === 'facts' || name === 'page_citations') ? '::text' : '';
  const verdictRows = await sql.unsafe(`
    SELECT v.verdict, count(*)::int AS n
    FROM source_check_verdicts v
    JOIN ${name} t ON v.record_id = t.id${idCast}
    WHERE v.record_type = $1
    GROUP BY v.verdict
    ORDER BY n DESC
  `, [name]);

  const verdicts = Object.fromEntries(verdictRows.map(r => [r.verdict, r.n]));
  const totalVerdicts = verdictRows.reduce((s, r) => s + r.n, 0);

  return {
    table: name,
    total,
    withSource,
    missingSource: total - withSource,
    pctSourced: total > 0 ? +((withSource / total) * 100).toFixed(1) : 0,
    totalVerdicts,
    pctVerdicted: total > 0 ? +((totalVerdicts / total) * 100).toFixed(1) : 0,
    verdicts,
  };
}

const snapshots = [];
for (const t of TABLES) snapshots.push(await snapshotTable(t));
await sql.end();

const out = {
  generated_at: new Date().toISOString(),
  database_url_redacted: loadDbUrl().replace(/:[^:@]*@/, ':***@'),
  tables: snapshots,
};

if (!diffMode) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// Diff mode
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const baselineByTable = new Map(baseline.tables.map(t => [t.table, t]));

console.log(`Diff: ${baselinePath} → now`);
console.log(`Baseline: ${baseline.generated_at}`);
console.log(`Now:      ${out.generated_at}`);
console.log();
console.log('table'.padEnd(22), 'sourced (Δ)'.padEnd(20), 'verdicts (Δ)');
for (const cur of snapshots) {
  const base = baselineByTable.get(cur.table);
  if (!base) continue;
  const dSource = cur.withSource - base.withSource;
  const dVerdicts = cur.totalVerdicts - base.totalVerdicts;
  const sourceCell = `${cur.withSource}/${cur.total} (${dSource >= 0 ? '+' : ''}${dSource})`;
  const verdictCell = `${cur.totalVerdicts}/${cur.total} (${dVerdicts >= 0 ? '+' : ''}${dVerdicts})`;
  console.log(cur.table.padEnd(22), sourceCell.padEnd(20), verdictCell);
}

console.log();
console.log('Verdict shifts:');
for (const cur of snapshots) {
  const base = baselineByTable.get(cur.table);
  if (!base) continue;
  const allVerdicts = new Set([...Object.keys(base.verdicts), ...Object.keys(cur.verdicts)]);
  const shifts = [];
  for (const v of allVerdicts) {
    const b = base.verdicts[v] ?? 0;
    const c = cur.verdicts[v] ?? 0;
    if (c !== b) shifts.push(`${v}: ${b}→${c} (${c - b >= 0 ? '+' : ''}${c - b})`);
  }
  if (shifts.length > 0) {
    console.log(`  ${cur.table}: ${shifts.join(', ')}`);
  }
}
