/**
 * FactBase Source-Backfill — QUA-545
 *
 * Finds FactBase facts that have no `source` URL, runs web-search against the
 * claim, and (optionally) writes the top candidate URL back to YAML.
 *
 * Workflow:
 *   1. Load the FactBase graph.
 *   2. Collect facts where `!fact.source`, skipping:
 *        - inverse facts (`id` starts with `inv_`)
 *        - properties with `verifiable: false` (website, wikipedia-url, etc.)
 *        - the `description` property by default (no single-URL source applies)
 *      Apply --entity / --property / --limit filters.
 *   3. Per fact: call suggestUrls(entityName, claimText, fieldName) → candidates.
 *   4. Dry-run (default): print a per-entity report with candidates.
 *      --apply: write top candidate to YAML and tag the fact with
 *               notes="[auto-suggested by qua-545] <generator-model>".
 *
 * Safety:
 *   - --apply never overwrites an existing source (updateFactMetaById no-ops
 *     when `source` is already set).
 *   - --budget caps total Perplexity spend.
 *   - --limit caps facts processed.
 *   - --dry-run is the default; --apply requires an explicit flag.
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { formatFactValue } from '../../packages/factbase/src/format.ts';
import type { Entity, Fact } from '../../packages/factbase/src/types.ts';
import { loadGraphFull, resolveEntity, KB_DATA_DIR } from '../lib/factbase-loader.ts';
import type { LoadedKB } from '../lib/factbase-loader.ts';
import {
  readEntityDocument,
  writeEntityDocument,
  updateFactMetaById,
  findEntityFilePath,
} from '../lib/factbase-writer.ts';
import { suggestUrls, GENERATOR_MODEL } from '../lib/sourcing/suggest-urls.ts';

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 2000;
const DEFAULT_BUDGET_USD = 2.0;
const DEFAULT_MAX_CANDIDATES = 3;
const MAX_CANDIDATES_PER_FACT = 5;
const DEFAULT_CONCURRENCY = 5;

// Properties we skip by default even without verifiable:false, because their
// value is editorial free-text and no single source URL meaningfully supports
// them. `description` dominates the unsourced set (~58%); the rest are
// opinion/editorial fields. Override with --include-property=description.
const EDITORIAL_PROPERTIES = new Set<string>([
  'description',
  'notable-for',
]);

// ── Types ────────────────────────────────────────────────────────────

export interface BackfillOptions extends BaseOptions {
  entity?: string;
  property?: string;
  'include-property'?: string;
  includeProperty?: string;
  limit?: string;
  budget?: string;
  'max-candidates'?: string;
  maxCandidates?: string;
  apply?: boolean;
  'dry-run'?: boolean;
  dryRun?: boolean;
  'include-editorial'?: boolean;
  includeEditorial?: boolean;
  'include-non-verifiable'?: boolean;
  includeNonVerifiable?: boolean;
  ci?: boolean;
  json?: boolean;
}

interface Candidate {
  url: string;
  title: string;
  snippet: string | null;
  provider: string;
}

interface FactWithCandidates {
  entity: Entity;
  fact: Fact;
  propertyName: string;
  formattedValue: string;
  candidates: Candidate[];
  searchQuery: string;
  costUsd: number;
  providerErrors: string[];
}

interface Summary {
  scanned: number;
  candidatesFound: number;
  noCandidates: number;
  writesAttempted: number;
  writesSucceeded: number;
  writesSkippedExisting: number;
  costUsd: number;
  budgetExhausted: boolean;
  providerErrors: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseBoundedInt(
  raw: unknown,
  fallback: number,
  max: number,
  flag: string,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`warning: ignoring --${flag}=${raw} (expected positive integer)\n`);
    return fallback;
  }
  return Math.min(n, max);
}

function parsePositiveFloat(raw: unknown, fallback: number, flag: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`warning: ignoring --${flag}=${raw} (expected positive number)\n`);
    return fallback;
  }
  return n;
}

/**
 * Collect facts that need a source URL. Exported for unit testing.
 */
