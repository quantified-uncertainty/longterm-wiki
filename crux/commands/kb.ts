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
 *   crux kb properties             List all property definitions with usage counts
 */

import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';

import { loadKB } from '../../packages/kb/src/loader.ts';
import { computeInverses } from '../../packages/kb/src/inverse.ts';
import { validate, validateEntity } from '../../packages/kb/src/validate.ts';
import { formatFactValue, formatItemEntry } from '../../packages/kb/src/format.ts';
import type { Graph } from '../../packages/kb/src/graph.ts';
import type { Entity, Fact, ItemEntry, ValidationResult } from '../../packages/kb/src/types.ts';

const KB_DATA_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data');

interface KBCommandOptions extends BaseOptions {
  type?: string;
  limit?: string;
  ci?: boolean;
  errorsOnly?: boolean;
  rule?: string;
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
      itemCount: graph.getItemCollectionNames(e.id).reduce(
        (sum, col) => sum + graph.getItems(e.id, col).length,
        0,
      ),
    }));
    return { exitCode: 0, output: JSON.stringify(data) };
  }

  // Table header
  const lines: string[] = [];
  const header = `${'ID'.padEnd(24)} ${'Name'.padEnd(24)} ${'Type'.padEnd(16)} ${'StableId'.padEnd(14)} ${'Facts'.padEnd(7)} Items`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(header.length));

  for (const entity of entities) {
    const facts = graph.getFacts(entity.id);
    const itemCount = graph.getItemCollectionNames(entity.id).reduce(
      (sum, col) => sum + graph.getItems(entity.id, col).length,
      0,
    );
    const row = `${entity.id.padEnd(24)} ${entity.name.padEnd(24)} ${entity.type.padEnd(16)} ${entity.stableId.padEnd(14)} ${String(facts.length).padEnd(7)} ${itemCount}`;
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

// ── validate command ─────────────────────────────────────────────────────

async function validateCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const entityId = args.find((a) => !a.startsWith('--'));
  const graph = await loadGraph();

  let results: ValidationResult[];
  if (entityId) {
    results = validateEntity(graph, entityId);
  } else {
    results = validate(graph);
  }

  // Filter by severity
  if (options.errorsOnly) {
    results = results.filter((r) => r.severity === 'error');
  }

  // Filter by rule
  if (options.rule) {
    results = results.filter((r) => r.rule === options.rule);
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(results) };
  }

  if (results.length === 0) {
    const scope = entityId ? `"${entityId}"` : 'all entities';
    return { exitCode: 0, output: `No issues found for ${scope}.` };
  }

  const lines: string[] = [];
  const errors = results.filter((r) => r.severity === 'error');
  const warnings = results.filter((r) => r.severity === 'warning');
  const infos = results.filter((r) => r.severity === 'info');

  const scope = entityId ? `"${entityId}"` : `${graph.getAllEntities().length} entities`;
  lines.push(`\x1b[1mKB Validation: ${scope}\x1b[0m`);
  lines.push(`  ${errors.length} errors, ${warnings.length} warnings, ${infos.length} info`);
  lines.push('');

  const severityIcon: Record<string, string> = { error: '\x1b[31mERR\x1b[0m', warning: '\x1b[33mWRN\x1b[0m', info: '\x1b[36mINF\x1b[0m' };

  for (const result of results) {
    const icon = severityIcon[result.severity] ?? result.severity;
    const entity = result.entityId ? ` [${result.entityId}]` : '';
    lines.push(`  ${icon}${entity} ${result.message}`);
  }

  return { exitCode: errors.length > 0 ? 1 : 0, output: lines.join('\n') };
}

// ── properties command ───────────────────────────────────────────────────

async function propertiesCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const graph = await loadGraph();
  const allProperties = graph.getAllProperties();
  const allEntities = graph.getAllEntities();

  // Compute usage counts for each property
  const usageData = allProperties.map((prop) => {
    let totalFactCount = 0;
    let usedByCount = 0;

    for (const entity of allEntities) {
      const facts = graph.getFacts(entity.id, { property: prop.id });
      if (facts.length > 0) {
        usedByCount++;
        totalFactCount += facts.length;
      }
    }

    return {
      property: prop,
      usedByCount,
      totalFactCount,
    };
  });

  // Filter by category if specified
  let filtered = usageData;
  if (options.type) {
    filtered = filtered.filter((d) => d.property.category === options.type);
  }

  // Sort by total fact count descending, then by name
  filtered.sort((a, b) => {
    const countDiff = b.totalFactCount - a.totalFactCount;
    if (countDiff !== 0) return countDiff;
    return a.property.name.localeCompare(b.property.name);
  });

  if (options.ci) {
    const data = filtered.map((d) => ({
      id: d.property.id,
      name: d.property.name,
      dataType: d.property.dataType,
      category: d.property.category ?? '',
      computed: d.property.computed ?? false,
      temporal: d.property.temporal ?? false,
      usedByCount: d.usedByCount,
      totalFactCount: d.totalFactCount,
    }));
    return { exitCode: 0, output: JSON.stringify(data) };
  }

  const lines: string[] = [];
  const header = `${'Property'.padEnd(28)} ${'Category'.padEnd(14)} ${'Type'.padEnd(8)} ${'Used By'.padEnd(9)} ${'Count'.padEnd(7)} Flags`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(header.length));

  for (const { property, usedByCount, totalFactCount } of filtered) {
    const flags: string[] = [];
    if (property.computed) flags.push('computed');
    if (property.temporal) flags.push('temporal');
    if (property.inverseId) flags.push(`inv:${property.inverseId}`);

    const row = `${property.id.padEnd(28)} ${(property.category ?? '').padEnd(14)} ${property.dataType.padEnd(8)} ${String(usedByCount).padEnd(9)} ${String(totalFactCount).padEnd(7)} ${flags.join(', ')}`;
    lines.push(row);
  }

  lines.push('');
  lines.push(`Total: ${filtered.length} properties`);

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Exports ─────────────────────────────────────────────────────────────

export const commands = {
  show: showCommand,
  list: listCommand,
  lookup: lookupCommand,
  validate: validateCommand,
  properties: propertiesCommand,
};

export function getHelp(): string {
  return `
KB Domain -- Knowledge Base readability tools

Commands:
  show <entity-id>      Show a single entity with all data, resolving stableIds
  list [--type=X]       List all entities with name, type, stableId, fact/item counts
  lookup <stableId>     Look up an entity by its stableId
  properties            List all property definitions with usage counts
  validate [entity-id]  Validate all entities or a single entity

Options:
  --type=X              Filter by entity type (list) or property category (properties)
  --limit=N             Limit number of results (list only)
  --errors-only         Show only errors (validate only)
  --rule=X              Filter by rule name (validate only)
  --ci                  JSON output

Examples:
  crux kb show anthropic              Show Anthropic with all facts and items
  crux kb show dario-amodei           Show a person entity
  crux kb list                        List all entities
  crux kb list --type=person          List only person entities
  crux kb lookup mK9pX3rQ7n           Look up entity by stableId
  crux kb properties                  List all properties with usage counts
  crux kb properties --type=financial Filter properties by category
  crux kb validate                    Validate all entities
  crux kb validate anthropic          Validate a single entity
  crux kb validate --errors-only      Show only errors
  crux kb validate --rule=ref-integrity  Filter by rule
`;
}
