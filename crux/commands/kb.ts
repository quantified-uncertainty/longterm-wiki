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

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';

import { formatFactValue } from '../../packages/kb/src/format.ts';
import { validate } from '../../packages/kb/src/validate.ts';
import type { Graph } from '../../packages/kb/src/graph.ts';
import type { Entity, Fact, RecordEntry, ValidationResult } from '../../packages/kb/src/types.ts';
import { commands as kbMigrateCommands } from './kb-migrate.ts';
import { verifyCommand } from './kb-verify.ts';
import { lookupResourceByUrl, upsertResource } from '../lib/wiki-server/resources.ts';
import { hashId, guessResourceType } from '../resource-utils.ts';
import { loadGraphFull, loadGraph, resolveEntity, KB_DATA_DIR } from '../lib/kb-loader.ts';
import type { LoadedKB } from '../lib/kb-loader.ts';
import {
  readEntityDocument,
  appendFact,
  writeEntityDocument,
  findEntityFilePath,
} from '../lib/kb-writer.ts';
import type { RawFactInput } from '../lib/kb-writer.ts';

interface KBCommandOptions extends BaseOptions {
  type?: string;
  limit?: string;
  ci?: boolean;
  errorsOnly?: boolean;
  'errors-only'?: boolean;
  rule?: string;
  asOf?: string;
  'as-of'?: string;
  source?: string;
  notes?: string;
  currency?: string;
  force?: boolean;
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

  const kb = await loadGraphFull();
  const entity = resolveEntity(entityId, kb);

  if (!entity) {
    return {
      exitCode: 1,
      output: `Entity not found: ${entityId}\n  Try: crux kb list`,
    };
  }

  return showEntity(entity, kb.graph, options);
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
  lines.push(`\x1b[1m${entity.name}\x1b[0m (${entity.id})`);
  lines.push(`Type: ${entity.type}${entity.wikiPageId ? ` | ${entity.wikiPageId}` : ''}`);
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

  // Record collections
  const recordCollections = getEntityRecordCollections(entity.id, graph);
  if (recordCollections.length > 0) {
    lines.push(`\x1b[1mRecords:\x1b[0m`);
    for (const { name, records } of recordCollections) {
      lines.push(`  ${name} (${records.length} entries)`);
      for (const record of records) {
        const summary = formatRecordEntry(record, graph);
        lines.push(`    ${summary}`);
      }
      lines.push('');
    }
  }

  return { exitCode: 0, output: lines.join('\n') };
}

/**
 * Get all record collections for an entity by querying the graph directly.
 */
function getEntityRecordCollections(
  entityId: string,
  graph: Graph,
): Array<{ name: string; records: RecordEntry[] }> {
  const results: Array<{ name: string; records: RecordEntry[] }> = [];
  for (const collName of graph.getRecordCollectionNames(entityId)) {
    const records = graph.getRecords(entityId, collName);
    if (records.length > 0) {
      results.push({ name: collName, records });
    }
  }
  return results;
}

/**
 * Format a record entry for display.
 */
function formatRecordEntry(record: RecordEntry, graph: Graph): string {
  const name = record.displayName || record.key;
  const fields = Object.entries(record.fields)
    .map(([k, v]) => {
      // Resolve entity refs to names
      if (typeof v === 'string') {
        const entity = graph.getEntity(v);
        if (entity) return `${k}: ${entity.name} (${v})`;
      }
      return `${k}: ${v}`;
    })
    .join(', ');
  return `${name}: ${fields}`;
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
      factCount: graph.getFacts(e.id).length,
      recordCount: graph.getRecordCollectionNames(e.id).reduce(
        (sum, col) => sum + graph.getRecords(e.id, col).length,
        0,
      ),
    }));
    return { exitCode: 0, output: JSON.stringify(data) };
  }

  // Table header
  const lines: string[] = [];
  const header = `${'ID'.padEnd(14)} ${'Name'.padEnd(28)} ${'Type'.padEnd(16)} ${'Facts'.padEnd(7)} Records`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(header.length));

  for (const entity of entities) {
    const facts = graph.getFacts(entity.id);
    const recordCount = graph.getRecordCollectionNames(entity.id).reduce(
      (sum, col) => sum + graph.getRecords(entity.id, col).length,
      0,
    );
    const row = `${entity.id.padEnd(14)} ${entity.name.padEnd(28)} ${entity.type.padEnd(16)} ${String(facts.length).padEnd(7)} ${recordCount}`;
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
      output: JSON.stringify({ stableId, name: entity.name, type: entity.type }),
    };
  }

  return {
    exitCode: 0,
    output: `${stableId} -> ${entity.name}\n  Type: ${entity.type}${entity.wikiPageId ? ` | ${entity.wikiPageId}` : ''}`,
  };
}

