/**
 * KB Command Handlers
 *
 * CLI readability tooling for the knowledge base package.
 * Resolves opaque stableId references and formats KB data human-readably.
 *
 * Usage:
 *   crux kb show <entity-id>       Show a single entity with all its data
 *   crux kb list [--type=X]        List all entities
 *   crux kb resolve <stableId>     Resolve a stableId to entity name/slug
 */

import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';

import type { Graph } from '../../packages/kb/src/graph.ts';
import type { Entity, Fact, Property, ItemEntry } from '../../packages/kb/src/types.ts';

const KB_DATA_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data');

interface KBCommandOptions extends BaseOptions {
  type?: string;
  limit?: string;
  ci?: boolean;
}

// ── KB loading helper ───────────────────────────────────────────────────

async function loadGraph(): Promise<Graph> {
  const { loadKB } = await import('../../packages/kb/src/loader.ts');
  const { computeInverses } = await import('../../packages/kb/src/inverse.ts');
  const graph = await loadKB(KB_DATA_DIR);
  computeInverses(graph);
  return graph;
}

// ── Value formatting ────────────────────────────────────────────────────

/**
 * Format a numeric value using a property's display config.
 * Falls back to locale-formatted number if no display config exists.
 */
function formatValue(value: unknown, property?: Property): string {
  if (value === null || value === undefined) return '(none)';

  if (typeof value === 'number' && property?.display) {
    const { divisor, prefix, suffix } = property.display;
    let formatted: string;
    if (divisor && divisor !== 0) {
      const divided = value / divisor;
      // Use appropriate decimal places
      if (divided >= 100) {
        formatted = divided.toLocaleString('en-US', { maximumFractionDigits: 0 });
      } else if (divided >= 10) {
        formatted = divided.toLocaleString('en-US', { maximumFractionDigits: 1 });
      } else {
        formatted = divided.toLocaleString('en-US', { maximumFractionDigits: 1 });
      }
    } else {
      // No divisor: use raw number without locale grouping separators.
      // This handles cases like "born-year: 1983" where commas would be wrong.
      formatted = String(value);
    }
    return `${prefix ?? ''}${formatted}${suffix ?? ''}`;
  }

  if (typeof value === 'number') {
    return value.toLocaleString('en-US');
  }

  return String(value);
}

/**
 * Format a fact value for display, resolving refs to entity names when possible.
 */
function formatFactValue(fact: Fact, property: Property | undefined, graph: Graph): string {
  const val = fact.value;

  if (val.type === 'ref') {
    const entity = graph.getEntity(val.value);
    return entity ? `${entity.name} (${val.value})` : val.value;
  }

  if (val.type === 'refs') {
    return val.value
      .map((refId: string) => {
        const entity = graph.getEntity(refId);
        return entity ? `${entity.name} (${refId})` : refId;
      })
      .join(', ');
  }

  if (val.type === 'number') {
    return formatValue(val.value, property);
  }

  return String(val.value);
}

// ── show command ────────────────────────────────────────────────────────

async function showCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const entityId = args.find((a) => !a.startsWith('--'));

  if (!entityId) {
    return {
      exitCode: 1,
      output: `Usage: crux kb show <entity-id>

  Show a single entity with all its data, resolving !ref stableIds to names.

Examples:
  crux kb show anthropic
  crux kb show dario-amodei`,
    };
  }

  const graph = await loadGraph();
  const entity = graph.getEntity(entityId);

  if (!entity) {
    // Try resolving as a stableId
    const resolved = graph.getEntityByStableId(entityId);
    if (resolved) {
      return showEntity(resolved, graph, options);
    }
    return {
      exitCode: 1,
      output: `Entity not found: ${entityId}\n  Try: crux kb list`,
    };
  }

  return showEntity(entity, graph, options);
}

