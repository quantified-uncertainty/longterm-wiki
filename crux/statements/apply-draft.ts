/**
 * Apply Draft — execute approved actions from a statement ontology draft.
 *
 * Reads the markdown draft file, parses checked action items, and executes:
 * - RETRACT: retract a statement by ID
 * - CLASSIFY: assign a property to a statement
 * - NEW_PROPERTY: create a new property definition
 * - CREATE: create a new statement
 *
 * Usage:
 *   pnpm crux statements apply-draft <entity-id>
 *   pnpm crux statements apply-draft <entity-id> --input=./custom-draft.md
 *   pnpm crux statements apply-draft <entity-id> --dry-run
 */

import { fileURLToPath } from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  patchStatement,
  createStatementBatch,
  upsertProperties,
  type CreateStatementInput,
  type UpsertPropertyInput,
} from '../lib/wiki-server/statements.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RetractAction {
  type: 'retract';
  statementId: number;
  reason: string;
}

interface ClassifyAction {
  type: 'classify';
  statementId: number;
  propertyId: string;
}

interface NewPropertyAction {
  type: 'new_property';
  id: string;
  label: string;
  category: string;
}

interface CreateAction {
  type: 'create';
  propertyId: string;
  value?: number;
  date?: string;
  text: string;
}

type DraftAction = RetractAction | ClassifyAction | NewPropertyAction | CreateAction;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseDraft(content: string, entityId: string): DraftAction[] {
  const actions: DraftAction[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Only process checked items: - [x] ACTION ...
    if (!trimmed.startsWith('- [x]') && !trimmed.startsWith('- [X]')) continue;

    const actionText = trimmed.slice(5).trim();

    // RETRACT #<id> reason="..."
    const retractMatch = actionText.match(/^RETRACT\s+#(\d+)\s*(?:reason="([^"]*)")?/i);
    if (retractMatch) {
      actions.push({
        type: 'retract',
        statementId: parseInt(retractMatch[1], 10),
        reason: retractMatch[2] ?? 'retracted via draft',
      });
      continue;
    }

    // CLASSIFY #<id> property="..."
    const classifyMatch = actionText.match(/^CLASSIFY\s+#(\d+)\s+property="([^"]+)"/i);
    if (classifyMatch) {
      const propId = classifyMatch[2];
      if (propId.includes('FILL IN') || propId.includes('<!--')) continue; // Skip unfilled placeholders
      actions.push({
        type: 'classify',
        statementId: parseInt(classifyMatch[1], 10),
        propertyId: propId,
      });
      continue;
    }

    // NEW_PROPERTY id="..." label="..." category="..."
    const propMatch = actionText.match(/^NEW_PROPERTY\s+id="([^"]+)"\s+label="([^"]+)"\s+category="([^"]+)"/i);
    if (propMatch) {
      actions.push({
        type: 'new_property',
        id: propMatch[1],
        label: propMatch[2],
        category: propMatch[3],
      });
      continue;
    }

    // CREATE property="..." value=N date="..." text="..."
    const createMatch = actionText.match(/^CREATE\s+/i);
    if (createMatch) {
      const propM = actionText.match(/property="([^"]+)"/);
      const valueM = actionText.match(/value=([0-9.eE+-]+)/);
      const dateM = actionText.match(/date="([^"]+)"/);
      const textM = actionText.match(/text="([^"]+)"/);

      if (propM && textM) {
        actions.push({
          type: 'create',
          propertyId: propM[1],
          value: valueM ? parseFloat(valueM[1]) : undefined,
          date: dateM ? dateM[1] : undefined,
          text: textM[1],
        });
      }
      continue;
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executeActions(
  actions: DraftAction[],
  entityId: string,
  dryRun: boolean,
  c: ReturnType<typeof getColors>,
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;

  // Phase 1: Create new properties
  const newProperties = actions.filter((a): a is NewPropertyAction => a.type === 'new_property');
  if (newProperties.length > 0) {
    console.log(`\n${c.bold}Creating ${newProperties.length} new properties...${c.reset}`);
    if (!dryRun) {
      const propsInput: UpsertPropertyInput[] = newProperties.map((p) => ({
        id: p.id,
        label: p.label,
        category: p.category,
      }));
      const result = await upsertProperties(propsInput);
      if (result.ok) {
        succeeded += newProperties.length;
        console.log(`  ${c.green}✓ ${newProperties.length} properties created${c.reset}`);
      } else {
        failed += newProperties.length;
        console.error(`  ${c.red}✗ Failed: ${result.message}${c.reset}`);
      }
    } else {
      for (const p of newProperties) {
        console.log(`  [dry-run] Would create property: ${p.id} (${p.category})`);
      }
    }
  }

  // Phase 2: Retract statements
  const retractions = actions.filter((a): a is RetractAction => a.type === 'retract');
  if (retractions.length > 0) {
    console.log(`\n${c.bold}Retracting ${retractions.length} statements...${c.reset}`);
    for (const r of retractions) {
      if (!dryRun) {
        const result = await patchStatement(r.statementId, {
          status: 'retracted',
          archiveReason: r.reason,
        });
        if (result.ok) {
          succeeded++;
          console.log(`  ${c.green}✓ #${r.statementId} retracted${c.reset}`);
        } else {
          failed++;
          console.error(`  ${c.red}✗ #${r.statementId}: ${result.message}${c.reset}`);
        }
      } else {
        console.log(`  [dry-run] Would retract #${r.statementId} (${r.reason})`);
      }
    }
  }

  // Phase 3: Classify statements (assign property)
  const classifications = actions.filter((a): a is ClassifyAction => a.type === 'classify');
  if (classifications.length > 0) {
    console.log(`\n${c.bold}Classifying ${classifications.length} statements...${c.reset}`);
    for (const cl of classifications) {
      if (!dryRun) {
        const result = await patchStatement(cl.statementId, {
          propertyId: cl.propertyId,
        });
        if (result.ok) {
          succeeded++;
          console.log(`  ${c.green}✓ #${cl.statementId} → ${cl.propertyId}${c.reset}`);
        } else {
          failed++;
          console.error(`  ${c.red}✗ #${cl.statementId}: ${result.message}${c.reset}`);
        }
      } else {
        console.log(`  [dry-run] Would classify #${cl.statementId} → ${cl.propertyId}`);
      }
    }
  }

  // Phase 4: Create new statements (batch)
  const creates = actions.filter((a): a is CreateAction => a.type === 'create');
  if (creates.length > 0) {
    console.log(`\n${c.bold}Creating ${creates.length} new statements...${c.reset}`);
    if (!dryRun) {
      const inputs: CreateStatementInput[] = creates.map((cr) => ({
        variety: 'structured' as const,
        statementText: cr.text,
        subjectEntityId: entityId,
        propertyId: cr.propertyId,
        valueNumeric: cr.value ?? null,
        validStart: cr.date ? normalizeDate(cr.date) : null,
      }));

      const result = await createStatementBatch(inputs);
      if (result.ok) {
        succeeded += creates.length;
        console.log(`  ${c.green}✓ ${creates.length} statements created${c.reset}`);
      } else {
        failed += creates.length;
        console.error(`  ${c.red}✗ Batch create failed: ${result.message}${c.reset}`);
      }
    } else {
      for (const cr of creates) {
        console.log(`  [dry-run] Would create: ${cr.propertyId} = ${cr.value ?? 'N/A'} (${cr.date ?? 'no date'})`);
      }
    }
  }

  return { succeeded, failed };
}

function normalizeDate(d: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if (/^\d{4}-\d{2}$/.test(d)) return `${d}-01`;
  if (/^\d{4}$/.test(d)) return `${d}-01-01`;
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const entityId = positional[0];
  const dryRun = args['dry-run'] === true;
  const inputPath = args.input as string | undefined;

  if (!entityId) {
    console.error(`${c.red}Error: provide an entity ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements apply-draft <entity-id> [--dry-run] [--input=path]`);
    process.exit(1);
  }

  // Find draft file
  const defaultPath = path.resolve(`.claude/ontology-drafts/${entityId}.md`);
  const draftPath = inputPath ?? defaultPath;

  if (!fs.existsSync(draftPath)) {
    console.error(`${c.red}Draft not found: ${draftPath}${c.reset}`);
    console.error(`  Generate one first: pnpm crux statements draft ${entityId}`);
    process.exit(1);
  }

  const content = fs.readFileSync(draftPath, 'utf-8');

  // Parse actions
  const actions = parseDraft(content, entityId);

  if (actions.length === 0) {
    console.log(`${c.yellow}No checked actions found in ${draftPath}.${c.reset}`);
    console.log(`  Check boxes with [x] to approve actions, then re-run.`);
    process.exit(0);
  }

  // Summary
  const counts = {
    retract: actions.filter((a) => a.type === 'retract').length,
    classify: actions.filter((a) => a.type === 'classify').length,
    new_property: actions.filter((a) => a.type === 'new_property').length,
    create: actions.filter((a) => a.type === 'create').length,
  };

  console.log(`\n${c.bold}${c.blue}Apply Draft: ${entityId}${c.reset}${dryRun ? ' [DRY RUN]' : ''}\n`);
  console.log(`  Actions found: ${actions.length}`);
  if (counts.retract) console.log(`    Retract:      ${counts.retract}`);
  if (counts.classify) console.log(`    Classify:     ${counts.classify}`);
  if (counts.new_property) console.log(`    New property: ${counts.new_property}`);
  if (counts.create) console.log(`    Create:       ${counts.create}`);

  if (!dryRun) {
    const serverAvailable = await isServerAvailable();
    if (!serverAvailable) {
      console.error(`\n${c.red}Wiki server not available. Use --dry-run to preview.${c.reset}`);
      process.exit(1);
    }
  }

  // Execute
  const result = await executeActions(actions, entityId, dryRun, c);

  // Summary
  console.log(`\n${c.bold}Result:${c.reset}`);
  console.log(`  Succeeded: ${c.green}${result.succeeded}${c.reset}`);
  if (result.failed > 0) {
    console.log(`  Failed:    ${c.red}${result.failed}${c.reset}`);
  }
  if (dryRun) {
    console.log(`\n  ${c.dim}Remove --dry-run to execute for real.${c.reset}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Apply draft failed:', err);
    process.exit(1);
  });
}