// ── Validate command ────────────────────────────────────────────────────

async function validateCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const graph = await loadGraph();
  const allResults = validate(graph);

  const errorsOnly = options.errorsOnly || options['errors-only'];
  let results = allResults;
  if (errorsOnly) {
    results = results.filter((r: ValidationResult) => r.severity === 'error');
  }
  if (options.rule) {
    results = results.filter((r: ValidationResult) => r.rule === options.rule);
  }

  if (options.ci) {
    return {
      exitCode: results.some((r: ValidationResult) => r.severity === 'error') ? 1 : 0,
      output: JSON.stringify(results),
    };
  }

  const errors = results.filter((r: ValidationResult) => r.severity === 'error');
  const warnings = results.filter((r: ValidationResult) => r.severity === 'warning');
  const infos = results.filter((r: ValidationResult) => r.severity === 'info');

  const lines: string[] = [];
  const totalEntities = graph.getAllEntities().length;
  lines.push(`\x1b[1mKB Validation Report\x1b[0m`);
  lines.push(`Entities: ${totalEntities} | Errors: ${errors.length} | Warnings: ${warnings.length} | Info: ${infos.length}`);
  lines.push('');

  if (errors.length > 0) {
    lines.push(`\x1b[31m\x1b[1mErrors (${errors.length}):\x1b[0m`);
    for (const r of errors) {
      lines.push(`  \x1b[31m[${r.rule}]\x1b[0m ${r.message}`);
    }
    lines.push('');
  }

  if (warnings.length > 0 && !errorsOnly) {
    lines.push(`\x1b[33m\x1b[1mWarnings (${warnings.length}):\x1b[0m`);
    const warningsByRule = new Map<string, ValidationResult[]>();
    for (const r of warnings) {
      const existing = warningsByRule.get(r.rule);
      if (existing) existing.push(r);
      else warningsByRule.set(r.rule, [r]);
    }
    for (const [rule, ruleWarnings] of warningsByRule) {
      lines.push(`  \x1b[33m[${rule}]\x1b[0m (${ruleWarnings.length})`);
      for (const r of ruleWarnings.slice(0, 5)) {
        lines.push(`    ${r.message}`);
      }
      if (ruleWarnings.length > 5) {
        lines.push(`    ... and ${ruleWarnings.length - 5} more`);
      }
    }
    lines.push('');
  }

  if (infos.length > 0 && !errorsOnly) {
    lines.push(`\x1b[36m\x1b[1mInfo (${infos.length}):\x1b[0m`);
    const infosByRule = new Map<string, ValidationResult[]>();
    for (const r of infos) {
      const existing = infosByRule.get(r.rule);
      if (existing) existing.push(r);
      else infosByRule.set(r.rule, [r]);
    }
    for (const [rule, ruleInfos] of infosByRule) {
      lines.push(`  \x1b[36m[${rule}]\x1b[0m (${ruleInfos.length})`);
      for (const r of ruleInfos.slice(0, 3)) {
        lines.push(`    ${r.message}`);
      }
      if (ruleInfos.length > 3) {
        lines.push(`    ... and ${ruleInfos.length - 3} more`);
      }
    }
    lines.push('');
  }

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

// ── properties command ───────────────────────────────────────────────────

async function propertiesCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const graph = await loadGraph();
  const allProperties = graph.getAllProperties();
  const allEntities = graph.getAllEntities();

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

    return { property: prop, usedByCount, totalFactCount };
  });

  let filtered = usageData;
  if (options.type) {
    filtered = filtered.filter((d) => d.property.category === options.type);
  }

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

// ── search command ───────────────────────────────────────────────────────

