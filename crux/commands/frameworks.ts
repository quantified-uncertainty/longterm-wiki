/**
 * Frontier-safety-framework subcommands — `crux tb frameworks ...` (QUA-691).
 *
 * Subcommands:
 *   extract <url>  --framework=<sid> --version=<label>
 *                  [--apply]           POST thresholds to wiki-server /sync
 *                  [--model=sonnet]    LLM model override
 *                  [--json]            raw JSON output
 *                  [--max-chars=N]     cap source length (default 120k)
 *
 *   diff <fromVersionId> <toVersionId>
 *                  [--apply]           POST diff + items to wiki-server /sync
 *                  [--skip-classifier] skip LLM classifier pass
 *                  [--json]            raw JSON output
 *
 *   fetch <url>    [--skip-wayback]    download + hash + Wayback push
 *                  [--json]            raw JSON output
 *
 * The command wiring is minimal — it exists so agents can ingest a
 * framework end-to-end from the CLI during Phase 4 development. Scheduled
 * re-fetches live in `crux/scripts/refresh-frameworks.ts` (follow-up PR).
 */

import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import { generateId } from '../lib/grant-import/id.ts';
import {
  extractFrameworkThresholds,
  EXTRACTOR_VERSION,
  type ExtractResult,
  type ExtractedThreshold,
} from '../frameworks/extract.ts';
import {
  diffFrameworkVersions,
  structuralDiff,
  aggregateDiff,
  type DiffAggregate,
  type DiffItem,
} from '../frameworks/diff.ts';
import { fetchFramework } from '../frameworks/fetch.ts';
import { MODELS } from '../lib/anthropic.ts';
import { createLogger } from '../lib/output.ts';

interface FrameworkOptions extends CommandOptions {
  url?: string;
  framework?: string;
  version?: string;
  fromVersion?: string;
  toVersion?: string;
  model?: string;
  apply?: boolean;
  json?: boolean;
  skipWayback?: boolean;
  skipClassifier?: boolean;
  maxChars?: string;
}

function resolveLlmModel(name?: string): string {
  if (!name) return MODELS.sonnet;
  const lower = name.toLowerCase();
  if (lower === 'haiku') return MODELS.haiku;
  if (lower === 'sonnet') return MODELS.sonnet;
  if (lower === 'opus') return MODELS.opus;
  return name;
}

/**
 * Build sync-item payloads for `/api/framework-capability-thresholds/sync`
 * from an extract result. Each row gets a deterministic `id` so re-runs
 * upsert cleanly.
 */
export function toThresholdSyncItems(
  versionId: string,
  thresholds: ExtractedThreshold[],
  meta: { extractionModel: string },
): Array<Record<string, unknown>> {
  return thresholds.map((t) => ({
    id: generateId(
      `framework-threshold:${versionId}:${t.riskDomainCanonical}:${t.tierSortOrder}`,
    ),
    versionId,
    riskDomainCanonical: t.riskDomainCanonical,
    riskDomainLabel: t.riskDomainLabel,
    tierLabel: t.tierLabel,
    tierSortOrder: t.tierSortOrder,
    triggerDescription: t.triggerDescription,
    sourceQuote: t.sourceQuote,
    sourcePageHint: t.sourcePageHint,
    requiredMitigations: t.requiredMitigations,
    associatedEvals: t.associatedEvals,
    commitmentLanguage: t.commitmentLanguage,
    extractedByModel: meta.extractionModel,
    extractionConfidence: t.extractionConfidence,
    humanReviewed: false,
    humanReviewNotes: null,
  }));
}

/**
 * Build the `framework_diffs` + `framework_diff_items` sync payloads.
 */