export function collectUnsourcedFacts(
  kb: LoadedKB,
  options: {
    entity?: string;
    property?: string;
    includeProperty?: string;
    includeEditorial?: boolean;
    includeNonVerifiable?: boolean;
    limit?: number;
  },
): Array<{ entity: Entity; fact: Fact }> {
  const graph = kb.graph;

  const editorialAllowList = new Set<string>();
  if (options.includeProperty) {
    for (const p of options.includeProperty.split(',').map((s) => s.trim())) {
      if (p) editorialAllowList.add(p);
    }
  }

  const scanEntities: Entity[] = options.entity
    ? (() => {
        const resolved = resolveEntity(options.entity, kb);
        return resolved ? [resolved] : [];
      })()
    : graph.getAllEntities();

  const out: Array<{ entity: Entity; fact: Fact }> = [];

  for (const entity of scanEntities) {
    const facts = graph.getFacts(entity.id);
    for (const fact of facts) {
      if (fact.id.startsWith('inv_')) continue;
      if (fact.source) continue;

      if (options.property && fact.propertyId !== options.property) continue;

      const property = graph.getProperty(fact.propertyId);

      // Non-verifiable properties (website, wikipedia-url, etc.) don't need a
      // source URL — skip unless the caller explicitly opts in.
      if (property?.verifiable === false && !options.includeNonVerifiable) continue;

      // Editorial free-text properties (description, notable-for) default to
      // skipped, but --include-editorial or --include-property=<id> overrides.
      if (
        EDITORIAL_PROPERTIES.has(fact.propertyId) &&
        !options.includeEditorial &&
        !editorialAllowList.has(fact.propertyId)
      ) {
        continue;
      }

      out.push({ entity, fact });
      if (options.limit && out.length >= options.limit) return out;
    }
  }

  return out;
}

/**
 * Build the claim-text fragment we hand to the URL suggester. Matches the
 * shape factbase-sourcing.ts uses so the search queries are consistent.
 */
export function buildClaimText(
  entity: Entity,
  fact: Fact,
  propertyName: string,
  formattedValue: string,
): string {
  const asOfStr = fact.asOf ? ` (as of ${fact.asOf})` : '';
  return `${entity.name}'s ${propertyName} = ${formattedValue}${asOfStr}`;
}

/**
 * Minimal concurrency pool (copy of the one in sourcing-suggest-urls.ts —
 * worth consolidating in a follow-up, but not part of this PR's scope).
 */
async function runWithConcurrency<T>(
  concurrency: number,
  tasks: Array<() => Promise<T>>,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── Main command ────────────────────────────────────────────────────

async function backfillCommand(
  _args: string[],
  options: BackfillOptions,
): Promise<CommandResult> {
  const limit = parseBoundedInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT, 'limit');
  const budget = parsePositiveFloat(options.budget, DEFAULT_BUDGET_USD, 'budget');
  const maxCandidates = parseBoundedInt(
    options['max-candidates'] ?? options.maxCandidates,
    DEFAULT_MAX_CANDIDATES,
    MAX_CANDIDATES_PER_FACT,
    'max-candidates',
  );
  const apply = Boolean(options.apply);
  const dryRun = !apply;
  const includeEditorial = Boolean(
    options['include-editorial'] ?? options.includeEditorial,
  );
  const includeNonVerifiable = Boolean(
    options['include-non-verifiable'] ?? options.includeNonVerifiable,
  );
  const includeProperty =
    (options['include-property'] as string | undefined) ??
    (options.includeProperty as string | undefined);
  const entityFilter = options.entity?.trim() || undefined;
  const propertyFilter = options.property?.trim() || undefined;
  const isJson = Boolean(options.ci || options.json);

  const log = (msg: string) => { if (!isJson) console.log(msg); };

  const kb = await loadGraphFull();
  const graph = kb.graph;

  const facts = collectUnsourcedFacts(kb, {
    entity: entityFilter,
    property: propertyFilter,
    includeProperty,
    includeEditorial,
    includeNonVerifiable,
    limit,
  });

  log(`FactBase source-backfill (QUA-545)`);
  log(`  mode:           ${apply ? 'APPLY' : 'dry-run'}`);
  log(`  limit:          ${limit}`);
  log(`  budget:         $${budget.toFixed(2)}`);
  log(`  max-candidates: ${maxCandidates}`);
  if (entityFilter) log(`  entity:         ${entityFilter}`);
  if (propertyFilter) log(`  property:       ${propertyFilter}`);
  if (includeEditorial) log(`  include-editorial: yes`);
  if (includeNonVerifiable) log(`  include-non-verifiable: yes`);
  log(`  facts to process: ${facts.length}`);
  log('');

  if (facts.length === 0) {
    const output = isJson
      ? JSON.stringify({ summary: zeroSummary(), results: [] })
      : 'No unsourced facts match the given filters.';
    return { exitCode: 0, output };
  }

  const summary: Summary = zeroSummary();
  const results: FactWithCandidates[] = [];

  const tasks = facts.map(({ entity, fact }) => async () => {
    summary.scanned++;

    // Budget gate (pending tasks short-circuit once tripped; in-flight finish).
    if (summary.costUsd >= budget) {
      if (!summary.budgetExhausted) {
        summary.budgetExhausted = true;
        log(`Budget reached ($${summary.costUsd.toFixed(4)} >= $${budget.toFixed(2)}); stopping new work.`);
      }
      return;
    }

    const property = graph.getProperty(fact.propertyId);
    const propertyName = property?.name ?? fact.propertyId;
    const formattedValue = formatFactValue(fact, property, graph);
    const claimText = buildClaimText(entity, fact, propertyName, formattedValue);

    const res = await suggestUrls({
      entityName: entity.name,
      claimText,
      fieldName: fact.propertyId,
      existingUrl: null,
      maxCandidates,
    });
    summary.costUsd += res.costUsd;
    for (const p of res.providersSkipped) {
      if (!p.endsWith(':no-key')) summary.providerErrors++;
    }

    const candidates: Candidate[] = res.candidates.map((c) => ({
      url: c.url,
      title: c.title,
      snippet: c.snippet,
      provider: c.sourceProvider,
    }));

    if (candidates.length > 0) summary.candidatesFound++;
    else summary.noCandidates++;

    results.push({
      entity,
      fact,
      propertyName,
      formattedValue,
      candidates,
      searchQuery: res.query,
      costUsd: res.costUsd,
      providerErrors: res.providersSkipped.filter((p) => !p.endsWith(':no-key')),
    });
  });

  await runWithConcurrency(DEFAULT_CONCURRENCY, tasks);

  if (apply && results.length > 0) {
    applyCandidatesToYaml(results, kb, summary, log);
  }

  if (isJson) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        summary: summaryToJson(summary, apply),
        results: results.map((r) => ({
          entityId: r.entity.id,
          entityName: r.entity.name,
          factId: r.fact.id,
          propertyId: r.fact.propertyId,
          propertyName: r.propertyName,
          value: r.formattedValue,
          asOf: r.fact.asOf ?? null,
          candidates: r.candidates,
          searchQuery: r.searchQuery,
          costUsd: Number(r.costUsd.toFixed(4)),
          providerErrors: r.providerErrors,
        })),
      }),
    };
  }

  return { exitCode: 0, output: formatReport(results, summary, apply) };
}