async function searchCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const query = args.find((a) => !a.startsWith('--'));

  if (!query) {
    return {
      exitCode: 1,
      output: `Usage: crux kb search <query> [--type=X]

  Search KB entities by name, ID, or alias (case-insensitive substring match).

Examples:
  crux kb search anthropic
  crux kb search "open ai"
  crux kb search amodei --type=person`,
    };
  }

  const graph = await loadGraph();
  let entities = graph.getAllEntities();

  if (options.type) {
    entities = entities.filter((e) => e.type === options.type);
  }

  const q = query.toLowerCase();
  const matches = entities.filter((e) => {
    if (e.id.toLowerCase().includes(q)) return true;
    if (e.name.toLowerCase().includes(q)) return true;
    if (e.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
    if (e.wikiPageId?.toLowerCase().includes(q)) return true;
    return false;
  });

  if (options.ci) {
    const data = matches.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      wikiPageId: e.wikiPageId,
      aliases: e.aliases,
      factCount: graph.getFacts(e.id).length,
    }));
    return { exitCode: 0, output: JSON.stringify(data) };
  }

  if (matches.length === 0) {
    return { exitCode: 0, output: `No KB entities found matching "${query}"` };
  }

  const lines: string[] = [];
  const header = `${'ID'.padEnd(14)} ${'Name'.padEnd(28)} ${'Type'.padEnd(16)} ${'WikiPageId'.padEnd(10)} Facts`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(header.length));

  for (const entity of matches) {
    const factCount = graph.getFacts(entity.id).length;
    const row = `${entity.id.padEnd(14)} ${entity.name.padEnd(28)} ${entity.type.padEnd(16)} ${(entity.wikiPageId ?? '').padEnd(10)} ${factCount}`;
    lines.push(row);
    if (entity.aliases?.length) {
      lines.push(`  ${''.padEnd(26)} Aliases: ${entity.aliases.join(', ')}`);
    }
  }

  lines.push('');
  lines.push(`${matches.length} result(s) for "${query}"`);

  return { exitCode: 0, output: lines.join('\n') };
}

// ── coverage command ─────────────────────────────────────────────────────

async function coverageCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const graph = await loadGraph();
  let entities = graph.getAllEntities();

  if (options.type) {
    entities = entities.filter((e) => e.type === options.type);
  }

  // For each entity: facts count and distinct properties used vs applicable for type
  interface CoverageRow {
    entity: Entity;
    factCount: number;
    applicable: number;   // non-computed properties that apply to this entity type
    used: number;         // distinct propertyIds with ≥1 stored fact
    score: number;        // 0–100 (used/applicable * 100)
  }

  const allProperties = graph.getAllProperties().filter((p) => !p.computed);

  const rows: CoverageRow[] = entities.map((entity) => {
    const applicable = allProperties.filter((p) =>
      !p.appliesTo || p.appliesTo.length === 0 || p.appliesTo.includes(entity.type)
    ).length;

    const entityFacts = graph.getFacts(entity.id).filter((f) => !f.id.startsWith('inv_'));
    const factCount = entityFacts.length;
    const usedProps = new Set(entityFacts.map((f) => f.propertyId));
    const used = usedProps.size;
    const score = applicable > 0 && factCount > 0 ? Math.round((used / applicable) * 100) : 0;

    return { entity, factCount, applicable, used, score };
  });

  // Sort: most facts first, then alphabetically
  rows.sort((a, b) => {
    if (b.factCount !== a.factCount) return b.factCount - a.factCount;
    return a.entity.name.localeCompare(b.entity.name);
  });

  if (options.ci) {
    const data = rows.map((r) => ({
      id: r.entity.id,
      name: r.entity.name,
      type: r.entity.type,
      factCount: r.factCount,
      applicableProperties: r.applicable,
      usedProperties: r.used,
      score: r.score,
    }));
    return { exitCode: 0, output: JSON.stringify(data) };
  }

  const lines: string[] = [];
  const header = `${'Entity'.padEnd(28)} ${'Type'.padEnd(16)} ${'Facts'.padEnd(7)} ${'Props used'.padEnd(12)} Coverage`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(header.length));

  for (const r of rows) {
    const scoreColor = r.factCount === 0 ? '\x1b[90m' : r.score >= 20 ? '\x1b[32m' : r.score >= 10 ? '\x1b[33m' : '\x1b[31m';
    const propStr = r.factCount > 0 ? `${r.used}/${r.applicable}` : '-';
    const scoreStr = r.factCount === 0 ? 'stub' : `${r.score}%`;
    const row = `${r.entity.name.padEnd(28)} ${r.entity.type.padEnd(16)} ${String(r.factCount).padEnd(7)} ${propStr.padEnd(12)} ${scoreColor}${scoreStr}\x1b[0m`;
    lines.push(row);
  }

  const withFacts = rows.filter((r) => r.factCount > 0).length;
  const stubs = rows.filter((r) => r.factCount === 0).length;
  lines.push('');
  lines.push(`Total: ${rows.length} entities | With facts: ${withFacts} | Stubs: ${stubs}`);

  return { exitCode: 0, output: lines.join('\n') };
}

