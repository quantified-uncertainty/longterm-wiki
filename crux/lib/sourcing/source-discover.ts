/**
 * FactBase Source-Discovery Engine — QUA-926
 *
 * Stateless engine that takes a single fact and returns canonical source URL
 * candidates with confidence scores via Anthropic's web_search tool.
 *
 * Pure read + recommend: no YAML writes, no DB writes, no verdict storage.
 *
 * Usage (real-time, single fact):
 *   const result = await discoverSourceForFact({ entity, fact, property, formattedValue });
 *   // result = { candidates: [...], best: '...' | null, reason: '...', costUsd: 0.04 }
 *
 * Usage (batch — for QUA-933 / QUA-934 wrappers):
 *   const reqs = facts.map(f => buildDiscoveryBatchRequest(buildDiscoveryInput(f)));
 *   const batch = await submitBatch(client, reqs);
 *   const results = await getBatchResults(client, batch.id, reqs);
 *   for (const [customId, response] of results) {
 *     if (response.result.type === 'succeeded') {
 *       const text = extractMessageText(response.result.message);
 *       const parsed = parseDiscoveryResponse(text, threshold);
 *     }
 *   }
 *
 * Library exports:
 *   - buildDiscoveryPrompt(input)         pure prompt builder
 *   - parseDiscoveryResponse(text)        pure JSON parser + validator
 *   - discoverSourceForFact(input, opts)  real-time call (LLM round-trip)
 *   - buildDiscoveryBatchRequest(input)   build a BatchRequest for batch API
 */
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { Entity, Fact, Property } from '../../../packages/factbase/src/types.ts';
import { createLlmClient, runLlmAgent, MODELS } from '../llm.ts';
import { parseAndValidate } from '../json-parsing.ts';
import { CostTracker } from '../cost-tracker.ts';
import { sanitizeBatchCustomId, type BatchRequest } from '../anthropic-batch.ts';

// ── Constants ────────────────────────────────────────────────────────

/** Confidence below which a candidate is not eligible to become `best`. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

/** Hard cap on candidates returned (truncates LLM output if it exceeds this). */
export const MAX_CANDIDATES = 5;

/** Default LLM model — Sonnet for higher-quality reasoning + web_search synthesis. */
export const DEFAULT_DISCOVER_MODEL = MODELS.sonnet;

/** Default web_search uses per call. Keep low to bound cost. */
export const DEFAULT_MAX_WEB_SEARCH_USES = 3;

/** Default max_tokens for the discovery response. */
export const DEFAULT_MAX_TOKENS = 1500;

/** Default agent tool turns (LLM may interleave search + synthesis). */
export const DEFAULT_MAX_TOOL_TURNS = 5;

// ── Types ────────────────────────────────────────────────────────────

/**
 * Input to the discovery engine. Callers should pre-resolve entity, fact,
 * property, and formattedValue from the FactBase graph (matches the shape
 * factbase-sourcing.ts uses).
 */
export interface DiscoverInput {
  entity: Entity;
  fact: Fact;
  property: Property | undefined;
  /** Pre-formatted value (use formatFactValue from packages/factbase). */
  formattedValue: string;
  /**
   * Optional existing source URL. When present, the prompt asks the LLM
   * to evaluate whether this URL is still authoritative — Pieces 2/3
   * (QUA-933 NULL backfill, QUA-934 weak-source replacement) use this
   * for the "is this URL still good?" question.
   */
  existingSourceUrl?: string;
}

/** A single discovered candidate. */
export interface DiscoverCandidate {
  url: string;
  /** 0.0–1.0. Higher = more confident the URL contains the claim verbatim. */
  confidence: number;
  /** 1–2 sentence summary of what the page says about the claim. */
  summary: string;
}

/** Final engine output. */
export interface DiscoverResult {
  candidates: DiscoverCandidate[];
  /** The best URL above the threshold, or null if no candidate qualified. */
  best: string | null;
  /** One-sentence rationale for the pick (or no-pick). */
  reason: string;
  /** USD cost of the LLM call. 0 for batch-mode parsing (cost is on the batch). */
  costUsd: number;
}

/** Real-time call options. */
export interface DiscoverOptions {
  /** Override model (default: sonnet). */
  model?: string;
  /** Confidence threshold for `best` (default: 0.6). */
  threshold?: number;
  /** Max web_search invocations (default: 3). */
  maxWebSearchUses?: number;
  /** Max tokens for the response (default: 1500). */
  maxTokens?: number;
  /** Inject a pre-built client (testing). */
  client?: Anthropic;
}

/** Batch-request build options (for use with the Anthropic Batch API). */
export interface BatchRequestOptions {
  model?: string;
  maxWebSearchUses?: number;
  maxTokens?: number;
  /**
   * Optional custom_id. If omitted, defaults to `discover_<factId>`,
   * sanitized to match Anthropic's [a-zA-Z0-9_-]{1,64} constraint.
   */
  customId?: string;
}

