/**
 * Statement Retract — retract one or all statements for an entity.
 *
 * Usage:
 *   pnpm crux statements retract <id> --reason="duplicate of #123"
 *   pnpm crux statements retract <entity-id> --all --reason="bulk cleanup"
 *   pnpm crux statements retract <entity-id> --all --property=revenue --reason="reingesting"
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  patchStatement,
  getStatementsByEntity,
  type StatementRow,
} from '../lib/wiki-server/statements.ts';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const target = positional[0];
  const isAll = args.all === true;
  const reason = (args.reason as string) ?? null;
  const propertyFilter = args.property as string | undefined;
  const confirm = args.confirm === true;
  const jsonOutput = args.json === true;

  if (!target) {
    console.error(`${c.red}Error: provide a statement ID or entity ID${c.reset}`);
    console.error(`  Usage:`);
    console.error(`    crux statements retract <statement-id> [--reason="..."]`);
    console.error(`    crux statements retract <entity-id> --all [--property=X] [--reason="..."] [--confirm]`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  if (isAll) {
    // Batch retract for entity
    await retractAll(target, reason, propertyFilter, confirm, jsonOutput, c);
  } else {
    // Single statement retract
    const id = parseInt(target, 10);
    if (isNaN(id)) {
      console.error(`${c.red}Error: '${target}' is not a valid statement ID. Use --all for entity-wide retract.${c.reset}`);
      process.exit(1);
    }
    await retractSingle(id, reason, jsonOutput, c);
  }
}

async function retractSingle(
  id: number,
  reason: string | null,
  jsonOutput: boolean,
  c: ReturnType<typeof getColors>,
) {
  const result = await patchStatement(id, {
    status: 'retracted',
    archiveReason: reason,
  });

  if (!result.ok) {
    console.error(`${c.red}Failed to retract statement ${id}: ${result.message}${c.reset}`);
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ retracted: [id], count: 1 }));
  } else {
    console.log(`${c.green}✓ Statement ${id} retracted${c.reset}${reason ? ` (${reason})` : ''}`);
  }
}

async function retractAll(
  entityId: string,
  reason: string | null,
  propertyFilter: string | undefined,
  confirmed: boolean,
  jsonOutput: boolean,
  c: ReturnType<typeof getColors>,
) {
  // Fetch all active statements
  const result = await getStatementsByEntity(entityId);
  if (!result.ok) {
    console.error(`${c.red}Could not fetch statements for ${entityId}: ${result.message}${c.reset}`);
    process.exit(1);
  }

  let statements: StatementRow[] = [
    ...result.data.structured,
    ...result.data.attributed,
  ].filter((s) => s.status === 'active');

  if (propertyFilter) {
    statements = statements.filter((s) => s.propertyId === propertyFilter);
  }

  if (statements.length === 0) {
    console.log(`${c.yellow}No active statements to retract for ${entityId}${propertyFilter ? ` (property: ${propertyFilter})` : ''}.${c.reset}`);
    return;
  }

  if (!confirmed) {
    console.error(`${c.red}This will retract ${statements.length} statements for ${entityId}.${c.reset}`);
    console.error(`Add --confirm to proceed.`);
    if (!jsonOutput) {
      console.error(`\nStatements to retract:`);
      for (const s of statements.slice(0, 10)) {
        console.error(`  #${s.id}: ${(s.statementText ?? '').slice(0, 60)}`);
      }
      if (statements.length > 10) {
        console.error(`  ... and ${statements.length - 10} more`);
      }
    }
    process.exit(1);
  }

  // Retract in sequence (PATCH is per-statement)
  const retracted: number[] = [];
  const failed: number[] = [];

  for (const stmt of statements) {
    const res = await patchStatement(stmt.id, {
      status: 'retracted',
      archiveReason: reason,
    });
    if (res.ok) {
      retracted.push(stmt.id);
    } else {
      failed.push(stmt.id);
      console.error(`${c.yellow}  Warning: failed to retract #${stmt.id}: ${res.message}${c.reset}`);
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ retracted, failed, count: retracted.length }));
  } else {
    console.log(`${c.green}✓ Retracted ${retracted.length}/${statements.length} statements for ${entityId}${c.reset}`);
    if (failed.length > 0) {
      console.log(`${c.yellow}  ${failed.length} failed: ${failed.join(', ')}${c.reset}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement retract failed:', err);
    process.exit(1);
  });
}
