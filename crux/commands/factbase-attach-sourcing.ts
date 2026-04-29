/**
 * FactBase Attach-Sourcing — QUA-850 (Phase A of QUA-729)
 *
 * Reads sourcing verdicts from the wiki-server's `source_check_verdicts`
 * table and writes them back into the corresponding FactBase YAML files as
 * inline `sourcing:` blocks on each fact.
 *
 * Why: a verdict in PG is a runtime artifact — when the YAML is the
 * authoritative source and gets re-synced, any verdict that wasn't represented
 * in YAML is recomputed (and risks drifting). Persisting the verdict back to
 * YAML lets the round-trip be a no-op.
 *
 * Phase A only writes the data; Phase C will flip enforcement so writes
 * without sourcing are rejected. Until then, this is purely additive.
 *
 * Usage:
 *   crux fb attach-sourcing                       # backfill all entities
 *   crux fb attach-sourcing --entity=anthropic    # one entity (slug/id/stableId)
 *   crux fb attach-sourcing --fact=f_abc123       # one fact across the KB
 *   crux fb attach-sourcing --dry-run             # preview only (default)
 *   crux fb attach-sourcing --apply               # write to YAML
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import type { Entity, Fact } from '../../packages/factbase/src/types.ts';
import { loadKB } from '../../packages/factbase/src/loader.ts';
import { computeInverses } from '../../packages/factbase/src/inverse.ts';
import {
  buildTableBaseEntityMap,
  resolveEntity,
  KB_DATA_DIR,
} from '../lib/factbase-loader.ts';
import type { LoadedKB } from '../lib/factbase-loader.ts';
import {
  readEntityDocument,
  writeEntityDocument,
  setFactSourcing,
  findEntityFilePath,
} from '../lib/factbase-writer.ts';
import { fetchInlineSourcing, type InlineSourcing } from '../lib/wiki-server/inline-sourcing.ts';

// ── Options ──────────────────────────────────────────────────────────

export interface AttachSourcingOptions extends BaseOptions {
  entity?: string;
  fact?: string;
  apply?: boolean;
  'dry-run'?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** Override the KB data dir. Production CLI never sets this; tests do. */
  dataDir?: string;
}

// ── Internal types ───────────────────────────────────────────────────

interface PerEntityResult {
  entityId: string;
  filename: string;
  /** Number of facts with verdicts that were already up-to-date (no diff). */
  unchanged: number;
  /** Number of facts where the YAML sourcing block was written (or would be on apply). */
  toWrite: number;
  /** Number of facts the planner couldn't find in the YAML (logged but non-fatal). */
  notFound: number;
}

