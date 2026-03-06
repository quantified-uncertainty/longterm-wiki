/**
 * Statement Update — update fields on an existing statement via PATCH.
 *
 * Usage:
 *   pnpm crux statements update <id> --property=revenue
 *   pnpm crux statements update <id> --status=retracted --reason="duplicate of #123"
 *   pnpm crux statements update <id> --text="Updated statement text"
 *   pnpm crux statements update <id> --date=2026-03
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { patchStatement, type PatchStatementInput } from '../lib/wiki-server/statements.ts';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const idStr = positional[0];
  const jsonOutput = args.json === true;

  if (!idStr) {
    console.error(`${c.red}Error: provide a statement ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements update <id> [--property=X] [--status=Y] [--text=Z]`);
    console.error(`  Options:`);
    console.error(`    --property=ID      Change property assignment`);
    console.error(`    --status=STATUS    active | superseded | retracted`);
    console.error(`    --text=TEXT        Update statement text`);
    console.error(`    --date=DATE        Update validStart`);
    console.error(`    --variety=TYPE     structured | attributed`);
    console.error(`    --note=TEXT        Add/update note`);
    console.error(`    --reason=TEXT      Archive reason (when retracting)`);
    console.error(`    --json             JSON output`);
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    console.error(`${c.red}Error: statement ID must be a number${c.reset}`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  // Build patch object from provided flags
  const patch: PatchStatementInput = {};
  let hasChanges = false;

  if (args.property !== undefined) {
    patch.propertyId = args.property as string | null;
    hasChanges = true;
  }
  if (args.status !== undefined) {
    const status = args.status as string;
    if (status !== 'active' && status !== 'superseded' && status !== 'retracted') {
      console.error(`${c.red}Error: --status must be active, superseded, or retracted${c.reset}`);
      process.exit(1);
    }
    patch.status = status;
    hasChanges = true;
  }
  if (args.text !== undefined) {
    patch.statementText = args.text as string;
    hasChanges = true;
  }
  if (args.variety !== undefined) {
    const variety = args.variety as string;
    if (variety !== 'structured' && variety !== 'attributed') {
      console.error(`${c.red}Error: --variety must be structured or attributed${c.reset}`);
      process.exit(1);
    }
    patch.variety = variety;
    hasChanges = true;
  }
  if (args.date !== undefined) {
    patch.validStart = args.date as string;
    hasChanges = true;
  }
  if (args.note !== undefined) {
    patch.note = args.note as string;
    hasChanges = true;
  }
  if (args.reason !== undefined) {
    patch.archiveReason = args.reason as string;
    hasChanges = true;
  }

  if (!hasChanges) {
    console.error(`${c.red}Error: provide at least one field to update${c.reset}`);
    console.error(`  Example: pnpm crux statements update ${id} --property=revenue`);
    process.exit(1);
  }

  const result = await patchStatement(id, patch);

  if (!result.ok) {
    console.error(`${c.red}Failed to update statement ${id}: ${result.message}${c.reset}`);
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result.data, null, 2));
  } else {
    console.log(`${c.green}✓ Statement ${id} updated${c.reset}`);
    const changes = Object.entries(patch)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');
    console.log(changes);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement update failed:', err);
    process.exit(1);
  });
}