export function toDiffSyncPayloads(
  fromVersionId: string,
  toVersionId: string,
  aggregate: DiffAggregate,
  meta: { classifiedByModel: string | null },
): {
  diff: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
} {
  const diffId = generateId(`framework-diff:${fromVersionId}:${toVersionId}`);
  return {
    diff: {
      id: diffId,
      fromVersionId,
      toVersionId,
      changeSummary: aggregate.changeSummary,
      weakeningFlagged: aggregate.weakeningFlagged,
      strengtheningFlagged: aggregate.strengtheningFlagged,
      neutralChangesCount: aggregate.neutralChangesCount,
      diffDetails: { itemCount: aggregate.items.length },
      overallDirection: aggregate.overallDirection,
      humanReviewed: false,
      reviewVerdict: 'unreviewed',
      reviewNotes: null,
      classifiedByModel: meta.classifiedByModel,
    },
    items: aggregate.items.map((item: DiffItem, idx: number) => ({
      id: generateId(
        `framework-diff-item:${diffId}:${idx}:${item.changeType}:${item.riskDomainCanonical ?? 'none'}`,
      ),
      diffId,
      changeType: item.changeType,
      riskDomainCanonical: item.riskDomainCanonical,
      beforeSnapshot: item.beforeSnapshot
        ? (item.beforeSnapshot as unknown as Record<string, unknown>)
        : null,
      afterSnapshot: item.afterSnapshot
        ? (item.afterSnapshot as unknown as Record<string, unknown>)
        : null,
      severity: item.severity,
      classifierTag: item.classifierTag,
      rationale: item.rationale,
    })),
  };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function extractCommand(opts: FrameworkOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(opts.ci));

  const args = (opts as { args?: unknown[] }).args;
  const positional = Array.isArray(args) && typeof args[0] === 'string' ? (args[0] as string) : undefined;
  const url = opts.url ?? positional;
  if (!url) {
    log.error(
      'Usage: crux tb frameworks extract <url> --framework=<sid> --version=<label> [--apply] [--json]',
    );
    return { output: '', exitCode: 1 };
  }
  if (!opts.framework) {
    log.error('--framework=<stableId> is required');
    return { output: '', exitCode: 1 };
  }
  if (!opts.version) {
    log.error('--version=<versionLabel> is required (e.g. "v3.1", "v2 draft")');
    return { output: '', exitCode: 1 };
  }

  const maxSourceChars = opts.maxChars
    ? Math.max(2000, parseInt(opts.maxChars, 10))
    : undefined;

  const extract: ExtractResult = await extractFrameworkThresholds({
    url,
    llmModel: resolveLlmModel(opts.model),
    maxSourceChars,
  });

  // Deterministic version id so --apply is idempotent.
  const versionId = generateId(`framework-version:${opts.framework}:${opts.version}:${extract.sourceHash}`);

  if (opts.json) {
    const output = {
      url,
      frameworkId: opts.framework,
      versionLabel: opts.version,
      versionId,
      extractorVersion: EXTRACTOR_VERSION,
      sourceFormat: extract.sourceFormat,
      sourceHash: extract.sourceHash,
      contentLengthChars: extract.contentLengthChars,
      usage: extract.usage,
      candidateCount: extract.candidateCount,
      unverifiedCount: extract.unverifiedCount,
      thresholds: extract.thresholds,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    log.info(`Extracted ${extract.thresholds.length} threshold(s) from ${url}`);
    log.info(
      `  format: ${extract.sourceFormat}  hash: ${extract.sourceHash.slice(0, 16)}…  length: ${extract.contentLengthChars} chars`,
    );
    log.info(
      `  tokens: in=${extract.usage.input_tokens} out=${extract.usage.output_tokens}  pass1=${extract.pass1Model} pass2=${extract.pass2Model}`,
    );
    log.info(
      `  candidates: ${extract.candidateCount}  unverified: ${extract.unverifiedCount}`,
    );
    if (extract.unverifiedCount > 0) {
      log.warn(
        `${extract.unverifiedCount} threshold(s) failed span verification — review before human approval.`,
      );
    }
    for (const t of extract.thresholds) {
      log.info(
        `  [${t.riskDomainCanonical}/${t.tierLabel}] (${t.tierSortOrder}) conf=${t.extractionConfidence.toFixed(2)} commit=${t.commitmentLanguage ?? '—'}`,
      );
      log.info(`    ${t.triggerDescription.slice(0, 140)}`);
    }
  }

  if (opts.apply) {
    const { apiRequest } = await import('../lib/wiki-server/client.ts');
    const items = toThresholdSyncItems(versionId, extract.thresholds, {
      extractionModel: extract.pass2Model || extract.pass1Model,
    });
    if (items.length === 0) {
      log.warn('No thresholds extracted — skipping --apply.');
      return { output: '', exitCode: 0 };
    }
    const result = await apiRequest<{ upserted: number }>(
      'POST',
      '/api/framework-capability-thresholds/sync',
      { items },
    );
    if (!result.ok) {
      log.error(`Sync failed: ${result.error} — ${result.message}`);
      return { output: '', exitCode: 2 };
    }
    log.info(`✓ Synced ${items.length} threshold(s) to /api/framework-capability-thresholds/sync`);
  }

  return { output: '', exitCode: 0 };
}

async function diffCommand(opts: FrameworkOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(opts.ci));

  const args = (opts as { args?: unknown[] }).args;
  const positional = Array.isArray(args) ? args : [];
  const fromVersion = opts.fromVersion ?? (typeof positional[0] === 'string' ? positional[0] : undefined);
  const toVersion = opts.toVersion ?? (typeof positional[1] === 'string' ? positional[1] : undefined);
  if (!fromVersion || !toVersion) {
    log.error(
      'Usage: crux tb frameworks diff <fromVersionId> <toVersionId> [--apply] [--skip-classifier]',
    );
    return { output: '', exitCode: 1 };
  }

  // Fetch thresholds for both versions.
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const fromRes = await apiRequest<{ items: ExtractedThreshold[] }>(
    'GET',
    `/api/framework-capability-thresholds/by-version/${encodeURIComponent(fromVersion)}?limit=500`,
  );
  const toRes = await apiRequest<{ items: ExtractedThreshold[] }>(
    'GET',
    `/api/framework-capability-thresholds/by-version/${encodeURIComponent(toVersion)}?limit=500`,
  );
  if (!fromRes.ok || !toRes.ok) {
    log.error(
      `Fetch failed: fromOk=${fromRes.ok} toOk=${toRes.ok}`,
    );
    return { output: '', exitCode: 2 };
  }

  // Rows from the API are the sync-shape (not ExtractedThreshold), but
  // they share the fields the structural diff needs. Cast via unknown to
  // keep the diff code path honest about what it consumes.
  const before = (fromRes.data.items ?? []) as unknown as ExtractedThreshold[];
  const after = (toRes.data.items ?? []) as unknown as ExtractedThreshold[];

  let aggregate: DiffAggregate;
  let classifiedByModel: string | null = null;
  if (opts.skipClassifier) {
    aggregate = aggregateDiff(structuralDiff(before, after));
  } else {
    aggregate = await diffFrameworkVersions(before, after, {
      llmModel: resolveLlmModel(opts.model),
    });
    classifiedByModel = resolveLlmModel(opts.model);
  }

  if (opts.json) {
    console.log(JSON.stringify({ fromVersion, toVersion, aggregate }, null, 2));
  } else {
    log.info(
      `Diff ${fromVersion} → ${toVersion}: ${aggregate.changeSummary}`,
    );
    log.info(`  overall direction: ${aggregate.overallDirection}`);
    if (aggregate.weakeningFlagged)
      log.warn(`  ⚠ weakening flagged (landing as 'unreviewed' for human review)`);
    if (aggregate.strengtheningFlagged)
      log.info(`  strengthening flagged`);
    for (const item of aggregate.items) {
      log.info(
        `  [${item.changeType}/${item.riskDomainCanonical ?? '—'}] tag=${item.classifierTag ?? '—'} sev=${item.severity ?? '—'}`,
      );
      if (item.rationale) log.info(`    ${item.rationale.slice(0, 140)}`);
    }
  }

  if (opts.apply) {
    const payload = toDiffSyncPayloads(fromVersion, toVersion, aggregate, {
      classifiedByModel,
    });
    const diffRes = await apiRequest<{ upserted: number }>(
      'POST',
      '/api/framework-diffs/sync',
      { items: [payload.diff] },
    );
    if (!diffRes.ok) {
      log.error(`framework-diffs sync failed: ${diffRes.error} — ${diffRes.message}`);
      return { output: '', exitCode: 2 };
    }
    if (payload.items.length > 0) {
      const itemsRes = await apiRequest<{ upserted: number }>(
        'POST',
        '/api/framework-diff-items/sync',
        { items: payload.items },
      );
      if (!itemsRes.ok) {
        log.error(`framework-diff-items sync failed: ${itemsRes.error} — ${itemsRes.message}`);
        return { output: '', exitCode: 2 };
      }
    }
    log.info(`✓ Synced diff + ${payload.items.length} item(s) (unreviewed).`);
  }

  return { output: '', exitCode: 0 };
}

