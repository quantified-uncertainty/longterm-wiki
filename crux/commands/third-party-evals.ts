/**
 * Third-party-evals subcommands — `crux tb third-party-evals ...` (QUA-692).
 *
 * Sub-subcommands (parsed from positional[0] of the args array):
 *   ingest <evaluator>          List candidate URLs from a source (no fetch/extract)
 *                               --since=YYYY-MM-DD   UK AISI: skip URLs older than this
 *                               --json               Raw JSON output
 *
 *   extract <url>               Extract a single report URL with the LLM
 *                                --evaluator=<id>      stableId of evaluator org (required)
 *                                --apply               POST to wiki-server /sync
 *                                --model=haiku|sonnet  LLM (default haiku)
 *                                --source-system=...   sitemap | rss | html-scrape | manual
 *                                --json                Raw JSON output
 *
 * Picks the right ingester based on `<evaluator>`:
 *   uk-aisi          → UK AISI sitemap
 *   us-aisi | caisi  → NIST CAISI blog
 *   metr             → METR RSS
 *   apollo | apollo-research → Apollo Research listing
 */

import type { CommandOptions, CommandResult } from "../lib/command-types.ts";
import { createLogger } from "../lib/output.ts";
import { MODELS } from "../lib/anthropic.ts";
import { generateId } from "../lib/grant-import/id.ts";
import {
  extractEvalReport,
  toSyncItem,
  EXTRACTOR_VERSION,
} from "../third-party-evals/extract-eval-report.ts";
import { verifyExtractedReport } from "../third-party-evals/span-verify.ts";
import { resolveAiModel } from "../lib/ai-model-resolver.ts";
import { dispatchIngest } from "../third-party-evals/ingesters/dispatch.ts";
import { backfillEvaluator } from "../third-party-evals/backfill.ts";

interface ThirdPartyEvalOptions extends CommandOptions {
  evaluator?: string;
  model?: string;
  apply?: boolean;
  json?: boolean;
  since?: string;
  sourceSystem?: "sitemap" | "rss" | "html-scrape" | "manual";
  maxSourceChars?: string;
  ci?: boolean;
  concurrency?: string;
  batchSize?: string;
  limit?: string;
  dryRun?: boolean;
}

/**
 * Parse a CLI numeric flag. Returns:
 *   - undefined when the flag wasn't passed (caller falls back to default)
 *   - Error with a usage message when the value is non-numeric or non-positive
 *     (NaN would otherwise silently propagate to `pLimit(NaN)` and hang)
 *   - the parsed positive integer otherwise
 */
function parsePositiveInt(
  value: string | undefined,
  flagName: string,
): number | undefined | Error {
  if (value === undefined) return undefined;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) {
    return new Error(
      `--${flagName} must be a positive integer (got '${value}')`,
    );
  }
  return n;
}

function resolveLlmModel(name?: string): string {
  if (!name) return MODELS.haiku;
  const lower = name.toLowerCase();
  if (lower === "haiku") return MODELS.haiku;
  if (lower === "sonnet") return MODELS.sonnet;
  if (lower === "opus") return MODELS.opus;
  return name;
}

async function ingestSubcommand(
  args: string[],
  options: ThirdPartyEvalOptions,
): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  // args[0] is the sub-subcommand verb 'ingest' (consumed by parseSubcommand);
  // args[1] is the evaluator name.
  const evaluator = args[0];

  if (!evaluator) {
    return {
      output:
        "Usage: crux tb third-party-evals ingest <uk-aisi|us-aisi|metr|apollo> [--since=YYYY-MM-DD] [--json]",
      exitCode: 1,
    };
  }

  let result;
  try {
    result = await dispatchIngest(evaluator, { since: options.since });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: msg, exitCode: 1 };
  }

  if (options.json) {
    return { output: JSON.stringify(result, null, 2), exitCode: result.errors.length > 0 ? 2 : 0 };
  }

  const lines: string[] = [];
  lines.push(`Evaluator: ${result.evaluator}`);
  lines.push(`Candidates: ${result.candidates.length}`);
  if (result.errors.length > 0) {
    for (const err of result.errors) lines.push(`  error: ${err}`);
  }
  const preview = result.candidates.slice(0, 10);
  for (const c of preview) {
    const date = c.publishedDate ? c.publishedDate.slice(0, 10) : "          ";
    const title = c.title ? c.title.slice(0, 80) : "";
    lines.push(`  ${date}  ${c.url}${title ? `  — ${title}` : ""}`);
  }
  if (result.candidates.length > preview.length) {
    lines.push(`  ... and ${result.candidates.length - preview.length} more`);
  }
  void log;
  return { output: lines.join("\n"), exitCode: result.errors.length > 0 ? 2 : 0 };
}

