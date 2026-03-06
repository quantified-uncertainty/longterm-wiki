/**
 * KB Command Handlers
 *
 * CLI readability tooling for the knowledge base package.
 * Resolves opaque stableId references and formats KB data human-readably.
 *
 * Usage:
 *   crux kb show <entity-id>       Show a single entity with all its data
 *   crux kb list [--type=X]        List all entities
 *   crux kb lookup <stableId>      Look up entity by stableId
 */

import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';

import { loadKB } from '../../packages/kb/src/loader.ts';
import { computeInverses } from '../../packages/kb/src/inverse.ts';
import { formatFactValue, formatItemEntry } from '../../packages/kb/src/format.ts';
import type { Graph } from '../../packages/kb/src/graph.ts';
import type { Entity, Fact, ItemEntry } from '../../packages/kb/src/types.ts';

const KB_DATA_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data');

interface KBCommandOptions extends BaseOptions {
  type?: string;
  limit?: string;
  ci?: boolean;
}

// ── KB loading helper ───────────────────────────────────────────────────

async function loadGraph(): Promise<Graph> {
  const graph = await loadKB(KB_DATA_DIR);
  computeInverses(graph);
  return graph;
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
            const arrow = i < parts.length - 1 ? '  ->  ' : '      ';
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
 * Get all item collections for an entity by querying the graph directly.
 */
function getEntityItemCollections(
  entityId: string,
  graph: Graph,
): Array<{ name: string; items: ItemEntry[] }> {
  const results: Array<{ name: string; items: ItemEntry[] }> = [];
  for (const collName of graph.getItemCollectionNames(entityId)) {
    const items = graph.getItems(entityId, collName);
    if (items.length > 0) {
      results.push({ name: collName, items });
    }
  }
  return results;
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

// ── lookup command ──────────────────────────────────────────────────────

async function lookupCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const stableId = args.find((a) => !a.startsWith('--'));

  if (!stableId) {
    return {
      exitCode: 1,
      output: `Usage: crux kb lookup <stableId>

  Look up an entity by its stableId.

Examples:
  crux kb lookup mK9pX3rQ7n
  crux kb lookup zR4nW8xB2f`,
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
  lookup: lookupCommand,
};

export function getHelp(): string {
  return `
KB Domain -- Knowledge Base readability tools

Commands:
  show <entity-id>      Show a single entity with all data, resolving stableIds
  list [--type=X]       List all entities with name, type, stableId, and fact count
  lookup <stableId>     Look up an entity by its stableId

Options:
  --type=X              Filter list by entity type (e.g. organization, person)
  --limit=N             Limit number of results (list only)
  --ci                  JSON output

Examples:
  crux kb show anthropic              Show Anthropic with all facts and items
  crux kb show dario-amodei           Show a person entity
  crux kb list                        List all entities
  crux kb list --type=person          List only person entities
  crux kb lookup mK9pX3rQ7n           Look up entity by stableId
`;
}