interface Summary {
  /** Entities scanned (in scope after filters). */
  entitiesScanned: number;
  /** Total facts examined. */
  factsScanned: number;
  /** Facts with a verdict in PG matched to YAML. */
  factsMatched: number;
  /** Facts that already had matching sourcing in YAML (idempotent no-op). */
  unchanged: number;
  /** Facts where sourcing was/would be written. */
  toWrite: number;
  /** Verdicts in PG with no matching YAML fact (logged). */
  orphans: number;
  /** Whether --apply was passed (otherwise dry-run). */
  applied: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Strip `undefined` keys so the YAML serializer doesn't emit `key: null`. */
function compactSourcing(s: InlineSourcing): Record<string, unknown> {
  const out: Record<string, unknown> = { verdict: s.verdict };
  if (s.evidence !== undefined) out.evidence = s.evidence;
  if (s.confidence !== undefined) out.confidence = s.confidence;
  if (s.sourceContentHash !== undefined) out.sourceContentHash = s.sourceContentHash;
  if (s.checkedAt !== undefined) out.checkedAt = s.checkedAt;
  if (s.checkedBy !== undefined) out.checkedBy = s.checkedBy;
  return out;
}

/** Pick the in-scope entities for this run, applying --entity/--fact filters. */
function collectEntitiesInScope(
  kb: LoadedKB,
  options: AttachSourcingOptions,
): Entity[] {
  if (options.entity) {
    const e = resolveEntity(options.entity, kb);
    if (!e) {
      throw new Error(`Entity not found: ${options.entity}`);
    }
    return [e];
  }
  // --fact alone: walk all entities to find the one that owns the fact.
  if (options.fact) {
    for (const e of kb.graph.getAllEntities()) {
      if (kb.graph.getFacts(e.id).some((f: Fact) => f.id === options.fact)) {
        return [e];
      }
    }
    return [];
  }
  return kb.graph.getAllEntities();
}

/**
 * Apply attach for a single entity. Returns per-entity stats. When
 * `apply` is false, the YAML is not modified — we only count what would
 * change.
 */
function attachForEntity(
  entity: Entity,
  kb: LoadedKB,
  verdicts: Map<string, InlineSourcing>,
  factFilter: string | undefined,
  apply: boolean,
  dataDir: string,
): PerEntityResult {
  const filename = kb.filenameMap.get(entity.id) ?? entity.id;
  const result: PerEntityResult = {
    entityId: entity.id,
    filename,
    unchanged: 0,
    toWrite: 0,
    notFound: 0,
  };

  const facts = kb.graph
    .getFacts(entity.id)
    .filter((f: Fact) => !f.id.startsWith('inv_'))
    .filter((f: Fact) => (factFilter ? f.id === factFilter : true));

  if (facts.length === 0) return result;

  // Plan all writes against the in-memory graph first, then open the
  // Document only if there's at least one write/diff to apply (avoids
  // touching files that have no verdicts at all).
  const plans: Array<{ factId: string; sourcing: Record<string, unknown> }> = [];
  for (const fact of facts) {
    const v = verdicts.get(fact.id);
    if (!v) continue;
    const sourcing = compactSourcing(v);
    plans.push({ factId: fact.id, sourcing });
  }

  if (plans.length === 0) return result;

  const filePath = findEntityFilePath(filename, dataDir);
  if (!filePath) {
    // Entity is in the graph but not on disk under its filename — this is
    // surprising but not fatal (e.g. a per-entity directory restructure).
    // Treat all verdict writes as not-found so the operator can investigate.
    result.notFound = plans.length;
    return result;
  }

  const doc = readEntityDocument(filePath);
  let docChanged = false;
  for (const plan of plans) {
    const status = setFactSourcing(doc, plan.factId, plan.sourcing);
    if (status === 'updated') {
      result.toWrite++;
      docChanged = true;
    } else if (status === 'unchanged') {
      result.unchanged++;
    } else {
      result.notFound++;
    }
  }

  if (apply && docChanged) {
    writeEntityDocument(filePath, doc);
  }

  return result;
}

// ── Main command ─────────────────────────────────────────────────────

export async function attachSourcingCommand(
  _args: string[] = [],
  options: AttachSourcingOptions = {},
): Promise<CommandResult> {
  // --apply takes precedence; without it we default to dry-run for safety.
  // Use `Boolean()` rather than `=== true` because the CLI parser may surface
  // the flag as the string "true" or as a boolean depending on how the user
  // wrote it on the command line.
  const apply = Boolean(options.apply);

  // dataDir is an option for tests — production runs against the real KB.
  const dataDir = options.dataDir ?? KB_DATA_DIR;

  // Load the KB graph from `dataDir`. Inlined here (rather than calling
  // `loadGraphFull`) so the data dir is configurable per-call without
  // monkey-patching the loader module.
  const tablebaseEntities = buildTableBaseEntityMap();
  const { graph, filenameMap } = await loadKB(dataDir, {
    entities: tablebaseEntities,
  });
  computeInverses(graph);
  const idByFilename = new Map<string, string>();
  for (const [entityId, filename] of filenameMap) {
    idByFilename.set(filename, entityId);
  }
  const kb: LoadedKB = { graph, filenameMap, idByFilename };

  // Scope filter — figure out which entities (and optionally which fact)
  // are in play before fetching anything from PG.
  const entities = collectEntitiesInScope(kb, options);
  const factFilter = options.fact ?? undefined;

  // Pull verdicts from the wiki-server. fetchInlineSourcing already handles
  // pagination, filters out per-field verdicts (fieldName !== null) and the
  // `unchecked` value that InlineSourcingSchema rejects.
  const verdicts = await fetchInlineSourcing('fact');

  const summary: Summary = {
    entitiesScanned: entities.length,
    factsScanned: 0,
    factsMatched: 0,
    unchanged: 0,
    toWrite: 0,
    orphans: 0,
    applied: apply,
  };
  const perEntity: PerEntityResult[] = [];

  // Track which verdicts we matched so we can count orphans (PG rows with
  // no live YAML fact). Orphans usually mean the YAML was deleted/renamed
  // without a corresponding sourcing cleanup.
  const matchedFactIds = new Set<string>();

  for (const entity of entities) {
    const facts = kb.graph
      .getFacts(entity.id)
      .filter((f: Fact) => !f.id.startsWith('inv_'))
      .filter((f: Fact) => (factFilter ? f.id === factFilter : true));
    summary.factsScanned += facts.length;

    for (const fact of facts) {
      if (verdicts.has(fact.id)) {
        matchedFactIds.add(fact.id);
        summary.factsMatched++;
      }
    }

    const r = attachForEntity(entity, kb, verdicts, factFilter, apply, dataDir);
    summary.unchanged += r.unchanged;
    summary.toWrite += r.toWrite;
    perEntity.push(r);
  }

  // When the user scoped to a single entity/fact, "orphans" doesn't make
  // sense globally — only count when scanning the full KB.
  if (!options.entity && !options.fact) {
    for (const factId of verdicts.keys()) {
      if (!matchedFactIds.has(factId)) summary.orphans++;
    }
  }

  if (options.json) {
    return {
      exitCode: 0,
      output: JSON.stringify({ summary, entities: perEntity.filter((e) => e.toWrite + e.unchanged + e.notFound > 0) }, null, 2),
    };
  }

  return {
    exitCode: 0,
    output: formatReport(summary, perEntity, apply),
  };
}

function formatReport(
  summary: Summary,
  perEntity: PerEntityResult[],
  apply: boolean,
): string {
  const lines: string[] = [];
  const verb = apply ? 'wrote' : 'would write';
  lines.push(`FactBase attach-sourcing — ${apply ? 'apply' : 'dry-run'}`);
  lines.push('');
  lines.push(`  Entities scanned:  ${summary.entitiesScanned}`);
  lines.push(`  Facts scanned:     ${summary.factsScanned}`);
  lines.push(`  Verdicts matched:  ${summary.factsMatched}`);
  lines.push(`  Unchanged:         ${summary.unchanged}`);
  lines.push(`  ${verb}:    ${summary.toWrite}`);
  if (summary.orphans > 0) {
    lines.push(`  Orphan verdicts:   ${summary.orphans}  (PG row with no live YAML fact)`);
  }
  lines.push('');

  const interesting = perEntity.filter((e) => e.toWrite > 0 || e.notFound > 0);
  if (interesting.length > 0 && interesting.length <= 30) {
    lines.push('Per-entity:');
    for (const e of interesting) {
      const parts: string[] = [];
      if (e.toWrite > 0) parts.push(`${verb} ${e.toWrite}`);
      if (e.unchanged > 0) parts.push(`${e.unchanged} already in sync`);
      if (e.notFound > 0) parts.push(`${e.notFound} not-found`);
      lines.push(`  ${e.filename.padEnd(40)}  ${parts.join(', ')}`);
    }
    lines.push('');
  }

  if (!apply && summary.toWrite > 0) {
    lines.push('\x1b[2mRe-run with --apply to write the sourcing blocks back to YAML.\x1b[0m');
  } else if (apply && summary.toWrite > 0) {
    lines.push(
      '\x1b[2mNext: re-run `pnpm crux wiki-server sync-facts` to confirm the round-trip is a no-op.\x1b[0m',
    );
  }

  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: attachSourcingCommand,
};

export function getHelp(): string {
  return `
FactBase Attach-Sourcing — round-trip PG verdicts back into YAML

Usage:
  crux fb attach-sourcing [options]

Options:
  --entity=X    Limit to one entity (slug, stableId, or name)
  --fact=X      Limit to one fact ID
  --apply       Write changes to YAML (default: dry-run)
  --json        Machine-readable JSON output

Output (default):
  Human-readable summary of how many verdicts matched, are already up to date,
  and would be (or were) written to YAML. With --apply, files are written
  atomically (write-and-rename).

Idempotency:
  A second run with the same PG state and the same YAML state should report
  zero writes. After running with --apply, re-run \`crux wiki-server sync-facts\`
  to confirm PG state matches YAML state (no upserts to verdicts).
`;
}