function showEntity(entity: Entity, graph: Graph, options: KBCommandOptions): CommandResult {
  if (options.ci) {
    const facts = graph.getFacts(entity.id);
    return {
      exitCode: 0,
      output: JSON.stringify({ entity, facts }),
    };
  }

  const lines: string[] = [];

  // Header
  lines.push(`\x1b[1m${entity.name}\x1b[0m (${entity.stableId})`);
  lines.push(`Type: ${entity.type} | Slug: ${entity.id}${entity.numericId ? ` | E${entity.numericId}` : ''}`);
  if (entity.aliases?.length) {
    lines.push(`Aliases: ${entity.aliases.join(', ')}`);
  }
  lines.push('');

  // Facts grouped by property
  const facts = graph.getFacts(entity.id);
  if (facts.length > 0) {
    // Group facts by propertyId
    const grouped = new Map<string, Fact[]>();
    for (const fact of facts) {
      const existing = grouped.get(fact.propertyId);
      if (existing) {
        existing.push(fact);
      } else {
        grouped.set(fact.propertyId, [fact]);
      }
    }

    lines.push(`\x1b[1mFacts (${facts.length}):\x1b[0m`);

    for (const [propertyId, propertyFacts] of grouped) {
      const property = graph.getProperty(propertyId);
      const propName = property?.name ?? propertyId;

      // Sort by asOf date
      const sorted = propertyFacts.slice().sort((a, b) => {
        if (!a.asOf && !b.asOf) return 0;
        if (!a.asOf) return 1;
        if (!b.asOf) return -1;
        return a.asOf.localeCompare(b.asOf);
      });

      if (sorted.length === 1) {
        const f = sorted[0];
        const val = formatFactValue(f, property, graph);
        const asOf = f.asOf ? ` (${f.asOf})` : '';
        lines.push(`  ${propName.padEnd(28)} ${val}${asOf}`);
      } else {
        // Time series: show inline
        const parts = sorted.map((f) => {
          const val = formatFactValue(f, property, graph);
          return f.asOf ? `${val} (${f.asOf})` : val;
        });

        // If the line would be too long, show multi-line
        const inlineLine = `  ${propName.padEnd(28)} ${parts.join('  ->  ')}`;
        if (inlineLine.length <= 120 || sorted.length <= 3) {
          lines.push(inlineLine);
        } else {
          lines.push(`  ${propName.padEnd(28)} ${parts[0]}`);
          for (let i = 1; i < parts.length; i++) {
            const arrow = i < parts.length ? '  ->  ' : '';
            lines.push(`  ${''.padEnd(28)} ${arrow}${parts[i]}`);
          }
        }
      }
    }
    lines.push('');
  }

  // Item collections
  const entityCollections = getEntityItemCollections(entity.id, graph);
  if (entityCollections.length > 0) {
    lines.push(`\x1b[1mItems:\x1b[0m`);
    for (const { name, items } of entityCollections) {
      lines.push(`  ${name} (${items.length} entries)`);
      for (const item of items) {
        const summary = formatItemEntry(item, name, graph);
        lines.push(`    ${summary}`);
      }
      lines.push('');
    }
  }

  return { exitCode: 0, output: lines.join('\n') };
}

/**
 * Get all item collections for an entity by inspecting the graph internally.
 */
function getEntityItemCollections(
  entityId: string,
  graph: Graph,
): Array<{ name: string; items: ItemEntry[] }> {
  // Access the graph's getItems method for known collection names.
  // We try the common collection names from schemas.
  const knownCollections = [
    'funding-rounds',
    'key-people',
    'products',
    'model-releases',
    'board-members',
    'strategic-partnerships',
    'safety-milestones',
    'research-areas',
  ];

  const results: Array<{ name: string; items: ItemEntry[] }> = [];
  for (const collName of knownCollections) {
    const items = graph.getItems(entityId, collName);
    if (items.length > 0) {
      results.push({ name: collName, items });
    }
  }

  return results;
}

/**
 * Format a single item entry for display.
 */
