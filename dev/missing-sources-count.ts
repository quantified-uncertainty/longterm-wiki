/**
 * Report the current count of records missing a source URL, per table and total,
 * straight from the wiki-server endpoint the backfill-sources job consumes
 * (GET /api/sourcing/missing-sources). Read-only.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod pnpm tsx dev/missing-sources-count.ts
 */

import 'dotenv/config';
import { apiRequest } from '../crux/lib/wiki-server/client.ts';

interface TableResult {
  total: number;
  records: unknown[];
  error?: string;
}
interface Resp {
  tables: Record<string, TableResult>;
  totalMissing: number;
}

// Optional first arg: retryAfterDays window (QUA-1071). 0 = no filtering.
const retryAfterDays = Number(process.argv[2] ?? 0);
// limit=1: we only need the per-table `total` counts, not the record bodies.
const res = await apiRequest<Resp>(
  'GET',
  `/api/sourcing/missing-sources?limit=1&retryAfterDays=${retryAfterDays}`,
);
if (!res.ok) {
  console.error(`Request failed: ${res.message}`);
  process.exit(1);
}

const rows = Object.entries(res.data.tables)
  .map(([name, t]) => ({ name, total: t.total, error: t.error }))
  .sort((a, b) => b.total - a.total);

const pad = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  const note = r.error ? `  (error: ${r.error})` : '';
  console.log(`  ${r.name.padEnd(pad)}  ${String(r.total).padStart(6)}${note}`);
}
console.log(`  ${'─'.repeat(pad + 8)}`);
console.log(`  ${'TOTAL'.padEnd(pad)}  ${String(res.data.totalMissing).padStart(6)}`);
