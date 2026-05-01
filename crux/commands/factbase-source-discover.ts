/**
 * FactBase Source-Discover CLI — QUA-926
 *
 * Stateless command that takes one fact ID and returns canonical source URL
 * candidates (with confidence scores) discovered via Anthropic's web_search
 * tool. Pure read + recommend: no YAML writes, no DB writes.
 *
 * Wraps the {@link discoverSourceForFact} engine in `crux/lib/sourcing/source-discover.ts`.
 *
 * Usage:
 *   crux fb source-discover --fact-id=f_qR5tY9wE1a
 *   crux fb source-discover --fact-id=f_qR5tY9wE1a --json
 *   crux fb source-discover --fact-id=f_qR5tY9wE1a --threshold=0.7
 *   crux fb source-discover --fact-id=f_qR5tY9wE1a --pass-existing-url
 *
 * Pieces 2/3 wrappers (QUA-933, QUA-934) call the engine library directly
 * via batch API rather than this CLI subprocess.
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { formatFactValue } from '../../packages/factbase/src/format.ts';
import type { Entity, Fact } from '../../packages/factbase/src/types.ts';
import { loadGraphFull } from '../lib/factbase-loader.ts';
import {
  discoverSourceForFact,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_DISCOVER_MODEL,
  type DiscoverResult,
} from '../lib/sourcing/source-discover.ts';

interface DiscoverOptions extends BaseOptions {
  'fact-id'?: string;
  factId?: string;
  threshold?: string;
  model?: string;
  'pass-existing-url'?: boolean;
  passExistingUrl?: boolean;
  'max-web-search-uses'?: string;
  maxWebSearchUses?: string;
  ci?: boolean;
  json?: boolean;
}

function parseThreshold(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CONFIDENCE_THRESHOLD;
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    process.stderr.write(
      `warning: ignoring --threshold=${String(raw)} (must be in [0, 1]); using ${DEFAULT_CONFIDENCE_THRESHOLD}\n`,
    );
    return DEFAULT_CONFIDENCE_THRESHOLD;
  }
  return n;
}

function parseMaxWebSearchUses(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 20) {
    process.stderr.write(
      `warning: ignoring --max-web-search-uses=${String(raw)} (must be in [1, 20]); using default\n`,
    );
    return undefined;
  }
  return n;
}

async function sourceDiscoverCommand(
  _args: string[],
  options: DiscoverOptions,
): Promise<CommandResult> {
  const isJson = Boolean(options.ci || options.json);
  const factId = (options['fact-id'] ?? options.factId)?.toString().trim();
  if (!factId) {
    const usage = `Usage: crux fb source-discover --fact-id=<id> [options]

  Find canonical source URL candidates for one FactBase fact via LLM + web search.

Options:
  --fact-id=<id>             (required) Fact ID, e.g. f_qR5tY9wE1a
  --threshold=N              Confidence threshold for "best" pick (0-1, default: ${DEFAULT_CONFIDENCE_THRESHOLD})
  --model=<id>               Override LLM model (default: ${DEFAULT_DISCOVER_MODEL})
  --max-web-search-uses=N    Max web_search invocations per call (default: 3)
  --pass-existing-url        Pass the fact's current source URL to the engine
                             so the LLM can evaluate "is it still authoritative?"
  --json / --ci              Machine-readable JSON output

Examples:
  crux fb source-discover --fact-id=f_qR5tY9wE1a
  crux fb source-discover --fact-id=f_qR5tY9wE1a --json
  crux fb source-discover --fact-id=f_qR5tY9wE1a --threshold=0.75 --pass-existing-url`;
    return isJson
      ? { exitCode: 1, output: JSON.stringify({ error: 'fact-id is required', usage }) }
      : { exitCode: 1, output: usage };
  }

  const threshold = parseThreshold(options.threshold);
  const model = options.model?.toString().trim() || undefined;
  const maxWebSearchUses = parseMaxWebSearchUses(
    options['max-web-search-uses'] ?? options.maxWebSearchUses,
  );
  const passExisting = Boolean(options['pass-existing-url'] ?? options.passExistingUrl);

  // ── Load fact ──────────────────────────────────────────────────────
  const kb = await loadGraphFull();
  const graph = kb.graph;

  let foundEntity: Entity | undefined;
  let foundFact: Fact | undefined;
  for (const entity of graph.getAllEntities()) {
    const facts = graph.getFacts(entity.id);
    const match = facts.find((f) => f.id === factId);
    if (match) {
      foundEntity = entity;
      foundFact = match;
      break;
    }
  }

  if (!foundEntity || !foundFact) {
    const msg = `Fact not found: ${factId}`;
    return isJson
      ? { exitCode: 1, output: JSON.stringify({ error: msg, factId }) }
      : { exitCode: 1, output: msg };
  }

  // Skip inverse facts — they're computed, not authored.
  if (foundFact.id.startsWith('inv_')) {
    const msg = `Cannot discover sources for inverse facts (id: ${factId}). Inverse facts derive from their primary; source the primary instead.`;
    return isJson
      ? { exitCode: 1, output: JSON.stringify({ error: msg, factId }) }
      : { exitCode: 1, output: msg };
  }

  const property = graph.getProperty(foundFact.propertyId);
  const formattedValue = formatFactValue(foundFact, property, graph);

  // ── Run engine ─────────────────────────────────────────────────────
  let result: DiscoverResult;
  try {
    result = await discoverSourceForFact(
      {
        entity: foundEntity,
        fact: foundFact,
        property,
        formattedValue,
        ...(passExisting && foundFact.source && { existingSourceUrl: foundFact.source }),
      },
      {
        threshold,
        ...(model && { model }),
        ...(maxWebSearchUses !== undefined && { maxWebSearchUses }),
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return isJson
      ? { exitCode: 1, output: JSON.stringify({ error: msg, factId }) }
      : { exitCode: 1, output: `Engine call failed: ${msg}` };
  }

  // ── Format output ──────────────────────────────────────────────────
  if (isJson) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        factId,
        entityId: foundEntity.id,
        entityName: foundEntity.name,
        propertyId: foundFact.propertyId,
        propertyName: property?.name ?? foundFact.propertyId,
        value: formattedValue,
        asOf: foundFact.asOf ?? null,
        existingSourceUrl: foundFact.source ?? null,
        threshold,
        candidates: result.candidates,
        best: result.best,
        reason: result.reason,
        costUsd: Number(result.costUsd.toFixed(4)),
      }),
    };
  }

  return { exitCode: 0, output: formatHumanReport(foundEntity, foundFact, formattedValue, result, threshold) };
}

function formatHumanReport(
  entity: Entity,
  fact: Fact,
  formattedValue: string,
  result: DiscoverResult,
  threshold: number,
): string {
  const lines: string[] = [];
  lines.push(`\x1b[1m${entity.name}\x1b[0m / ${fact.propertyId} = ${formattedValue}${fact.asOf ? ` [${fact.asOf}]` : ''}`);
  lines.push(`Fact ID:   ${fact.id}`);
  if (fact.source) lines.push(`Existing:  ${fact.source}`);
  lines.push(`Threshold: ${threshold.toFixed(2)}`);
  lines.push('');

  if (result.candidates.length === 0) {
    lines.push('\x1b[33mNo candidates discovered.\x1b[0m');
  } else {
    lines.push(`\x1b[1mCandidates (${result.candidates.length}):\x1b[0m`);
    for (const c of result.candidates) {
      const marker = c.url === result.best ? '\x1b[32m★\x1b[0m' : ' ';
      lines.push(`  ${marker} [${c.confidence.toFixed(2)}] ${c.url}`);
      if (c.summary) lines.push(`       ${c.summary}`);
    }
  }
  lines.push('');

  if (result.best) {
    lines.push(`\x1b[32mBest:\x1b[0m   ${result.best}`);
  } else {
    lines.push(`\x1b[33mBest:\x1b[0m   (none)`);
  }
  lines.push(`Reason:  ${result.reason}`);
  lines.push(`Cost:    $${result.costUsd.toFixed(4)}`);
  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: sourceDiscoverCommand,
};

export function getHelp(): string {
  return `
FactBase Source-Discover (QUA-926) — find canonical source URL(s) for one fact

Usage:
  crux fb source-discover --fact-id=<id> [options]

Options:
  --fact-id=<id>             (required) Fact ID, e.g. f_qR5tY9wE1a
  --threshold=N              Confidence threshold for "best" pick (0-1, default: ${DEFAULT_CONFIDENCE_THRESHOLD})
  --model=<id>               Override LLM model (default: ${DEFAULT_DISCOVER_MODEL})
  --max-web-search-uses=N    Max web_search invocations per call (default: 3)
  --pass-existing-url        Pass the fact's current source URL to the engine for
                             "is it still authoritative?" evaluation (used by Piece 3)
  --json / --ci              Machine-readable JSON output

Returns:
  { candidates: [{ url, confidence, summary }, ...], best: <url>|null, reason: <text> }

Engine is exported as a library (crux/lib/sourcing/source-discover.ts) — Pieces 2/3
wrappers (QUA-933, QUA-934) call it directly via the Anthropic Batch API rather
than this CLI subprocess.
`.trim();
}

// Test-only re-exports for unit testing the option parsers.
export const __test_only__ = {
  parseThreshold,
  parseMaxWebSearchUses,
};
