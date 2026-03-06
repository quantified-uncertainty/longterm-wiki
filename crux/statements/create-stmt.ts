/**
 * Statement Create — create a single statement for an entity via CLI.
 *
 * Auto-syncs the entity to wiki-server if needed, validates property exists,
 * and auto-generates statementText from property+value if not provided.
 *
 * Usage:
 *   pnpm crux statements create <entity-id> --property=revenue --value=19000000000 --date=2026-03
 *   pnpm crux statements create <entity-id> --property=founder --value-entity=dario-amodei
 *   pnpm crux statements create <entity-id> --text="Anthropic committed to RSP framework" --variety=attributed
 *   pnpm crux statements create <entity-id> --property=headcount --value=4074 --date=2026-01 --unit=employees
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import {
  createStatement,
  getProperties,
  type CreateStatementInput,
} from '../lib/wiki-server/statements.ts';
import { getEntity } from '../lib/wiki-server/entities.ts';
import { slugToDisplayName } from '../lib/claim-text-utils.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeDate(d: string | null | undefined): string | null {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if (/^\d{4}-\d{2}$/.test(d)) return `${d}-01`;
  if (/^\d{4}$/.test(d)) return `${d}-01-01`;
  const parsed = new Date(d);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

function generateStatementText(
  entityId: string,
  propertyId: string,
  value: string | number | null,
  unit: string | null,
  date: string | null,
): string {
  const entity = slugToDisplayName(entityId);
  const prop = slugToDisplayName(propertyId);
  let text = `${entity}'s ${prop}`;

  if (value != null) {
    const num = typeof value === 'number' ? value : parseFloat(value);
    if (!isNaN(num)) {
      let formatted: string;
      if (Math.abs(num) >= 1e9) formatted = `$${(num / 1e9).toFixed(1)}B`;
      else if (Math.abs(num) >= 1e6) formatted = `$${(num / 1e6).toFixed(1)}M`;
      else formatted = String(num);
      text += ` was ${formatted}`;
      if (unit) text += ` ${unit}`;
    } else {
      text += ` was ${value}`;
    }
  }

  if (date) text += ` (${date})`;
  return text + '.';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const entityId = positional[0];

  if (!entityId) {
    console.error(`${c.red}Error: provide an entity ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements create <entity-id> --property=X --value=Y [--date=Z]`);
    console.error(`  Options:`);
    console.error(`    --property=ID       Property identifier (e.g., revenue, headcount)`);
    console.error(`    --value=N           Numeric value`);
    console.error(`    --value-text=TEXT   Text value`);
    console.error(`    --value-entity=ID  Entity value`);
    console.error(`    --value-date=DATE  Date value`);
    console.error(`    --date=DATE         When this was true (validStart)`);
    console.error(`    --unit=UNIT         Value unit (e.g., USD, employees)`);
    console.error(`    --text=TEXT         Custom statement text (auto-generated if omitted)`);
    console.error(`    --variety=TYPE      structured (default) or attributed`);
    console.error(`    --citation-url=URL  Source URL for citation`);
    console.error(`    --note=TEXT         Optional note`);
    console.error(`    --json              JSON output`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  const property = args.property as string | undefined;
  const variety = (args.variety as string) ?? 'structured';
  const valueArg = args.value as string | undefined;
  const valueText = args['value-text'] as string | undefined;
  const valueEntity = args['value-entity'] as string | undefined;
  const valueDate = args['value-date'] as string | undefined;
  const date = args.date as string | undefined;
  const unit = args.unit as string | undefined;
  const text = args.text as string | undefined;
  const citationUrl = args['citation-url'] as string | undefined;
  const note = args.note as string | undefined;
  const jsonOutput = args.json === true;

  if (variety !== 'structured' && variety !== 'attributed') {
    console.error(`${c.red}Error: --variety must be 'structured' or 'attributed'${c.reset}`);
    process.exit(1);
  }

  // Validate entity exists on wiki-server
  const entityResult = await getEntity(entityId);
  if (!entityResult.ok) {
    console.error(`${c.red}Entity '${entityId}' not found on wiki-server. Sync it first.${c.reset}`);
    console.error(`  Hint: pnpm crux ids allocate ${entityId}`);
    process.exit(1);
  }

  // Validate property exists if provided
  if (property) {
    const propsResult = await getProperties();
    if (propsResult.ok) {
      const allProps = propsResult.data.properties;
      const found = allProps.find((p: { id: string }) => p.id === property);
      if (!found) {
        console.error(`${c.red}Property '${property}' not found.${c.reset}`);
        console.error(`  Available properties with similar names:`);
        const similar = allProps
          .filter((p: { id: string }) => p.id.includes(property) || property.includes(p.id))
          .slice(0, 5);
        for (const p of similar) {
          console.error(`    ${p.id}`);
        }
        if (similar.length === 0) {
          console.error(`  Run 'crux statements properties' to see all available properties.`);
        }
        process.exit(1);
      }
    }
  }

  // Build value
  const valueNumeric = valueArg ? parseFloat(valueArg) : null;

  // Generate statement text if not provided
  const statementText = text ?? generateStatementText(
    entityId,
    property ?? 'observation',
    valueNumeric ?? valueText ?? null,
    unit ?? null,
    date ?? null,
  );

  const input: CreateStatementInput = {
    variety,
    statementText,
    subjectEntityId: entityId,
    propertyId: property ?? null,
    valueNumeric: (valueNumeric != null && !isNaN(valueNumeric)) ? valueNumeric : null,
    valueUnit: unit ?? null,
    valueText: valueText ?? null,
    valueEntityId: valueEntity ?? null,
    valueDate: normalizeDate(valueDate) ?? null,
    validStart: normalizeDate(date) ?? null,
    note: note ?? null,
    citations: citationUrl ? [{ url: citationUrl, isPrimary: true }] : undefined,
  };

  const result = await createStatement(input);

  if (!result.ok) {
    console.error(`${c.red}Failed to create statement: ${result.message}${c.reset}`);
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result.data, null, 2));
  } else {
    console.log(`${c.green}✓ Statement created${c.reset} (id: ${result.data.id})`);
    console.log(`  Entity:   ${entityId}`);
    console.log(`  Property: ${property ?? '(none)'}`);
    console.log(`  Text:     ${truncate(statementText, 80)}`);
    if (valueNumeric != null && !isNaN(valueNumeric)) console.log(`  Value:    ${valueNumeric}${unit ? ` ${unit}` : ''}`);
    if (date) console.log(`  Date:     ${date}`);
  }
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement create failed:', err);
    process.exit(1);
  });
}
