/**
 * KB Command Handlers
 *
 * CLI readability and validation tooling for the knowledge base package.
 * Resolves opaque stableId references and formats KB data human-readably.
 *
 * Usage:
 *   crux kb show <entity-id>       Show a single entity with all its data
 *   crux kb list [--type=X]        List all entities
 *   crux kb lookup <stableId>      Look up entity by stableId
 *   crux kb validate               Run all 22 validation checks
 */

import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';

import { loadKB } from '../../packages/kb/src/loader.ts';
import { computeInverses } from '../../packages/kb/src/inverse.ts';
import { validate } from '../../packages/kb/src/validate.ts';
import { formatFactValue, formatItemEntry } from '../../packages/kb/src/format.ts';
import type { Graph } from '../../packages/kb/src/graph.ts';
import type { Entity, Fact, ItemEntry, ValidationResult } from '../../packages/kb/src/types.ts';

const KB_DATA_DIR = join(PROJECT_ROOT, 'packages', 'kb', 'data');

interface KBCommandOptions extends BaseOptions {
  type?: string;
  limit?: string;
  ci?: boolean;
  errorsOnly?: boolean;
  'errors-only'?: boolean;
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

// ── validate command ─────────────────────────────────────────────────────

async function validateCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const graph = await loadGraph();
  const allResults = validate(graph);

  // Filter by severity if --errors-only
  const errorsOnly = options.errorsOnly || options['errors-only'];
  let results = allResults;
  if (errorsOnly) {
    results = results.filter((r) => r.severity === 'error');
  }

  // Filter by rule if --rule=X
  if (options.rule) {
    results = results.filter((r) => r.rule === options.rule);
  }

  if (options.ci) {
    return {
      exitCode: results.some((r) => r.severity === 'error') ? 1 : 0,
      output: JSON.stringify(results),
    };
  }

  // Group by severity
  const errors = results.filter((r) => r.severity === 'error');
  const warnings = results.filter((r) => r.severity === 'warning');
  const infos = results.filter((r) => r.severity === 'info');

  const lines: string[] = [];

  // Summary header
  const totalEntities = graph.getAllEntities().length;
  lines.push(`\x1b[1mKB Validation Report\x1b[0m`);
  lines.push(`Entities: ${totalEntities} | Errors: ${errors.length} | Warnings: ${warnings.length} | Info: ${infos.length}`);
  lines.push('');

  // Show errors first
  if (errors.length > 0) {
    lines.push(`\x1b[31m\x1b[1mErrors (${errors.length}):\x1b[0m`);
    for (const r of errors) {
      lines.push(`  \x1b[31m[${r.rule}]\x1b[0m ${r.message}`);
    }
    lines.push('');
  }

  // Then warnings
  if (warnings.length > 0 && !errorsOnly) {
    lines.push(`\x1b[33m\x1b[1mWarnings (${warnings.length}):\x1b[0m`);

    // Group warnings by rule for readability
    const warningsByRule = new Map<string, ValidationResult[]>();
    for (const r of warnings) {
      const existing = warningsByRule.get(r.rule);
      if (existing) {
        existing.push(r);
      } else {
        warningsByRule.set(r.rule, [r]);
      }
    }

    for (const [rule, ruleWarnings] of warningsByRule) {
      lines.push(`  \x1b[33m[${rule}]\x1b[0m (${ruleWarnings.length})`);
      // Show up to 5 per rule, then summarize
      const shown = ruleWarnings.slice(0, 5);
      for (const r of shown) {
        lines.push(`    ${r.message}`);
      }
      if (ruleWarnings.length > 5) {
        lines.push(`    ... and ${ruleWarnings.length - 5} more`);
      }
    }
    lines.push('');
  }

  // Then info (only if not errors-only)
  if (infos.length > 0 && !errorsOnly) {
    lines.push(`\x1b[36m\x1b[1mInfo (${infos.length}):\x1b[0m`);

    const infosByRule = new Map<string, ValidationResult[]>();
    for (const r of infos) {
      const existing = infosByRule.get(r.rule);
      if (existing) {
        existing.push(r);
      } else {
        infosByRule.set(r.rule, [r]);
      }
    }

    for (const [rule, ruleInfos] of infosByRule) {
      lines.push(`  \x1b[36m[${rule}]\x1b[0m (${ruleInfos.length})`);
      const shown = ruleInfos.slice(0, 3);
      for (const r of shown) {
        lines.push(`    ${r.message}`);
      }
      if (ruleInfos.length > 3) {
        lines.push(`    ... and ${ruleInfos.length - 3} more`);
      }
    }
    lines.push('');
  }

  // Final verdict
  if (errors.length === 0) {
    lines.push('\x1b[32mNo errors found.\x1b[0m');
  } else {
    lines.push(`\x1b[31m${errors.length} error(s) found. Fix these before proceeding.\x1b[0m`);
  }

  return {
    exitCode: errors.length > 0 ? 1 : 0,
    output: lines.join('\n'),
  };
}

// ── Exports ─────────────────────────────────────────────────────────────

export const commands = {
  show: showCommand,
  list: listCommand,
  lookup: lookupCommand,
  validate: validateCommand,
};

export function getHelp(): string {
  return `
KB Domain -- Knowledge Base readability and validation tools

Commands:
  show <entity-id>      Show a single entity with all data, resolving stableIds
  list [--type=X]       List all entities with name, type, stableId, and fact count
  lookup <stableId>     Look up an entity by its stableId
  validate              Run all validation checks on the KB graph

Options:
  --type=X              Filter list by entity type (e.g. organization, person)
  --limit=N             Limit number of results (list only)
  --errors-only         Only show errors, skip warnings and info (validate only)
  --rule=X              Filter results by check rule name (validate only)
  --ci                  JSON output

Examples:
  crux kb show anthropic              Show Anthropic with all facts and items
  crux kb show dario-amodei           Show a person entity
  crux kb list                        List all entities
  crux kb list --type=person          List only person entities
  crux kb lookup mK9pX3rQ7n           Look up entity by stableId
  crux kb validate                    Run all validation checks
  crux kb validate --errors-only      Only show errors (exit 1 if any)
  crux kb validate --rule=stale-temporal  Show only stale-temporal warnings
`;
}