// ── fact command ─────────────────────────────────────────────────────────

async function factCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const factId = args.find((a) => !a.startsWith('--'));

  if (!factId) {
    return {
      exitCode: 1,
      output: `Usage: crux kb fact <fact-id>

  Show a single fact with full metadata.

Examples:
  crux kb fact f_dW5cR9mJ8q`,
    };
  }

  const graph = await loadGraph();

  // Search all entities for this fact
  for (const entity of graph.getAllEntities()) {
    const facts = graph.getFacts(entity.id);
    const match = facts.find((f: Fact) => f.id === factId);
    if (match) {
      const property = graph.getProperty(match.propertyId);
      const val = formatFactValue(match, property, graph);

      if (options.ci) {
        return { exitCode: 0, output: JSON.stringify({ entity: entity.id, entityName: entity.name, fact: match, formattedValue: val }) };
      }

      const lines: string[] = [];
      lines.push(`\x1b[1m${match.id}\x1b[0m`);
      lines.push(`Entity:   ${entity.name} (${entity.id})`);
      lines.push(`Property: ${property?.name ?? match.propertyId} (${match.propertyId})`);
      lines.push(`Value:    ${val}`);
      if (match.asOf) lines.push(`As of:    ${match.asOf}`);
      if (match.validEnd) lines.push(`Valid until: ${match.validEnd}`);
      if (match.source) lines.push(`Source:   ${match.source}`);
      if (match.notes) lines.push(`Notes:    ${match.notes}`);
      if (match.currency) lines.push(`Currency: ${match.currency}`);
      lines.push(`\nWeb: /kb/fact/${match.id}`);
      lines.push(`Entity page: /kb/entity/${entity.id}#${match.propertyId}`);
      return { exitCode: 0, output: lines.join('\n') };
    }
  }

  return { exitCode: 1, output: `Fact not found: ${factId}` };
}

// ── stale command ────────────────────────────────────────────────────────

async function staleCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const daysStr = args.find((a) => !a.startsWith('--')) ?? '180';
  const days = parseInt(daysStr, 10);
  if (isNaN(days) || days <= 0) {
    return { exitCode: 1, output: `Invalid days: ${daysStr}` };
  }

  const graph = await loadGraph();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  interface StaleEntry { entityId: string; entityName: string; propertyId: string; propertyName: string; asOf: string; factId: string; }
  const stale: StaleEntry[] = [];

  for (const entity of graph.getAllEntities()) {
    const facts = graph.getFacts(entity.id);
    // Group by property, take latest per property
    const latestByProp = new Map<string, Fact>();
    for (const f of facts) {
      if (f.propertyId === 'description') continue;
      if (f.id.startsWith('inv_')) continue;
      const existing = latestByProp.get(f.propertyId);
      if (!existing || (f.asOf && (!existing.asOf || f.asOf > existing.asOf))) {
        latestByProp.set(f.propertyId, f);
      }
    }

    for (const [propertyId, fact] of latestByProp) {
      if (fact.asOf && fact.asOf < cutoffStr) {
        const property = graph.getProperty(propertyId);
        stale.push({
          entityId: entity.id,
          entityName: entity.name,
          propertyId,
          propertyName: property?.name ?? propertyId,
          asOf: fact.asOf,
          factId: fact.id,
        });
      }
    }
  }

  stale.sort((a, b) => a.asOf.localeCompare(b.asOf));

  const limit = options.limit ? parseInt(String(options.limit), 10) : 30;
  const shown = stale.slice(0, limit);

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(stale) };
  }

  if (stale.length === 0) {
    return { exitCode: 0, output: `No facts older than ${days} days found.` };
  }

  const lines: string[] = [];
  lines.push(`\x1b[1mStale facts (older than ${days} days, cutoff: ${cutoffStr}):\x1b[0m`);
  lines.push('');
  const header = `${'Entity'.padEnd(24)} ${'Property'.padEnd(24)} ${'As Of'.padEnd(12)} Fact ID`;
  lines.push(header);
  lines.push('-'.repeat(header.length + 16));
  for (const s of shown) {
    lines.push(`${s.entityName.slice(0, 23).padEnd(24)} ${s.propertyName.slice(0, 23).padEnd(24)} ${s.asOf.padEnd(12)} ${s.factId}`);
  }
  if (stale.length > limit) {
    lines.push(`\n... and ${stale.length - limit} more (use --limit=${stale.length} to see all)`);
  }
  lines.push(`\nTotal: ${stale.length} stale facts`);
  return { exitCode: 0, output: lines.join('\n') };
}

