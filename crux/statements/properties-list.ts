/**
 * Statement Properties List — display all property definitions with usage counts.
 *
 * Usage:
 *   pnpm crux statements properties
 *   pnpm crux statements properties --category=financial
 *   pnpm crux statements properties --unused
 *   pnpm crux statements properties --json
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { getProperties } from '../lib/wiki-server/statements.ts';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface PropertyRow {
  id: string;
  label: string;
  category: string;
  description?: string | null;
  entityTypes?: string[];
  valueType?: string;
  defaultUnit?: string | null;
  statementCount?: number;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const jsonOutput = args.json === true;
  const categoryFilter = args.category as string | undefined;
  const showUnused = args.unused === true;

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  const result = await getProperties();
  if (!result.ok) {
    console.error(`${c.red}Could not fetch properties: ${result.message}${c.reset}`);
    process.exit(1);
  }

  let properties = result.data.properties as PropertyRow[];

  // Apply filters
  if (categoryFilter) {
    properties = properties.filter((p) =>
      p.category.toLowerCase().includes(categoryFilter.toLowerCase()),
    );
  }
  if (showUnused) {
    properties = properties.filter((p) => !p.statementCount || p.statementCount === 0);
  }

  // Sort by category then by statement count (descending)
  properties.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return (b.statementCount ?? 0) - (a.statementCount ?? 0);
  });

  if (jsonOutput) {
    console.log(JSON.stringify({ total: properties.length, properties }, null, 2));
    return;
  }

  if (properties.length === 0) {
    console.log(`${c.yellow}No properties found${categoryFilter ? ` matching category '${categoryFilter}'` : ''}.${c.reset}`);
    return;
  }

  console.log(`\n${c.bold}${c.blue}Statement Properties${c.reset} (${properties.length} total)\n`);

  // Group by category
  const byCategory = new Map<string, PropertyRow[]>();
  for (const prop of properties) {
    const cat = prop.category || 'uncategorized';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(prop);
  }

  for (const [cat, props] of [...byCategory.entries()].sort()) {
    const totalStmts = props.reduce((sum, p) => sum + (p.statementCount ?? 0), 0);
    console.log(`${c.bold}${cat}${c.reset} (${props.length} properties, ${totalStmts} statements)`);

    for (const prop of props) {
      const count = prop.statementCount ?? 0;
      const countStr = count > 0 ? `${c.green}${String(count).padStart(5)}${c.reset}` : `${c.dim}    0${c.reset}`;
      const types = prop.entityTypes?.join(', ') ?? '';
      console.log(`  ${prop.id.padEnd(32)} ${countStr} uses  ${c.dim}${types}${c.reset}`);
    }
    console.log('');
  }

  // Summary
  const totalProps = properties.length;
  const usedProps = properties.filter((p) => (p.statementCount ?? 0) > 0).length;
  const unusedProps = totalProps - usedProps;
  console.log(`${c.dim}${usedProps} in use, ${unusedProps} unused${c.reset}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Properties list failed:', err);
    process.exit(1);
  });
}