async function extractSubcommand(
  args: string[],
  options: ThirdPartyEvalOptions,
): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const url = args[0];
  if (!url) {
    return {
      output:
        "Usage: crux tb third-party-evals extract <url> --evaluator=<orgStableId> [--apply]",
      exitCode: 1,
    };
  }
  if (!options.evaluator) {
    return {
      output:
        "--evaluator=<orgStableId> is required (the stableId of the evaluator org entity).",
      exitCode: 1,
    };
  }

  const maxSourceChars = options.maxSourceChars
    ? Math.max(1000, parseInt(options.maxSourceChars, 10))
    : undefined;

  const sourceSystem = options.sourceSystem ?? "manual";

  const extract = await extractEvalReport({
    url,
    evaluatorOrgId: options.evaluator,
    llmModel: resolveLlmModel(options.model),
    maxSourceChars,
  });

  const verify = verifyExtractedReport(extract.report, extract.sourceText);

  // Resolve every named model — pass to the join table at sync time.
  const modelLinks = verify.verifiedReport.modelsNamed
    .map((rawName) => {
      const matches = resolveAiModel(rawName, { maxResults: 1 });
      const top = matches[0];
      if (!top) return null;
      return {
        aiModelId: top.stableId,
        aiModelDisplayName: top.title,
        rawNameInReport: rawName,
        matchConfidence: top.matchConfidence,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const id = generateId(`third-party-eval:${url}:${extract.sourceHash}`);

  const item = toSyncItem(extract, {
    id,
    evaluatorOrgId: options.evaluator,
    reportUrl: url,
    sourceSystem,
    models: modelLinks,
    confidenceMap: verify.confidenceMap,
  });

  if (options.json) {
    const out = JSON.stringify(
      {
        url,
        evaluatorOrgId: options.evaluator,
        extractorVersion: EXTRACTOR_VERSION,
        extractionModel: extract.extractionModel,
        sourceFormat: extract.sourceFormat,
        sourceHash: extract.sourceHash,
        usage: extract.usage,
        report: verify.verifiedReport,
        droppedFields: verify.droppedFields,
        ungroundedFields: verify.ungroundedFields,
        confidenceMap: verify.confidenceMap,
        unresolvedModels: verify.verifiedReport.modelsNamed.length - modelLinks.length,
        syncItem: item,
      },
      null,
      2,
    );
    if (options.apply) {
      const { syncThirdPartyEvaluations } = await import(
        "../lib/wiki-server/third-party-evaluations.ts"
      );
      const result = await syncThirdPartyEvaluations([item]);
      if (!result.ok) {
        log.error(`Sync failed: ${result.error} — ${result.message}`);
        return { output: out, exitCode: 2 };
      }
      log.info(
        `✓ Synced to /api/third-party-evaluations/sync (${JSON.stringify(result.data)})`,
      );
    }
    return { output: out, exitCode: 0 };
  }

  const r = verify.verifiedReport;
  const lines: string[] = [];
  lines.push(`Extracted eval report from ${url}`);
  lines.push(
    `  format: ${extract.sourceFormat}  hash: ${extract.sourceHash.slice(0, 16)}…`,
  );
  lines.push(
    `  LLM: ${extract.extractionModel}  tokens: in=${extract.usage.input_tokens} out=${extract.usage.output_tokens}`,
  );
  lines.push("");
  const row = (k: string, v: unknown) => {
    if (v == null) return;
    const s = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    lines.push(`  ${k.padEnd(22)} ${s.slice(0, 120)}`);
  };
  row("title", r.title);
  row("publishedDate", r.publishedDate);
  row("riskDomain", r.riskDomain);
  row("preDeployment", r.preDeployment);
  row("findingsSummary", r.findingsSummary);
  row("methodologyUrl", r.methodologyUrl);
  row("reportPdfUrl", r.reportPdfUrl);
  row("modelsNamed", r.modelsNamed);
  lines.push(
    `  ${"models linked".padEnd(22)} ${modelLinks.length} of ${r.modelsNamed.length}`,
  );
  if (verify.droppedFields.length > 0) {
    lines.push(
      `  Dropped ${verify.droppedFields.length} unverified fields: ${verify.droppedFields.join(", ")}`,
    );
  }

  if (options.apply) {
    const { syncThirdPartyEvaluations } = await import(
      "../lib/wiki-server/third-party-evaluations.ts"
    );
    const result = await syncThirdPartyEvaluations([item]);
    if (!result.ok) {
      lines.push(`Sync failed: ${result.error} — ${result.message}`);
      return { output: lines.join("\n"), exitCode: 2 };
    }
    lines.push(
      `✓ Synced to /api/third-party-evaluations/sync (${JSON.stringify(result.data)})`,
    );
  }

  return { output: lines.join("\n"), exitCode: 0 };
}

async function backfillSubcommand(
  args: string[],
  options: ThirdPartyEvalOptions,
): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const evaluator = args[0];
  if (!evaluator) {
    return {
      output:
        "Usage: crux tb third-party-evals backfill <uk-aisi|us-aisi|metr|apollo> --evaluator=<orgStableId> [--limit=N] [--concurrency=N] [--batch-size=N] [--since=YYYY-MM-DD] [--dry-run] [--model=haiku|sonnet]",
      exitCode: 1,
    };
  }
  if (!options.evaluator) {
    return {
      output:
        "--evaluator=<orgStableId> is required (the stableId of the evaluator org entity).",
      exitCode: 1,
    };
  }

  const concurrency = parsePositiveInt(options.concurrency, "concurrency");
  if (concurrency instanceof Error) return { output: concurrency.message, exitCode: 1 };
  const batchSize = parsePositiveInt(options.batchSize, "batch-size");
  if (batchSize instanceof Error) return { output: batchSize.message, exitCode: 1 };
  const limit = parsePositiveInt(options.limit, "limit");
  if (limit instanceof Error) return { output: limit.message, exitCode: 1 };

  const result = await backfillEvaluator({
    evaluator,
    evaluatorOrgId: options.evaluator,
    llmModel: resolveLlmModel(options.model),
    concurrency,
    batchSize,
    limit,
    since: options.since,
    dryRun: Boolean(options.dryRun),
    onProgress: (event) => {
      if (event.kind === "extracted") {
        log.dim(`  [${event.index}/${event.total}] ✓ ${event.url}`);
      } else if (event.kind === "extract-error") {
        log.warn(`  [${event.index}/${event.total}] ✗ ${event.url} — ${event.error}`);
      } else if (event.kind === "synced") {
        log.info(`  → synced batch ${event.batchIndex} (${event.count} rows)`);
      } else {
        log.error(`  → sync batch ${event.batchIndex} failed: ${event.error}`);
      }
    },
  });

  const lines: string[] = [];
  lines.push("");
  lines.push(`Backfill complete: ${result.evaluator}`);
  lines.push(`  candidates:        ${result.candidates}`);
  lines.push(`  extracted:         ${result.extracted}`);
  lines.push(`  extract failures:  ${result.extractFailures.length}`);
  lines.push(`  synced:            ${result.synced}${options.dryRun ? "  (dry-run, nothing posted)" : ""}`);
  lines.push(`  sync failures:     ${result.syncFailures.length}`);
  lines.push(`  duration:          ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.extractFailures.length > 0) {
    lines.push(``);
    lines.push(`Extract failures:`);
    for (const f of result.extractFailures.slice(0, 20)) {
      lines.push(`  ${f.url}\n    ${f.error}`);
    }
    if (result.extractFailures.length > 20) {
      lines.push(`  ... and ${result.extractFailures.length - 20} more`);
    }
  }
  if (result.syncFailures.length > 0) {
    lines.push(``);
    lines.push(`Sync failures:`);
    for (const f of result.syncFailures) {
      lines.push(`  batch ${f.batchIndex}: ${f.error}`);
    }
  }

  return { output: lines.join("\n"), exitCode: backfillExitCode(result) };
}

function backfillExitCode(result: {
  candidates: number;
  extractFailures: unknown[];
  syncFailures: unknown[];
}): number {
  if (result.syncFailures.length > 0) return 2;
  if (result.candidates > 0 && result.extractFailures.length === result.candidates) return 2;
  return 0;
}

/**
 * Default dispatcher — reads the first positional arg as the
 * sub-subcommand verb and routes to ingest/extract/backfill.
 */
async function defaultCommand(
  args: string[],
  options: ThirdPartyEvalOptions,
): Promise<CommandResult> {
  const verb = args[0];
  if (!verb) {
    return { output: getHelp(), exitCode: 0 };
  }
  if (verb === "ingest") {
    return ingestSubcommand(args.slice(1), options);
  }
  if (verb === "extract") {
    return extractSubcommand(args.slice(1), options);
  }
  if (verb === "backfill") {
    return backfillSubcommand(args.slice(1), options);
  }
  return {
    output: `Unknown subcommand '${verb}'. Use 'ingest', 'extract', or 'backfill'.\n\n${getHelp()}`,
    exitCode: 1,
  };
}

export const commands: Record<
  string,
  (args: string[], options: ThirdPartyEvalOptions) => Promise<CommandResult>
> = {
  ingest: async (args, options) => ingestSubcommand(args, options),
  extract: async (args, options) => extractSubcommand(args, options),
  backfill: async (args, options) => backfillSubcommand(args, options),
  default: defaultCommand,
};

export function getHelp(): string {
  return `
Third-Party Evaluations — Index of pre-deployment evaluations and red-team
reports from UK AISI, US AISI / CAISI, METR, and Apollo Research (QUA-692).

Subcommands:
  ingest <evaluator>    List candidate URLs from the evaluator's index
                          uk-aisi   sitemap (~140 reports)
                          metr      RSS feed (~30 reports)
                          apollo    HTML scrape (~25)
                          us-aisi   NIST CAISI blog (~4)
                        Options:
                          --since=YYYY-MM-DD  Skip URLs older than this (UK AISI only)
                          --json              Raw JSON output

  extract <url>         Extract one report with the LLM
                          --evaluator=<orgId>     stableId of the evaluator org (required)
                          --apply                 POST to /api/third-party-evaluations/sync
                          --source-system=<key>   sitemap | rss | html-scrape | manual (default manual)
                          --model=haiku|sonnet    LLM (default haiku)
                          --json                  raw JSON output

  backfill <evaluator>  Ingest + extract + sync end-to-end (QUA-705)
                          --evaluator=<orgId>     stableId of evaluator org (required)
                          --concurrency=N         parallel extract calls (default 4)
                          --batch-size=N          items per /sync POST (default 25)
                          --limit=N               cap candidates (smoke test)
                          --since=YYYY-MM-DD      skip older URLs (UK AISI only)
                          --dry-run               extract but don't POST
                          --model=haiku|sonnet    LLM (default haiku)

Examples:
  crux tb third-party-evals ingest uk-aisi --since=2026-01-01

  crux tb third-party-evals extract https://www.aisi.gov.uk/blog/foo \\
      --evaluator=sid_aX0jkoaekQ --source-system=sitemap

  crux tb third-party-evals backfill uk-aisi --evaluator=sid_aX0jkoaekQ \\
      --since=2025-01-01 --concurrency=4

  crux tb third-party-evals backfill metr --evaluator=sid_rQEkFJxS5w \\
      --limit=2 --dry-run
`.trim();
}
