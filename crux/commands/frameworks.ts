/**
 * Frontier-safety-framework subcommands — `crux tb frameworks ...`
 * (QUA-691 foundation, QUA-707 registry-driven ingest).
 *
 * Per-URL subcommands (manual single-version ingest):
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
 * Registry-driven subcommands (end-to-end batch from data/frameworks/frameworks.yaml):
 *   list           Print the loaded registry
 *   seed [--apply] Sync framework rows
 *   ingest [--apply] [--only=<key>] [--max=N] [--skip-extract|skip-diffs|...]
 *
 * Both `tb frameworks <sub>` (two-word) and `tb frameworks-<sub>` (hyphenated)
 * dispatches are wired up in `tablebase.ts` and the `default` handler.
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
} from '../frameworks/diff.ts';
import { fetchFramework } from '../frameworks/fetch.ts';
import { MODELS } from '../lib/anthropic.ts';
import { createLogger } from '../lib/output.ts';
import {
  toThresholdSyncItems,
  toDiffSyncPayloads,
} from '../frameworks/sync-payloads.ts';
import {
  loadRegistry,
  type RegistryFramework,
} from '../frameworks/registry.ts';
import {
  buildFrameworkSyncItems,
  defaultIngestDeps,
  runIngest,
  type IngestOptions,
  type IngestSummary,
} from '../frameworks/orchestrator.ts';

// Re-export the sync-payload helpers for backward compatibility with the
// existing `commands/frameworks.test.ts` tests and any external callers.
export { toThresholdSyncItems, toDiffSyncPayloads };

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
// Registry-driven subcommands (QUA-707)
//
// These take `(args, options)` per the canonical dispatcher signature
// (see crux.mjs::main and crux/commands/people.ts for the pattern).
// `args` is the raw positional tail — `extract`/`diff`/`fetch` above use
// the older single-arg signature which routes positionals through opts.args;
// the new commands below intentionally use the two-arg signature so options
// like `--apply`, `--only`, `--max`, etc. arrive through `options` correctly.
// ---------------------------------------------------------------------------

interface RegistryDrivenOptions extends CommandOptions {
  apply?: boolean;
  json?: boolean;
  only?: string;
  max?: string;
  skipExtract?: boolean;
  skipDiffs?: boolean;
  forceReextract?: boolean;
  skipWayback?: boolean;
  skipClassifier?: boolean;
  dryRun?: boolean;
  model?: string;
}

async function listCommand(
  _args: string[],
  options: RegistryDrivenOptions,
): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  let registry: RegistryFramework[];
  try {
    registry = loadRegistry();
  } catch (err) {
    log.error(
      `Failed to load registry: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { output: '', exitCode: 1 };
  }

  if (options.json) {
    const items = buildFrameworkSyncItems(registry).map((item, idx) => ({
      ...item,
      key: registry[idx].key,
      versions: registry[idx].versions.map((v) => ({
        versionLabel: v.versionLabel,
        publishedDate: v.publishedDate,
        sourceUrl: v.sourceUrl,
        isDraft: v.isDraft,
        versionSortOrder: v.versionSortOrder,
      })),
    }));
    console.log(JSON.stringify(items, null, 2));
    return { output: '', exitCode: 0 };
  }

  log.info(
    `Loaded ${registry.length} framework(s) with ${registry.reduce((n, e) => n + e.versions.length, 0)} version(s):`,
  );
  for (const e of registry) {
    log.info(
      `  ${e.key} (${e.frameworkId.slice(0, 8)}…) — ${e.name} [${e.orgId}] — ${e.versions.length} version(s)`,
    );
    for (const v of e.versions) {
      log.info(
        `    ${v.versionSortOrder}. ${v.versionLabel}  (${v.publishedDate})${v.isDraft ? ' [draft]' : ''}  ${v.sourceUrl}`,
      );
    }
  }

  return { output: '', exitCode: 0 };
}

async function seedCommand(
  _args: string[],
  options: RegistryDrivenOptions,
): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  let registry: RegistryFramework[];
  try {
    registry = loadRegistry();
  } catch (err) {
    log.error(
      `Failed to load registry: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { output: '', exitCode: 1 };
  }

  const items = buildFrameworkSyncItems(registry);
  log.info(`${items.length} framework row(s) ready to sync:`);
  for (const item of items) {
    log.info(`  ${item.id.slice(0, 8)}…  ${item.orgId} → ${item.name} (${item.currentStatus})`);
  }

  if (!options.apply) {
    log.info('Dry-run; pass --apply to sync to /api/safety-frameworks/sync');
    return { output: '', exitCode: 0 };
  }

  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const res = await apiRequest<{ upserted: number }>(
    'POST',
    '/api/safety-frameworks/sync',
    { items },
  );
  if (!res.ok) {
    log.error(`Sync failed: ${res.error} — ${res.message}`);
    return { output: '', exitCode: 2 };
  }
  log.info(`✓ Synced ${items.length} framework row(s).`);
  return { output: '', exitCode: 0 };
}

async function ingestCommand(
  _args: string[],
  options: RegistryDrivenOptions,
): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));

  let maxVersions: number | undefined;
  if (options.max !== undefined) {
    const n = parseInt(String(options.max), 10);
    if (!Number.isFinite(n) || n < 1) {
      return {
        exitCode: 1,
        output: `--max must be a positive integer (got "${options.max}")`,
      };
    }
    maxVersions = n;
  }

  const ingestOpts: IngestOptions = {
    frameworkKey: options.only,
    maxVersions,
    // Default to dry-run unless --apply is given. --dry-run is also accepted
    // as an explicit hint for symmetry with other tooling, but `apply` is
    // the primary opt-in.
    dryRun: Boolean(options.dryRun) || !options.apply,
    skipExtract: Boolean(options.skipExtract),
    skipDiffs: Boolean(options.skipDiffs),
    forceReextract: Boolean(options.forceReextract),
    skipWayback: Boolean(options.skipWayback),
    skipClassifier: Boolean(options.skipClassifier),
    llmModel: options.model ? resolveLlmModel(options.model) : undefined,
  };

  if (ingestOpts.dryRun) {
    log.info(
      'Dry-run: fetching + extracting will run, but no /sync POSTs will be issued. Pass --apply to write to wiki-server.',
    );
  }

  let summary: IngestSummary;
  try {
    const deps = await defaultIngestDeps({
      log: (level, msg) => {
        if (level === 'error') log.error(msg);
        else if (level === 'warn') log.warn(msg);
        else log.info(msg);
      },
    });
    summary = await runIngest(deps, ingestOpts);
  } catch (err) {
    log.error(
      `Ingest aborted: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { output: '', exitCode: 2 };
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    log.info('');
    log.info(`Frameworks: ${summary.frameworksSynced}`);
    log.info(
      `Versions:  attempted=${summary.versionsAttempted} synced=${summary.versionsSynced} skipped=${summary.versionsSkipped} failed=${summary.versionsFailed}`,
    );
    log.info(`Diffs:     synced=${summary.diffsSynced} failed=${summary.diffsFailed}`);
    if (summary.versionsFailed > 0 || summary.diffsFailed > 0) {
      log.warn(
        'One or more versions/diffs failed — see per-line errors above. Re-run after addressing the cause.',
      );
    }
  }

  return {
    output: '',
    exitCode: summary.versionsFailed > 0 || summary.diffsFailed > 0 ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Registration
//
// extract / diff / fetch use the legacy `(opts)` single-arg signature which
// is leftover from how QUA-691 first wrote them — they're left as-is for
// this PR. The new list / seed / ingest commands use the proper
// `(args, options)` two-arg signature, since they need flag-driven options.
//
// `default` dispatches based on the first positional arg: `crux tb frameworks
// list` → listCommand; `seed` / `ingest` similarly. Otherwise falls back to
// listCommand. The hyphenated aliases (`frameworks-list`, `frameworks-seed`,
// `frameworks-ingest`) registered in tablebase.ts always work too.
// ---------------------------------------------------------------------------

type ArgsOptionsHandler = (args: string[], options: CommandOptions) => Promise<CommandResult>;
type LegacyOptsHandler = (opts: FrameworkOptions) => Promise<CommandResult>;

const REGISTRY_DRIVEN: Record<string, ArgsOptionsHandler> = {
  list: listCommand,
  seed: seedCommand,
  ingest: ingestCommand,
};

const LEGACY: Record<string, LegacyOptsHandler> = {
  extract: extractCommand,
  diff: diffCommand,
  fetch: fetchCommand,
};

async function defaultCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const first = Array.isArray(args) && typeof args[0] === 'string' ? args[0] : null;
  if (first && first in REGISTRY_DRIVEN) {
    return REGISTRY_DRIVEN[first]!(args.slice(1), options);
  }
  if (first && first in LEGACY) {
    return LEGACY[first]!({ ...options, args: args.slice(1) } as FrameworkOptions);
  }
  return listCommand(args, options as RegistryDrivenOptions);
}

export const commands = {
  extract: extractCommand,
  diff: diffCommand,
  fetch: fetchCommand,
  list: listCommand,
  seed: seedCommand,
  ingest: ingestCommand,
  default: defaultCommand,
};

export function getHelp(): string {
  return `
Frameworks — Frontier safety framework tracker (QUA-691, QUA-707)

Per-URL subcommands (low-level, manual ingest of a single version):
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

Registry-driven subcommands (QUA-707, end-to-end batch):
  list           Print the loaded registry (12 frameworks / ~22 versions)
                  --json                    raw JSON output

  seed           Sync the framework registry rows
                  --apply                   POST to /api/safety-frameworks/sync
                  (without --apply this is a dry-run)

  ingest         Run the full pipeline: fetch → extract → sync versions +
                  thresholds → diff consecutive pairs → sync diffs
                  --apply                   actually POST (default is dry-run)
                  --only=<key>              process only one framework key
                  --max=N                   cap versions per framework
                  --skip-extract            skip the LLM extraction pass
                  --skip-diffs              skip the diff pass
                  --force-reextract         re-extract even if version exists
                  --skip-classifier         skip LLM diff classifier
                  --skip-wayback            skip Wayback push
                  --model=haiku|sonnet      LLM (default sonnet)
                  --json                    summary as JSON

Examples:
  crux tb frameworks list
  crux tb frameworks seed --apply
  crux tb frameworks ingest --only=anthropic-rsp --max=1
  crux tb frameworks ingest --apply
`.trim();
}