function zeroSummary(): Summary {
  return {
    scanned: 0,
    candidatesFound: 0,
    noCandidates: 0,
    writesAttempted: 0,
    writesSucceeded: 0,
    writesSkippedExisting: 0,
    costUsd: 0,
    budgetExhausted: false,
    providerErrors: 0,
  };
}

function summaryToJson(s: Summary, apply: boolean) {
  return {
    scanned: s.scanned,
    candidates_found: s.candidatesFound,
    no_candidates: s.noCandidates,
    writes_attempted: s.writesAttempted,
    writes_succeeded: s.writesSucceeded,
    writes_skipped_existing: s.writesSkippedExisting,
    cost_usd: Number(s.costUsd.toFixed(4)),
    budget_exhausted: s.budgetExhausted,
    provider_errors: s.providerErrors,
    apply,
  };
}

/**
 * Write top candidate per fact to its YAML entity file.
 * Batched per-entity so we read+write each file at most once.
 *
 * Never overwrites an existing `source` — `updateFactMetaById` no-ops in that
 * case and we count it as `writesSkippedExisting`. This protects against a
 * race where a human added a source URL between `collectUnsourcedFacts()` and
 * the apply phase.
 */
function applyCandidatesToYaml(
  results: FactWithCandidates[],
  kb: LoadedKB,
  summary: Summary,
  log: (msg: string) => void,
): void {
  // Group by entity id → list of (factId, url)
  const byEntity = new Map<string, Array<{ factId: string; url: string }>>();
  for (const r of results) {
    if (r.candidates.length === 0) continue;
    const top = r.candidates[0];
    const existing = byEntity.get(r.entity.id);
    if (existing) existing.push({ factId: r.fact.id, url: top.url });
    else byEntity.set(r.entity.id, [{ factId: r.fact.id, url: top.url }]);
  }

  for (const [entityId, updates] of byEntity) {
    summary.writesAttempted += updates.length;
    const slug = kb.filenameMap.get(entityId);
    if (!slug) {
      log(`  [warn] no filename for entity ${entityId} — skipping ${updates.length} write(s)`);
      continue;
    }
    const filepath = findEntityFilePath(slug, KB_DATA_DIR);
    if (!filepath) {
      log(`  [warn] YAML file not found for ${slug} — skipping ${updates.length} write(s)`);
      continue;
    }

    try {
      const doc = readEntityDocument(filepath);
      let changed = 0;
      let skippedExisting = 0;
      let notFound = 0;
      for (const { factId, url } of updates) {
        const status = updateFactMetaById(doc, factId, {
          source: url,
          notes: `[auto-suggested by ${GENERATOR_MODEL}]`,
        });
        if (status === 'updated') changed++;
        else if (status === 'skipped-existing') skippedExisting++;
        else notFound++;
      }
      if (changed > 0) writeEntityDocument(filepath, doc);
      summary.writesSucceeded += changed;
      summary.writesSkippedExisting += skippedExisting;
      if (notFound > 0) {
        log(`  [warn] ${notFound} fact(s) in ${slug} not found in YAML (graph/YAML drift?)`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  [error] write failed for ${slug}: ${msg}`);
    }
  }
}

function formatReport(
  results: FactWithCandidates[],
  summary: Summary,
  apply: boolean,
): string {
  const lines: string[] = [];

  // Group by entity
  const byEntity = new Map<string, FactWithCandidates[]>();
  for (const r of results) {
    const existing = byEntity.get(r.entity.id);
    if (existing) existing.push(r);
    else byEntity.set(r.entity.id, [r]);
  }

  for (const [, entries] of byEntity) {
    const entity = entries[0].entity;
    lines.push(`\x1b[1m${entity.name}\x1b[0m (${entity.id}) — ${entries.length} unsourced fact(s)`);
    for (const r of entries) {
      const asOf = r.fact.asOf ? ` [${r.fact.asOf}]` : '';
      lines.push(`  ${r.propertyName}: ${r.formattedValue}${asOf}  (${r.fact.id})`);
      if (r.candidates.length === 0) {
        lines.push(`    \x1b[33m(no candidates)\x1b[0m`);
      } else {
        for (const c of r.candidates) {
          lines.push(`    → ${c.url}`);
          if (c.title) lines.push(`      ${c.title.slice(0, 100)}`);
        }
      }
    }
    lines.push('');
  }

  lines.push('=== Summary ===');
  lines.push(`Scanned:              ${summary.scanned}`);
  lines.push(`Candidates found:     ${summary.candidatesFound}`);
  lines.push(`No candidates:        ${summary.noCandidates}`);
  if (apply) {
    lines.push(`Writes attempted:     ${summary.writesAttempted}`);
    lines.push(`Writes succeeded:     ${summary.writesSucceeded}`);
    lines.push(`Skipped (had source): ${summary.writesSkippedExisting}`);
  }
  lines.push(`Cost:                 $${summary.costUsd.toFixed(4)}`);
  lines.push(`Budget exhausted:     ${summary.budgetExhausted ? 'yes' : 'no'}`);
  lines.push(`Provider errors:      ${summary.providerErrors}`);
  lines.push('');
  if (!apply) {
    lines.push('\x1b[2mRun with --apply to write top candidate per fact back to YAML.\x1b[0m');
  }
  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: backfillCommand,
};

export function getHelp(): string {
  return `
FactBase Source-Backfill — suggest (and optionally apply) source URLs for unsourced facts

Usage:
  crux fb source-backfill [options]

Options:
  --entity=X                 Limit to a single entity (slug, stableId, or name)
  --property=X               Limit to a single property ID (e.g. headcount, founded-date)
  --include-property=X,Y     Also scan editorial properties normally skipped (e.g. description, notable-for)
  --include-editorial        Scan ALL editorial properties (description, notable-for)
  --include-non-verifiable   Include properties with verifiable:false (website, wikipedia-url, etc.)
  --limit=N                  Max facts to process (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})
  --budget=N                 Soft cap in USD on provider spend (default: $${DEFAULT_BUDGET_USD.toFixed(2)}).
  --max-candidates=N         Candidates per fact (default: ${DEFAULT_MAX_CANDIDATES}, max: ${MAX_CANDIDATES_PER_FACT})
  --apply                    Write top candidate URL back to YAML (default: dry-run)
  --ci / --json              Machine-readable JSON output

Behavior:
  1. Loads the FactBase graph.
  2. Collects facts with no \`source\` URL, skipping inverse facts, properties
     with \`verifiable: false\`, and editorial free-text properties (description,
     notable-for).
  3. For each, runs web search (Exa + Perplexity) against the claim text.
  4. In dry-run (default), prints a per-entity report of candidates.
  5. With --apply, writes the TOP candidate URL to YAML and annotates the fact
     with notes="[auto-suggested by <model>]". Never overwrites an existing source.

Requires EXA_API_KEY and/or OPENROUTER_API_KEY. Missing keys degrade gracefully.
`.trim();
}