// ── needs-update command ─────────────────────────────────────────────────

async function needsUpdateCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const entityId = args.find((a) => !a.startsWith('--'));

  if (!entityId) {
    return {
      exitCode: 1,
      output: `Usage: crux kb needs-update <entity-id>

  Show what data is missing or stale for an entity.

Examples:
  crux kb needs-update anthropic
  crux kb needs-update openai`,
    };
  }

  const kb = await loadGraphFull();
  const entity = resolveEntity(entityId, kb);
  const graph = kb.graph;

  if (!entity) {
    return { exitCode: 1, output: `Entity not found: ${entityId}` };
  }

  // Get applicable properties for this entity type
  const allProperties = graph.getAllProperties().filter((p) => !p.computed);
  const applicable = allProperties.filter((p) =>
    !p.appliesTo || p.appliesTo.length === 0 || p.appliesTo.includes(entity.type),
  );

  const facts = graph.getFacts(entity.id).filter((f: Fact) => !f.id.startsWith('inv_'));
  const usedProps = new Set(facts.map((f: Fact) => f.propertyId));

  // Missing properties
  const missing = applicable.filter((p) => !usedProps.has(p.id));

  // Stale properties (latest fact > 180 days old)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  interface StaleProperty { property: typeof applicable[0]; latestAsOf: string; }
  const staleProps: StaleProperty[] = [];

  for (const prop of applicable) {
    if (!usedProps.has(prop.id)) continue;
    const propFacts = facts.filter((f: Fact) => f.propertyId === prop.id);
    const latest = propFacts.reduce((best: Fact | null, f: Fact) =>
      !best || (f.asOf && (!best.asOf || f.asOf > best.asOf)) ? f : best, null);
    if (latest?.asOf && latest.asOf < cutoffStr) {
      staleProps.push({ property: prop, latestAsOf: latest.asOf });
    }
  }

  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        entityId: entity.id,
        entityName: entity.name,
        entityType: entity.type,
        totalApplicable: applicable.length,
        totalUsed: usedProps.size,
        missing: missing.map((p) => ({ id: p.id, name: p.name, category: p.category })),
        stale: staleProps.map((s) => ({ id: s.property.id, name: s.property.name, latestAsOf: s.latestAsOf })),
      }),
    };
  }

  const lines: string[] = [];
  lines.push(`\x1b[1m${entity.name}\x1b[0m (${entity.id}) — ${entity.type}`);
  lines.push(`Properties: ${usedProps.size}/${applicable.length} used (${Math.round((usedProps.size / applicable.length) * 100)}%)`);
  lines.push('');

  if (missing.length > 0) {
    lines.push(`\x1b[33mMissing properties (${missing.length}):\x1b[0m`);
    for (const p of missing.slice(0, 20)) {
      lines.push(`  ${p.id.padEnd(28)} ${p.name} ${p.category ? `[${p.category}]` : ''}`);
    }
    if (missing.length > 20) lines.push(`  ... and ${missing.length - 20} more`);
    lines.push('');
  }

  if (staleProps.length > 0) {
    lines.push(`\x1b[31mStale properties (>${cutoffStr}):\x1b[0m`);
    for (const s of staleProps) {
      lines.push(`  ${s.property.id.padEnd(28)} ${s.property.name.padEnd(20)} last: ${s.latestAsOf}`);
    }
    lines.push('');
  }

  if (missing.length === 0 && staleProps.length === 0) {
    lines.push('\x1b[32mAll applicable properties are present and up-to-date.\x1b[0m');
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── sync-sources command ─────────────────────────────────────────────────

async function syncSourcesCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const graph = await loadGraph();

  // Collect all facts with source URLs
  const allEntities = graph.getAllEntities();
  let factsWithSources = 0;
  const urlToFacts = new Map<string, { entityId: string; factId: string }[]>();

  for (const entity of allEntities) {
    const facts = graph.getFacts(entity.id);
    for (const fact of facts) {
      if (fact.source && isUrl(fact.source)) {
        factsWithSources++;
        const existing = urlToFacts.get(fact.source);
        if (existing) {
          existing.push({ entityId: entity.id, factId: fact.id });
        } else {
          urlToFacts.set(fact.source, [{ entityId: entity.id, factId: fact.id }]);
        }
      }
    }
  }

  const uniqueUrls = urlToFacts.size;

  if (options.ci) {
    // Dry run: just report counts
    const data = {
      factsWithSources,
      uniqueUrls,
      urls: Array.from(urlToFacts.keys()),
    };
    return { exitCode: 0, output: JSON.stringify(data) };
  }

  const lines: string[] = [];
  lines.push(`\x1b[1mKB Source URL Sync\x1b[0m`);
  lines.push(`Facts with source URLs: ${factsWithSources}`);
  lines.push(`Unique URLs: ${uniqueUrls}`);
  lines.push('');

  let alreadyExisted = 0;
  let newlyCreated = 0;
  let errors = 0;

  for (const [url, facts] of urlToFacts) {
    // Check if resource already exists
    const lookupResult = await lookupResourceByUrl(url);
    if (lookupResult.ok) {
      alreadyExisted++;
      continue;
    }

    // If not found (404), create it. For other errors, log and skip.
    if (!lookupResult.ok && lookupResult.error !== 'bad_request') {
      // Server unavailable or timeout — log warning and skip
      console.warn(
        `Failed to look up resource for URL ${url}: ${lookupResult.message}`
      );
      errors++;
      continue;
    }

    // Create the resource
    const resourceId = `kb-${hashId(url)}`;
    let resourceType: string | null;
    try {
      resourceType = guessResourceType(url);
    } catch {
      resourceType = null;
    }

    const upsertResult = await upsertResource({
      id: resourceId,
      url,
      type: resourceType as "paper" | "blog" | "report" | "book" | "talk" | "podcast" | "government" | "reference" | "web" | null,
      title: null,
    });

    if (upsertResult.ok) {
      newlyCreated++;
      lines.push(`  \x1b[32m+\x1b[0m ${url} -> ${resourceId} (${facts.length} fact(s))`);
    } else {
      errors++;
      console.warn(
        `Failed to create resource for ${url}: ${upsertResult.message}`
      );
      lines.push(`  \x1b[31m!\x1b[0m ${url} (error: ${upsertResult.message.slice(0, 100)})`);
    }
  }

  lines.push('');
  lines.push(`\x1b[1mResults:\x1b[0m`);
  lines.push(`  Facts with sources: ${factsWithSources}`);
  lines.push(`  Unique URLs: ${uniqueUrls}`);
  lines.push(`  Already existed: ${alreadyExisted}`);
  lines.push(`  New resources created: ${newlyCreated}`);
  if (errors > 0) {
    lines.push(`  \x1b[31mErrors: ${errors}\x1b[0m`);
  }

  return { exitCode: errors > 0 && newlyCreated === 0 ? 1 : 0, output: lines.join('\n') };
}

