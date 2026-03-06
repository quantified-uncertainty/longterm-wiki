/**
 * Statement List — display statements for an entity in a formatted table.
 *
 * Usage:
 *   pnpm crux statements list <entity-id>
 *   pnpm crux statements list <entity-id> --property=revenue
 *   pnpm crux statements list <entity-id> --active-only
 *   pnpm crux statements list <entity-id> --json
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { getStatementsByEntity, type StatementRow } from '../lib/wiki-server/statements.ts';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function truncate(s: string | null | undefined, len: number): string {
  if (!s) return '';
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

function formatValue(stmt: StatementRow): string {
  if (stmt.valueNumeric != null) {
    const num = Number(stmt.valueNumeric);
    if (Math.abs(num) >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
    if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
    if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
    return String(num);
  }
  if (stmt.valueText) return truncate(stmt.valueText, 30);
  if (stmt.valueDate) return stmt.valueDate;
  if (stmt.valueEntityId) return stmt.valueEntityId;
  return '';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const jsonOutput = args.json === true;
  const activeOnly = args['active-only'] === true;
  const propertyFilter = args.property as string | undefined;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const entityId = positional[0];

  if (!entityId) {
    console.error(`${c.red}Error: provide an entity ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements list <entity-id> [--property=X] [--active-only] [--json]`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  const result = await getStatementsByEntity(entityId);
  if (!result.ok) {
    console.error(`${c.red}Could not fetch statements for ${entityId}: ${result.message}${c.reset}`);
    process.exit(1);
  }

  let statements: StatementRow[] = [
    ...result.data.structured,
    ...result.data.attributed,
  ];

  // Apply filters
  if (activeOnly) {
    statements = statements.filter((s) => s.status === 'active');
  }
  if (propertyFilter) {
    statements = statements.filter((s) => s.propertyId === propertyFilter);
  }

  // Sort by property then date
  statements.sort((a, b) => {
    const pA = a.propertyId ?? 'zzz';
    const pB = b.propertyId ?? 'zzz';
    if (pA !== pB) return pA.localeCompare(pB);
    const dA = a.validStart ?? '';
    const dB = b.validStart ?? '';
    return dA.localeCompare(dB);
  });

  if (jsonOutput) {
    console.log(JSON.stringify({ entityId, total: statements.length, statements }, null, 2));
    return;
  }

  if (statements.length === 0) {
    console.log(`${c.yellow}No statements found for ${entityId}.${c.reset}`);
    return;
  }

  // Print table
  console.log(`\n${c.bold}${c.blue}Statements for ${entityId}${c.reset} (${statements.length} total)\n`);

  const header = [
    'ID'.padEnd(7),
    'Property'.padEnd(28),
    'Value'.padEnd(22),
    'Date'.padEnd(12),
    'Status'.padEnd(10),
    'Text',
  ].join(' ');

  console.log(`${c.dim}${header}${c.reset}`);
  console.log(`${c.dim}${'─'.repeat(120)}${c.reset}`);

  for (const stmt of statements) {
    const statusColor = stmt.status === 'active' ? c.green : stmt.status === 'retracted' ? c.red : c.yellow;
    const row = [
      String(stmt.id).padEnd(7),
      (stmt.propertyId ?? c.dim + '(none)' + c.reset).padEnd(28),
      formatValue(stmt).padEnd(22),
      (stmt.validStart ?? '').padEnd(12),
      `${statusColor}${(stmt.status ?? 'active').padEnd(10)}${c.reset}`,
      truncate(stmt.statementText, 40),
    ].join(' ');
    console.log(row);
  }

  // Summary
  const withProp = statements.filter((s) => s.propertyId).length;
  const active = statements.filter((s) => s.status === 'active').length;
  console.log(`\n${c.dim}${active} active, ${withProp}/${statements.length} with property${c.reset}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement list failed:', err);
    process.exit(1);
  });
}