// ── Zod schema for LLM response ──────────────────────────────────────

const CandidateSchema = z.object({
  // Permissive: accept any string. URL well-formedness is filtered by
  // isLikelyUrl() so a single bad row doesn't fail the whole response.
  url: z.string(),
  confidence: z.number().min(0).max(1),
  summary: z.string().optional(),
});

const ResponseSchema = z.object({
  candidates: z.array(CandidateSchema).optional(),
  best: z.union([z.string(), z.null()]).optional(),
  reason: z.string().optional(),
});

type RawResponse = z.infer<typeof ResponseSchema>;

// ── Prompt building ──────────────────────────────────────────────────

/**
 * Build the discovery prompt for one fact. Pure function — no I/O.
 *
 * Exposed separately from {@link discoverSourceForFact} so batch-mode
 * callers (Pieces 2/3) can construct prompts without invoking the LLM.
 */
export function buildDiscoveryPrompt(input: DiscoverInput): string {
  const { entity, fact, property, formattedValue, existingSourceUrl } = input;
  const propertyName = property?.name ?? fact.propertyId;
  const propertyDesc = property?.description ? `\n  Property description: ${property.description}` : '';
  const asOfStr = fact.asOf ? fact.asOf : 'current';
  const notesStr = fact.notes ? `\n  Additional context: ${fact.notes}` : '';

  const existingUrlBlock = existingSourceUrl
    ? `\nExisting source URL (currently linked but possibly weak — evaluate whether it actually contains the claim, and whether better candidates exist):\n  ${existingSourceUrl}\n`
    : '';

  return `You are finding canonical source URL(s) for a specific factual claim. Use the web_search tool to find pages, then judge whether each candidate URL DIRECTLY supports the claim.

Claim:
  Entity: ${entity.name}
  Property: ${propertyName} (${fact.propertyId})${propertyDesc}
  Value: ${formattedValue}
  As of: ${asOfStr}${notesStr}
${existingUrlBlock}
Search strategy:
  - Search for the entity name + property terms + (if temporal) the asOf year
  - Prefer primary sources: official websites, SEC/IRS filings, university profiles, Google Scholar profiles, Wikipedia (when it has citations)
  - For numeric facts, look for the exact figure or a figure that rounds to the claimed value
  - For dates, accept month-level vs day-level matches
  - For people's affiliations, prefer the institution's own page or LinkedIn (if visible)

AVOID as candidates:
  - Aggregator pages that don't cite primaries (Crunchbase summaries, "top X lists" without sourcing)
  - Press releases that don't actually mention this entity by name + this exact value
  - Social media unless the property IS a social handle
  - Pages that mention the entity but never state the specific value

For each candidate URL you found via search, return:
  - url:        the full URL (must start with http:// or https://)
  - confidence: 0.0–1.0 — your judgment on whether the page DIRECTLY supports the claim. Use these calibrations:
                  ≥0.85 = page contains a verbatim or near-verbatim statement of the value
                  0.65–0.84 = page strongly implies the value or contains a value that rounds to it
                  0.40–0.64 = page mentions the entity and topic but the specific value is implicit
                  ≤0.39 = page is on-topic but does not state the value
  - summary:    1–2 sentences quoting or paraphrasing the relevant text from the page

Then pick a single best URL: the highest-confidence candidate ≥ ${DEFAULT_CONFIDENCE_THRESHOLD.toFixed(2)}, or null if none qualifies.

Cap candidates at ${MAX_CANDIDATES}. Skip candidates with confidence < 0.40 entirely.

Respond with ONLY a JSON object (no markdown fences, no commentary):
{
  "candidates": [
    { "url": "https://...", "confidence": 0.85, "summary": "..." }
  ],
  "best": "https://..." | null,
  "reason": "One sentence explaining the pick (or why no candidate qualified)."
}`;
}

// ── Response parsing ─────────────────────────────────────────────────

/**
 * Parse and validate the LLM's JSON response. Pure function.
 *
 * - Strips markdown fences if present
 * - Validates against the response schema (Zod)
 * - Trims candidates above MAX_CANDIDATES
 * - Recomputes `best` from the threshold (don't trust the LLM's pick if it
 *   contradicts the threshold — e.g. LLM picks confidence=0.5 as best when
 *   threshold=0.7)
 * - Returns a fallback shape on parse/validation failure
 *
 * The LLM-provided cost is NOT in the parsed text — callers must add it.
 */
