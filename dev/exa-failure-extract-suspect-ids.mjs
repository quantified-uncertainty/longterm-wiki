#!/usr/bin/env node
/**
 * Extract suspect record IDs from the captured backfill-sources scrollback.
 *
 * Input:  dev/exa-failure-scrollback.txt — raw tmux capture of the apply run
 * Output: dev/exa-failure-suspect-ids.json
 *
 * "Suspect" = items processed at index >= FIRST_FAILURE_INDEX (the first item
 * where Exa returned 402 NO_MORE_CREDITS). For these items, Exa contributed no
 * candidates, so any source_url that did get written came from the fallback
 * providers only — lower quality than a normal run.
 *
 * The output JSON groups by table so the SQL builder can emit one UPDATE per
 * table:
 *   {
 *     "firstFailureIndex": 556,
 *     "lastIndex": 602,
 *     "tables": {
 *       "page_citations": [2738, 2739, ...]
 *     }
 *   }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT = resolve(__dirname, 'exa-failure-scrollback.txt');
const OUTPUT = resolve(__dirname, 'exa-failure-suspect-ids.json');

const FIRST_FAILURE_INDEX = 556; // first [N/892] where Exa returned 402

const text = readFileSync(INPUT, 'utf8');
const lines = text.split('\n');

// Match lines like: "[556/892] page_citations/2738: <claim text>"
const ITEM_RE = /^\[(\d+)\/\d+\]\s+([a-z_]+)\/(\d+)/;

const tables = {};
let firstSeen = Infinity;
let lastSeen = -Infinity;

for (const line of lines) {
  const m = line.match(ITEM_RE);
  if (!m) continue;
  const index = Number(m[1]);
  const table = m[2];
  const id = Number(m[3]);
  if (index < FIRST_FAILURE_INDEX) continue;
  if (index < firstSeen) firstSeen = index;
  if (index > lastSeen) lastSeen = index;
  if (!tables[table]) tables[table] = new Set();
  tables[table].add(id);
}

const out = {
  firstFailureIndex: FIRST_FAILURE_INDEX,
  firstSeenInScrollback: firstSeen === Infinity ? null : firstSeen,
  lastIndex: lastSeen === -Infinity ? null : lastSeen,
  tables: Object.fromEntries(
    Object.entries(tables).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]),
  ),
};

writeFileSync(OUTPUT, JSON.stringify(out, null, 2) + '\n');

const totalIds = Object.values(out.tables).reduce((s, a) => s + a.length, 0);
console.log(`First failure: [${FIRST_FAILURE_INDEX}/892]`);
console.log(`Scrollback covers items [${out.firstSeenInScrollback}..${out.lastIndex}]`);
console.log(`Tables affected: ${Object.keys(out.tables).join(', ') || '(none)'}`);
console.log(`Suspect ID count: ${totalIds}`);
console.log(`Wrote ${OUTPUT}`);
