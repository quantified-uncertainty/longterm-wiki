/**
 * System-cards subcommands — `crux tb system-cards ...` (QUA-690).
 *
 * Extracts structured data from an AI model / system card URL, verifies
 * extracted fields against the source, and optionally POSTs to the
 * wiki-server `/api/model-system-cards/sync` endpoint.
 *
 * Subcommands:
 *   extract <url> --ai-model=<entityId>    Extract + verify + print JSON
 *                  [--apply]               ... and POST to wiki-server
 *                  [--lab=<key>]           Override auto-detected lab
 *                  [--model=haiku|sonnet]  LLM to use (default sonnet)
 *                  [--json]                Raw JSON output
 */

import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import { generateId } from '../lib/grant-import/id.ts';
import {
  extractSystemCard,
  EXTRACTOR_VERSION,
  type ExtractedCard,
  type ExtractResult,
} from '../system-cards/extract-system-card.ts';
import { verifyExtractedCard, type VerifyResult } from '../system-cards/span-verify.ts';
import { MODELS } from '../lib/anthropic.ts';
import { createLogger } from '../lib/output.ts';

interface SystemCardOptions extends CommandOptions {
  url?: string;
  aiModel?: string;
  lab?: string;
  model?: string;
  apply?: boolean;
  json?: boolean;
  maxSourceChars?: string;
}

/**
 * Map the verified `ExtractedCard` to a sync-item payload that matches
 * the model-system-cards POST /sync Zod schema. Field names are
 * camelCased.
 */
export function toSyncItem(
  extract: ExtractResult,
  verify: VerifyResult,
  opts: { aiModelId: string; aiModelDisplayName?: string | null; sourceUrl: string },
): Record<string, unknown> {
  const c = verify.verifiedCard;
  const id = generateId(
    `model-system-card:${opts.aiModelId}:${extract.sourceHash}`,
  );
  return {
    id,
    aiModelId: opts.aiModelId,
    aiModelDisplayName: opts.aiModelDisplayName ?? null,
    version: c.version,
    releaseDate: c.release_date,
    deprecationDate: c.deprecation_date,
    trainingCutoff: c.training_cutoff,
    trainingComputeFlops: c.training_compute_flops,
    trainingGpuHours: c.training_gpu_hours,
    trainingHardware: c.training_hardware,
    parametersTotal: c.parameters_total,
    parametersActive: c.parameters_active,
    architecture: c.architecture,
    modalitiesIn: c.modalities_in,
    modalitiesOut: c.modalities_out,
    contextWindowTokens: c.context_window_tokens,
    outputWindowTokens: c.output_window_tokens,
    languagesSupported: c.languages_supported,
    safetyFramework: c.safety_framework,
    safetyTier: c.safety_tier,
    safetyTierDomains: c.safety_tier_domains,
    safeguardsSummary: c.safeguards_summary,
    classifierDetails: c.classifier_details,
    fineTuningPolicy: c.fine_tuning_policy,
    deploymentChannels: c.deployment_channels,
    evalScoresCited: c.eval_scores_cited?.map((s) => ({
      benchmark: s.benchmark,
      score: s.score ?? 0, // sync schema requires `score` — 0 is a "present but unknown" sentinel
      metric: s.metric ?? null,
      setup: s.setup ?? null,
      excerpt: s.excerpt ?? null,
    })) ?? null,
    thirdPartyEvals: c.third_party_evals ?? null,
    redTeamSummary: c.red_team_summary,
    incidentDisclosures: c.incident_disclosures,
    sourceUrl: opts.sourceUrl,
    sourceFormat: extract.sourceFormat,
    sourceHash: extract.sourceHash,
    waybackSnapshotUrl: extract.waybackSnapshotUrl,
    systemPromptUrl: c.system_prompt_url,
    usagePolicyUrl: c.usage_policy_url,
    extractedAt: extract.extractedAt,
    extractorVersion: extract.extractorVersion,
    extractionModel: extract.extractionModel,
    extractionConfidence: verify.confidenceMap,
    notes: c.notes,
  };
}

function resolveLlmModel(name?: string): string {
  if (!name) return MODELS.sonnet;
  const lower = name.toLowerCase();
  if (lower === 'haiku') return MODELS.haiku;
  if (lower === 'sonnet') return MODELS.sonnet;
  if (lower === 'opus') return MODELS.opus;
  return name;
}