export function parseDiscoveryResponse(
  text: string,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): Omit<DiscoverResult, 'costUsd'> {
  const fallback = (_raw: string, error?: string): RawResponse => ({
    candidates: [],
    best: null,
    reason: error ? `parse error: ${error}` : 'parse error',
  });

  const parsed = parseAndValidate<RawResponse>(text, ResponseSchema, 'source-discover', fallback);
  const parsedReason = parsed.reason ?? '';

  // Cap candidates, fill in default summaries, and filter out garbage URLs.
  const rawCandidates = parsed.candidates ?? [];
  const candidates = rawCandidates
    .filter((c) => isLikelyUrl(c.url))
    .map((c) => ({ url: c.url, confidence: c.confidence, summary: c.summary ?? '' }))
    .slice(0, MAX_CANDIDATES);

  // Deterministic best-selection: highest-confidence candidate at-or-above
  // the threshold wins, regardless of what the LLM picked. The LLM's pick
  // is treated as a hint — if it disagrees with the threshold, we trust
  // the threshold so the engine output is explainable. Ties broken by
  // first appearance (insertion order).
  let best: string | null = null;
  const eligible = candidates.filter((c) => c.confidence >= threshold);
  if (eligible.length > 0) {
    const top = eligible.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    best = top.url;
  }

  // Reason resolution:
  //   - Parse failure: preserve the "parse error: ..." text from fallback
  //   - Empty candidates: preserve LLM's reason (e.g., "no candidates found")
  //     or fall back to a default if absent
  //   - Candidates exist but none above threshold: override with explicit
  //     threshold-failure reason — the LLM's reason may praise a demoted URL
  //   - Best demoted from LLM's pick: override with demotion explanation
  //   - Best matches LLM's pick: preserve LLM's reason
  const parseFailed = parsedReason.startsWith('parse error');
  let reason = parsedReason;
  if (parseFailed) {
    // keep parse error text — don't pretend we ran threshold logic
  } else if (candidates.length === 0) {
    reason = parsedReason || 'no candidates discovered';
  } else if (best === null) {
    reason = `no candidate met the ${threshold.toFixed(2)} confidence threshold`;
  } else if (
    typeof parsed.best === 'string' &&
    parsed.best !== best &&
    !eligible.some((c) => c.url === parsed.best)
  ) {
    reason = `LLM pick was below the ${threshold.toFixed(2)} threshold; selected highest-confidence candidate above threshold instead`;
  }

  return { candidates, best, reason };
}

function isLikelyUrl(s: string): boolean {
  if (typeof s !== 'string') return false;
  return /^https?:\/\/\S+$/i.test(s.trim());
}

// ── Real-time call ───────────────────────────────────────────────────

/**
 * Discover source URL candidates for one fact via a real-time LLM call.
 *
 * Uses Anthropic's `web_search_20250305` server tool — search results are
 * synthesized into the JSON response transparently.
 *
 * Throws if the LLM call fails (caller should catch and decide). On a parse
 * failure, returns a result with empty candidates and a `reason` describing
 * the parse error rather than throwing — this matches the "engine never
 * blocks the wrapper" contract.
 */
export async function discoverSourceForFact(
  input: DiscoverInput,
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const {
    model = DEFAULT_DISCOVER_MODEL,
    threshold = DEFAULT_CONFIDENCE_THRESHOLD,
    maxWebSearchUses = DEFAULT_MAX_WEB_SEARCH_USES,
    maxTokens = DEFAULT_MAX_TOKENS,
    client = createLlmClient(),
  } = options;

  const prompt = buildDiscoveryPrompt(input);
  const tracker = new CostTracker();

  const text = await runLlmAgent(client, prompt, {
    model,
    maxTokens,
    serverTools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: maxWebSearchUses },
    ],
    maxToolTurns: DEFAULT_MAX_TOOL_TURNS,
    retryLabel: `source-discover-${input.fact.id}`,
    costTracker: tracker,
  });

  const parsed = parseDiscoveryResponse(text, threshold);
  return {
    ...parsed,
    costUsd: tracker.totalCost,
  };
}

// ── Batch API support ────────────────────────────────────────────────

/**
 * Build a single Anthropic Batch API request for one fact's discovery call.
 *
 * Pieces 2/3 (QUA-933, QUA-934) call this for every fact, submit the array
 * via `submitBatch`, poll, then feed each response's text into
 * {@link parseDiscoveryResponse}.
 */
export function buildDiscoveryBatchRequest(
  input: DiscoverInput,
  options: BatchRequestOptions = {},
): BatchRequest {
  const {
    model = DEFAULT_DISCOVER_MODEL,
    maxWebSearchUses = DEFAULT_MAX_WEB_SEARCH_USES,
    maxTokens = DEFAULT_MAX_TOKENS,
    customId = sanitizeBatchCustomId(`discover_${input.fact.id}`),
  } = options;

  const prompt = buildDiscoveryPrompt(input);

  return {
    customId,
    params: {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      tools: [
        // Server tool — same as the real-time path uses via runLlmAgent.
        // The Batch API accepts server tools in the same shape.
        { type: 'web_search_20250305', name: 'web_search', max_uses: maxWebSearchUses } as unknown as Anthropic.Messages.Tool,
      ],
    },
  };
}

/**
 * Extract the assistant's text from a Batch API message response.
 *
 * Web-search tool blocks are skipped — only text deltas matter for parsing.
 * Exported so batch consumers can centralize this logic.
 */
export function extractTextFromMessage(message: Anthropic.Messages.Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('');
}