async function fetchCommand(opts: FrameworkOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(opts.ci));

  const args = (opts as { args?: unknown[] }).args;
  const positional = Array.isArray(args) && typeof args[0] === 'string' ? (args[0] as string) : undefined;
  const url = opts.url ?? positional;
  if (!url) {
    log.error('Usage: crux tb frameworks fetch <url> [--skip-wayback] [--json]');
    return { output: '', exitCode: 1 };
  }

  const result = await fetchFramework({
    url,
    skipWayback: Boolean(opts.skipWayback),
  });

  if (opts.json) {
    // Emit the full result but skip the sourceText to keep output compact.
    const { sourceText: _sourceText, ...rest } = result;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    log.info(`Fetched ${url}`);
    log.info(`  content type: ${result.contentType}  http: ${result.httpStatus ?? '—'}`);
    log.info(`  content hash: ${result.contentHash.slice(0, 16)}…  length: ${result.contentLengthChars} chars`);
    log.info(`  wayback: ${result.waybackSnapshotUrl ?? '(none)'}`);
    if (result.note) log.info(`  note: ${result.note}`);
  }

  return { output: '', exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const commands = {
  extract: extractCommand,
  diff: diffCommand,
  fetch: fetchCommand,
  default: extractCommand,
};

export function getHelp(): string {
  return `
Frameworks — Frontier safety framework tracker (QUA-691)

Subcommands:
  extract <url>   Two-pass LLM extraction of capability thresholds
                  --framework=<sid>         framework stableId (required)
                  --version=<label>         version label (required)
                  --apply                   POST thresholds to wiki-server /sync
                  --model=haiku|sonnet      LLM (default sonnet)
                  --max-chars=N             cap source text (default 120k)
                  --json                    raw JSON output

  diff <from> <to>  Compute + classify structured diff between two versions
                  --apply                   POST diff + items to wiki-server
                  --skip-classifier         skip the LLM classifier pass
                  --json                    raw JSON output

  fetch <url>    Fetch + hash + Wayback push a framework URL
                  --skip-wayback            skip the Wayback push
                  --json                    raw JSON output

Examples:
  crux tb frameworks extract https://anthropic.com/rsp-v3.1.pdf \\
      --framework=sid_XXXXXXXXXX --version=v3.1

  crux tb frameworks diff sid_FROM sid_TO --apply
`.trim();
}