async function extractCommand(opts: SystemCardOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(opts.ci));

  // Support both positional URL (via --args=<url>) and --url flag.
  const args = (opts as { args?: unknown[] }).args;
  const positional = Array.isArray(args) && typeof args[0] === 'string' ? (args[0] as string) : undefined;
  const url = opts.url ?? positional;
  if (!url) {
    log.error('Usage: crux tb system-cards extract <url> --ai-model=<entityId> [--apply] [--lab=<key>]');
    return { output: '', exitCode: 1 };
  }
  if (!opts.aiModel) {
    log.error('--ai-model=<entityId> is required (the stableId of the ai-model entity).');
    return { output: '', exitCode: 1 };
  }

  const maxSourceChars = opts.maxSourceChars
    ? Math.max(1000, parseInt(opts.maxSourceChars, 10))
    : undefined;

  const extract = await extractSystemCard({
    url,
    aiModelId: opts.aiModel,
    aiModelDisplayName: null,
    lab: opts.lab === undefined ? undefined : opts.lab || null,
    llmModel: resolveLlmModel(opts.model),
    maxSourceChars,
  });

  const verify = verifyExtractedCard(extract.card, extract.sourceText);

  if (opts.json) {
    const output = {
      url,
      aiModelId: opts.aiModel,
      lab: extract.lab,
      extractorVersion: EXTRACTOR_VERSION,
      extractionModel: extract.extractionModel,
      sourceFormat: extract.sourceFormat,
      sourceHash: extract.sourceHash,
      usage: extract.usage,
      card: verify.verifiedCard,
      droppedFields: verify.droppedFields,
      ungroundedFields: verify.ungroundedFields,
      confidenceMap: verify.confidenceMap,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    const c = verify.verifiedCard;
    log.info(`Extracted system card from ${url}`);
    log.info(`  lab: ${extract.lab ?? '(unrecognized)'}`);
    log.info(`  source format: ${extract.sourceFormat}  hash: ${extract.sourceHash.slice(0, 16)}…`);
    log.info(`  LLM: ${extract.extractionModel}  tokens: in=${extract.usage.input_tokens} out=${extract.usage.output_tokens}`);
    log.info(``);
    const row = (k: string, v: unknown) => {
      if (v == null) return;
      const s = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
      log.info(`  ${k.padEnd(26)} ${s.slice(0, 120)}`);
    };
    row('version', c.version);
    row('release_date', c.release_date);
    row('training_cutoff', c.training_cutoff);
    row('parameters_total', c.parameters_total);
    row('parameters_active', c.parameters_active);
    row('context_window_tokens', c.context_window_tokens);
    row('modalities_in', c.modalities_in);
    row('safety_framework', c.safety_framework);
    row('safety_tier', c.safety_tier);
    row('safety_tier_domains', c.safety_tier_domains);
    row('fine_tuning_policy', c.fine_tuning_policy);
    row('deployment_channels', c.deployment_channels);
    row('eval_scores_cited', c.eval_scores_cited ? `${c.eval_scores_cited.length} rows` : null);
    row('third_party_evals', c.third_party_evals ? `${c.third_party_evals.length} rows` : null);
    if (verify.droppedFields.length > 0) {
      log.warn(`Dropped ${verify.droppedFields.length} unverified fields: ${verify.droppedFields.join(', ')}`);
    }
  }

  if (opts.apply) {
    const { syncModelSystemCards } = await import(
      '../lib/wiki-server/model-system-cards.ts'
    );
    const item = toSyncItem(extract, verify, {
      aiModelId: opts.aiModel,
      sourceUrl: url,
    });
    const result = await syncModelSystemCards([item]);
    if (!result.ok) {
      log.error(`Sync failed: ${result.error} — ${result.message}`);
      return { output: '', exitCode: 2 };
    }
    log.info(`✓ Synced to /api/model-system-cards/sync (${JSON.stringify(result.data)})`);
  }

  return { output: '', exitCode: 0 };
}

export const commands = {
  extract: extractCommand,
  default: extractCommand,
};

export function getHelp(): string {
  return `
System Cards — Structured extraction from AI model / system cards (QUA-690)

Subcommands:
  extract <url>    Extract structured fields from a system card URL
                    --ai-model=<entityId>  stableId of the ai-model entity (required)
                    --apply                POST to wiki-server /sync
                    --lab=<key>            override auto-detected lab
                    --model=haiku|sonnet   LLM (default sonnet)
                    --json                 raw JSON output

Examples:
  crux tb system-cards extract https://www.anthropic.com/claude-4-5-system-card \\
      --ai-model=sid_XXXXXXXXXX

  crux tb system-cards extract https://cdn.openai.com/gpt5-system-card.pdf \\
      --ai-model=sid_YYYYYYYYYY --apply
`.trim();
}