function formatItemEntry(item: ItemEntry, collectionName: string, graph: Graph): string {
  const f = item.fields;

  switch (collectionName) {
    case 'funding-rounds': {
      const date = f.date ?? '';
      const amount = typeof f.amount === 'number' ? formatMoney(f.amount) : '';
      const valuation = typeof f.valuation === 'number' ? ` @ ${formatMoney(f.valuation)}` : '';
      const lead = f.lead_investor ? resolveRefName(String(f.lead_investor), graph) : '';
      const leadStr = lead ? `  lead: ${lead}` : '';
      return `${date}  ${amount}${valuation}${leadStr}`;
    }

    case 'key-people': {
      const person = f.person ? resolveRefName(String(f.person), graph) : '(unknown)';
      const title = f.title ?? '';
      const start = f.start ?? '';
      const end = f.end ?? 'present';
      const founder = f.is_founder ? ', founder' : '';
      return `${person} -- ${title} (${start}--${end}${founder})`;
    }

    case 'products': {
      const name = f.name ?? item.key;
      const launched = f.launched ?? '';
      const desc = f.description ? ` - ${f.description}` : '';
      return `${launched}  ${name}${desc}`;
    }

    case 'model-releases': {
      const name = f.name ?? item.key;
      const released = f.released ?? '';
      const safety = f.safety_level ? ` [${f.safety_level}]` : '';
      const desc = f.description ? ` - ${f.description}` : '';
      return `${released}  ${name}${safety}${desc}`;
    }

    case 'board-members': {
      const name = f.name ?? item.key;
      const role = f.role ? ` -- ${f.role}` : '';
      const appointed = f.appointed ? ` (${f.appointed})` : '';
      return `${name}${role}${appointed}`;
    }

    case 'strategic-partnerships': {
      const partner = f.partner ?? item.key;
      const date = f.date ?? '';
      const type = f.type ? ` [${f.type}]` : '';
      const investAmount =
        typeof f.investment_amount === 'number'
          ? ` ${formatMoney(f.investment_amount)}`
          : '';
      return `${date}  ${partner}${type}${investAmount}`;
    }

    case 'safety-milestones': {
      const name = f.name ?? item.key;
      const date = f.date ?? '';
      const type = f.type ? ` [${f.type}]` : '';
      return `${date}  ${name}${type}`;
    }

    case 'research-areas': {
      const name = f.name ?? item.key;
      const desc = f.description ? ` - ${f.description}` : '';
      return `${name}${desc}`;
    }

    default: {
      // Generic: show all fields
      const parts = Object.entries(f)
        .filter(([_, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}: ${String(v)}`);
      return parts.join(', ');
    }
  }
}

/**
 * Resolve a slug to a display name, falling back to the slug itself.
 */
function resolveRefName(slug: string, graph: Graph): string {
  const entity = graph.getEntity(slug);
  return entity ? entity.name : slug;
}

/**
 * Format a monetary amount in a compact human-readable form.
 */
function formatMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value}`;
}

// ── list command ────────────────────────────────────────────────────────

async function listCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const graph = await loadGraph();
  let entities = graph.getAllEntities();

  // Filter by type if specified
  if (options.type) {
    entities = entities.filter((e) => e.type === options.type);
  }

  // Sort by type then by name
  entities.sort((a, b) => {
    const typeCmp = a.type.localeCompare(b.type);
    if (typeCmp !== 0) return typeCmp;
    return a.name.localeCompare(b.name);
  });

  // Apply limit
  const limit = options.limit ? parseInt(String(options.limit), 10) : undefined;
  if (limit && limit > 0) {
    entities = entities.slice(0, limit);
  }

  if (options.ci) {
    const data = entities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      stableId: e.stableId,
      factCount: graph.getFacts(e.id).length,
    }));
    return { exitCode: 0, output: JSON.stringify(data) };
  }

  // Table header
  const lines: string[] = [];
  const header = `${'ID'.padEnd(24)} ${'Name'.padEnd(24)} ${'Type'.padEnd(16)} ${'StableId'.padEnd(14)} Facts`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(header.length));

  for (const entity of entities) {
    const facts = graph.getFacts(entity.id);
    const row = `${entity.id.padEnd(24)} ${entity.name.padEnd(24)} ${entity.type.padEnd(16)} ${entity.stableId.padEnd(14)} ${facts.length}`;
    lines.push(row);
  }

  lines.push('');
  lines.push(`Total: ${entities.length} entities`);

  return { exitCode: 0, output: lines.join('\n') };
}

// ── resolve command ─────────────────────────────────────────────────────

async function resolveCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const stableId = args.find((a) => !a.startsWith('--'));

  if (!stableId) {
    return {
      exitCode: 1,
      output: `Usage: crux kb resolve <stableId>

  Resolve a stableId to its entity name and slug.

Examples:
  crux kb resolve mK9pX3rQ7n
  crux kb resolve zR4nW8xB2f`,
    };
  }

  const graph = await loadGraph();
  const entity = graph.getEntityByStableId(stableId);

  if (!entity) {
    return {
      exitCode: 1,
      output: `No entity found for stableId: ${stableId}`,
    };
  }

  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({ stableId, slug: entity.id, name: entity.name, type: entity.type }),
    };
  }

  return {
    exitCode: 0,
    output: `${stableId} -> ${entity.name} (${entity.id})\n  Type: ${entity.type}${entity.numericId ? ` | E${entity.numericId}` : ''}`,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────

export const commands = {
  show: showCommand,
  list: listCommand,
  resolve: resolveCommand,
};

export function getHelp(): string {
  return `
KB Domain -- Knowledge Base readability tools

Commands:
  show <entity-id>      Show a single entity with all data, resolving stableIds
  list [--type=X]       List all entities with name, type, stableId, and fact count
  resolve <stableId>    Resolve a stableId to its entity name and slug

Options:
  --type=X              Filter list by entity type (e.g. organization, person)
  --limit=N             Limit number of results (list only)
  --ci                  JSON output

Examples:
  crux kb show anthropic              Show Anthropic with all facts and items
  crux kb show dario-amodei           Show a person entity
  crux kb list                        List all entities
  crux kb list --type=person          List only person entities
  crux kb resolve mK9pX3rQ7n          Resolve stableId to name
`;
}