/** Check if a string looks like a URL (starts with http:// or https://) */
function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

// ── Shared helpers for authoring commands ────────────────────────────────

/**
 * Resolve a user-provided entity argument to an Entity.
 * Tries: slug/filename lookup, stableId, case-insensitive name match.
 */
export function resolveEntityArg(arg: string, kb: LoadedKB): Entity | undefined {
  return resolveEntity(arg, kb);
}

/** Shared entity + file resolution for authoring commands. */
async function resolveEntityFile(entityArg: string): Promise<
  | { ok: true; entity: Entity; graph: Graph; filePath: string; filenameMap: Map<string, string> }
  | { ok: false; result: CommandResult }
> {
  const kb = await loadGraphFull();
  const { graph, filenameMap } = kb;

  const entity = resolveEntityArg(entityArg, kb);
  if (!entity) {
    return { ok: false, result: { exitCode: 1, output: `Entity not found: "${entityArg}"\n  Try: crux kb search ${entityArg}` } };
  }

  const slug = filenameMap.get(entity.id);
  if (!slug) {
    return { ok: false, result: { exitCode: 1, output: `Cannot find filename for entity "${entity.name}" (${entity.id})` } };
  }

  const filePath = findEntityFilePath(slug, KB_DATA_DIR);
  if (!filePath) {
    return { ok: false, result: { exitCode: 1, output: `YAML file not found for entity "${entity.name}" (slug: ${slug})` } };
  }

  return { ok: true, entity, graph, filePath, filenameMap };
}

