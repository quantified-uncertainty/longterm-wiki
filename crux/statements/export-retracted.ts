/**
 * Export retracted statements to a JSON archive file, then optionally delete them from the DB.
 *
 * Usage:
 *   pnpm crux statements export-retracted                  # dry-run: export only, show what would be deleted
 *   pnpm crux statements export-retracted --delete          # export + delete from DB
 *   pnpm crux statements export-retracted --output=path.json  # custom output path
 */

import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  listStatements,
  cleanupStatements,
  type StatementRow,
} from '../lib/wiki-server/statements.ts';

const MAX_PAGE_SIZE = 500;

async function fetchAllRetracted(): Promise<StatementRow[]> {
  const all: StatementRow[] = [];
  let offset = 0;

  while (true) {
    const result = await listStatements({
      status: 'retracted',
      limit: MAX_PAGE_SIZE,
      offset,
    });

    if (!result.ok) {
      throw new Error(`Failed to fetch retracted statements at offset ${offset}: ${result.message}`);
    }

    all.push(...result.data.statements);

    if (result.data.statements.length < MAX_PAGE_SIZE || all.length >= result.data.total) {
      break;
    }
    offset += MAX_PAGE_SIZE;
  }

  return all;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const doDelete = args.delete === true;
  const outputPath = (args.output as string) ??
    resolve(process.cwd(), 'data', 'archive', `retracted-statements-${new Date().toISOString().slice(0, 10)}.json`);

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  // 1. Fetch all retracted statements
  console.log('Fetching all retracted statements...');
  const retracted = await fetchAllRetracted();
  console.log(`Found ${c.yellow}${retracted.length}${c.reset} retracted statements.`);

  if (retracted.length === 0) {
    console.log(`${c.green}No retracted statements to export.${c.reset}`);
    return;
  }

  // 2. Group by entity for the archive and cleanup
  const byEntity = new Map<string, StatementRow[]>();
  for (const stmt of retracted) {
    const eid = stmt.subjectEntityId;
    if (!byEntity.has(eid)) byEntity.set(eid, []);
    byEntity.get(eid)!.push(stmt);
  }

  console.log(`Across ${c.yellow}${byEntity.size}${c.reset} entities.`);

  // 3. Write archive
  const archive = {
    exportedAt: new Date().toISOString(),
    totalStatements: retracted.length,
    entityCount: byEntity.size,
    statements: retracted,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(archive, null, 2));
  console.log(`${c.green}✓ Archived to ${outputPath}${c.reset}`);

  // 4. Delete from DB (per entity)
  if (!doDelete) {
    console.log(`\n${c.yellow}Dry run — add --delete to purge from DB.${c.reset}`);
    for (const [entityId, stmts] of byEntity) {
      console.log(`  ${entityId}: ${stmts.length} retracted`);
    }
    return;
  }

  console.log('\nDeleting retracted statements from DB...');
  let totalDeleted = 0;
  let failures = 0;

  for (const [entityId, stmts] of byEntity) {
    const result = await cleanupStatements(entityId, false);
    if (result.ok) {
      const deleted = result.data.deleted ?? 0;
      totalDeleted += deleted;
      console.log(`  ${c.green}✓${c.reset} ${entityId}: deleted ${deleted}`);
    } else {
      failures++;
      console.error(`  ${c.red}✗${c.reset} ${entityId}: ${result.message}`);
    }
  }

  console.log(`\n${c.green}✓ Done.${c.reset} Deleted ${totalDeleted} statements from ${byEntity.size - failures} entities.`);
  if (failures > 0) {
    console.log(`${c.yellow}  ${failures} entities failed cleanup.${c.reset}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Export retracted failed:', err);
    process.exit(1);
  });
}