/**
 * Coerce a string value to the appropriate type for a property.
 */
function coerceValue(raw: string, dataType: string, graph: Graph): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (dataType) {
    case 'number': {
      const num = Number(raw);
      if (isNaN(num)) {
        return { ok: false, error: `Cannot parse "${raw}" as a number` };
      }
      return { ok: true, value: num };
    }
    case 'boolean': {
      const lower = raw.toLowerCase();
      if (lower === 'true') return { ok: true, value: true };
      if (lower === 'false') return { ok: true, value: false };
      return { ok: false, error: `Cannot parse "${raw}" as a boolean (expected "true" or "false")` };
    }
    case 'date':
      return { ok: true, value: raw };
    case 'ref': {
      // Validate referenced entity exists
      const entity = graph.getEntity(raw);
      if (!entity) {
        return { ok: false, error: `Referenced entity not found: "${raw}"` };
      }
      return { ok: true, value: raw };
    }
    default:
      // text, refs, json — keep as string
      return { ok: true, value: raw };
  }
}

// ── add-fact command ────────────────────────────────────────────────────

async function addFactCommand(
  args: string[],
  options: KBCommandOptions,
): Promise<CommandResult> {
  const positionalArgs = args.filter((a) => !a.startsWith('--'));

  if (positionalArgs.length < 3) {
    return {
      exitCode: 1,
      output: `Usage: crux kb add-fact <entity> <property> <value> [--asOf=YYYY-MM] [--source=URL] [--notes=TEXT] [--currency=USD] [--force]

  Add a fact to a KB entity's YAML file.
  Detects duplicates by (property, value, asOf) and errors if a match exists.
  Use --force to skip the duplicate check.

Examples:
  crux kb add-fact anthropic revenue 5e9 --asOf=2025-06 --source=https://example.com
  crux kb add-fact dario-amodei employed-by mK9pX3rQ7n
  crux kb add-fact openai headcount 3700 --asOf=2025-01 --notes="Approximate count"`,
    };
  }

  const [entityArg, propertyArg, valueArg] = positionalArgs;

  const resolved = await resolveEntityFile(entityArg);
  if (!resolved.ok) return resolved.result;
  const { entity, graph, filePath } = resolved;

  // Validate property exists
  const property = graph.getProperty(propertyArg);
  if (!property) {
    return {
      exitCode: 1,
      output: `Property not found: "${propertyArg}"\n  Try: crux kb properties`,
    };
  }

  if (property.computed) {
    return {
      exitCode: 1,
      output: `Property "${propertyArg}" is computed and cannot have facts stored directly.`,
    };
  }

  // Coerce value
  const coerced = coerceValue(valueArg, property.dataType, graph);
  if (!coerced.ok) {
    return { exitCode: 1, output: coerced.error };
  }

  // Build fact input
  const asOf = options.asOf ?? options['as-of'];

  // Duplicate detection: check if a fact with the same (property, value, asOf) already exists.
  // Note: range-type FactValues ({ type: "range", low, high }) lack a `value` property
  // and will not be detected as duplicates. This is acceptable since range facts cannot
  // currently be added via the CLI, and no range-type facts exist in the KB data.
  if (!options.force) {
    const existingFacts = graph.getFacts(entity.id, { property: propertyArg });
    const duplicate = existingFacts.find((f) => {
      // Compare coerced value against the fact's typed value
      const fv = f.value;
      const rawVal = coerced.value;
      let valuesMatch = false;
      if ('value' in fv) {
        valuesMatch = fv.value === rawVal;
      }
      // Compare asOf (both undefined counts as a match).
      // Uses string equality — no date normalization, so "2024-01" !== "2024-01-01".
      const asOfMatch = (f.asOf ?? undefined) === (asOf ?? undefined);
      return valuesMatch && asOfMatch;
    });
    if (duplicate) {
      return {
        exitCode: 1,
        output: `Duplicate fact: property "${propertyArg}" with value ${JSON.stringify(coerced.value)} and asOf "${asOf ?? '(none)'}" already exists (fact ID: ${duplicate.id}).\nUse --force to add anyway.`,
      };
    }
  }

  const factInput: RawFactInput = {
    property: propertyArg,
    value: coerced.value,
    ...(asOf && { asOf }),
    ...(options.source && { source: String(options.source) }),
    ...(options.notes && { notes: String(options.notes) }),
    ...(options.currency && { currency: String(options.currency) }),
  };

  // Read, modify, write
  const doc = readEntityDocument(filePath);
  const factId = appendFact(doc, factInput);
  writeEntityDocument(filePath, doc);

  return {
    exitCode: 0,
    output: `Added fact ${factId} to ${entity.name} (${propertyArg}: ${valueArg})`,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────

export const commands = {
  show: showCommand,
  list: listCommand,
  lookup: lookupCommand,
  validate: validateCommand,
  properties: propertiesCommand,
  search: searchCommand,
  coverage: coverageCommand,
  fact: factCommand,
  stale: staleCommand,
  'needs-update': needsUpdateCommand,
  migrate: kbMigrateCommands.default,
  'sync-sources': syncSourcesCommand,
  verify: verifyCommand,
  'add-fact': addFactCommand,
};

export function getHelp(): string {
  return `
KB Domain -- Knowledge Base readability, authoring, and migration tools

Commands:
  show <entity-id>      Show a single entity with all data, resolving stableIds
  list [--type=X]       List all entities with name, type, stableId, and fact count
  lookup <stableId>     Look up an entity by its stableId
  validate              Run all KB validation checks
  properties [--type=X] List all property definitions with usage counts
  search <query>        Search entities by name, ID, or alias
  coverage [--type=X]   Show entity coverage against required/recommended properties
  fact <fact-id>        Show a single fact with full metadata
  stale [days]          List facts older than N days (default: 180)
  needs-update <id>     Show missing and stale data for an entity
  add-fact <entity> <property> <value>   Add a fact to an entity YAML file
  migrate <slug>        Migrate entity from old system to KB [--dry-run] [--stub-old]
  sync-sources          Sync KB fact source URLs to wiki-server as Resources
  verify                Verify KB facts against source URLs using LLM

Options:
  --type=X              Filter list/search/coverage by entity type (e.g. organization, person)
  --limit=N             Limit number of results
  --ci                  JSON output (sync-sources: dry-run, lists URLs only)
  --errors-only         Show only errors (validate)
  --rule=X              Filter by rule name (validate)
  --entity=X            (verify) Verify all facts for one entity
  --fact=X              (verify) Verify a single fact by ID
  --dry-run             (verify) Show what would be checked without calling LLM
  --asOf=YYYY-MM        (add-fact) Temporal anchor date
  --source=URL          (add-fact) Source URL
  --notes=TEXT           (add-fact) Free-text annotation
  --currency=USD         (add-fact) ISO 4217 currency code

Examples:
  crux kb show anthropic              Show Anthropic with all facts and items
  crux kb list --type=person          List only person entities
  crux kb search anthropic            Find entities matching "anthropic"
  crux kb fact f_dW5cR9mJ8q           Show fact details
  crux kb stale 90                    Facts older than 90 days
  crux kb needs-update anthropic      What's missing for Anthropic
  crux kb coverage --type=organization Organizations property coverage
  crux kb add-fact anthropic revenue 5e9 --asOf=2025-06 --source=https://example.com
  crux kb sync-sources                Sync source URLs to wiki-server resources
  crux kb verify --entity=anthropic   Verify Anthropic facts against sources
  crux kb verify --dry-run --limit=5  Preview 5 facts that would be checked
`;
}
