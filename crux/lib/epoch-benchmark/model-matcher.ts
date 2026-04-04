/**
 * Model Matcher — Maps Epoch AI model version strings to our entity stableIds.
 *
 * Epoch model versions use a variety of naming conventions:
 *   - "claude-sonnet-4-6" or "claude-sonnet-4-6_32K" (with config suffixes)
 *   - "gpt-5.4-2026-03-05_xhigh" (with date and effort suffixes)
 *   - "gemini-3.1-pro-preview" (preview suffixes)
 *   - "Qwen3-235B-A22B-Thinking-2507" (community model names)
 *
 * Strategy:
 *   1. Exact match against a manual override table (handles tricky cases)
 *   2. Normalize the Epoch name and try fuzzy prefix matching against our model IDs
 *   3. For each model with multiple Epoch entries (e.g., different config levels),
 *      pick the best score (since we store one score per model per benchmark)
 */

import type { ModelMatch } from "./types.ts";

interface ModelEntity {
  id: string;
  stableId: string;
  title: string;
}

/**
 * Manual override map from Epoch model version prefixes to our entity slugs.
 *
 * The key is a lowercase prefix that's checked against the normalized Epoch
 * model version. The value is our entity ID (slug). Order matters — longer
 * prefixes should come first to avoid ambiguous matches.
 *
 * NOTE: Only add overrides for cases where the automatic matching fails.
 * The automatic matcher handles most cases via prefix matching.
 */
const MANUAL_OVERRIDES: Array<[string, string]> = [
  // Anthropic — Epoch uses API-style names
  ["claude-opus-4-6", "claude-opus-4-6"],
  ["claude-sonnet-4-6", "claude-sonnet-4-6"],
  ["claude-opus-4-5", "claude-opus-4-5"],
  ["claude-sonnet-4-5", "claude-sonnet-4-5"],
  ["claude-haiku-4-5", "claude-haiku-4-5"],
  ["claude-opus-4-1", "claude-opus-4-1"],
  ["claude-opus-4-", "claude-opus-4"],
  ["claude-sonnet-4-", "claude-sonnet-4"],
  ["claude-3-7-sonnet", "claude-3-7-sonnet"],
  ["claude-3-5-sonnet", "claude-3-5-sonnet"],
  ["claude-3-5-haiku", "claude-3-5-haiku"],
  ["claude-3-opus", "claude-3-opus"],
  ["claude-3-sonnet", "claude-3-sonnet"],
  ["claude-3-haiku", "claude-3-haiku"],

  // OpenAI — Epoch uses versioned names like "gpt-5.4-2026-03-05_xhigh"
  // NOTE: GPT-5 family entities may not exist yet in ai-models.yaml.
  // These overrides will silently not match until the entities are added.
  ["gpt-5.4-pro", "gpt-5"], // GPT-5.4 Pro
  ["gpt-5.4", "gpt-5"], // GPT-5.4
  ["gpt-5.3-codex", "gpt-5"], // GPT-5.3 Codex
  ["gpt-5.2", "gpt-5"], // GPT-5.2
  ["gpt-5.1", "gpt-5"], // GPT-5.1
  ["gpt-5-mini", "gpt-5"], // GPT-5 mini
  ["gpt-5-", "gpt-5"], // GPT-5 base
  ["openai/gpt-oss", "gpt-4-1"], // GPT-OSS open-weight — closest entity
  ["gpt-4.1-mini", "gpt-4-1-mini"],
  ["gpt-4.1-nano", "gpt-4-1-nano"],
  ["gpt-4.1", "gpt-4-1"],
  ["gpt-4o-mini", "gpt-4o-mini"],
  ["gpt-4o-", "gpt-4o"],
  ["gpt-4-turbo", "gpt-4-turbo"],
  ["gpt-4-", "gpt-4"],
  ["o4-mini", "o4-mini"],
  ["o3-pro", "o3"], // o3-pro maps to o3 family
  ["o3-mini", "o3-mini"],
  ["o3-", "o3"],
  ["o1-preview", "o1-preview"],
  ["o1-mini", "o1-mini"],
  ["o1-", "o1"],

  // Google — Epoch uses dotted versions, we use dashed
  ["gemini-3.1-pro", "gemini-2-5-pro"], // Gemini 3.1 Pro not in our list yet
  ["gemini-3-pro", "gemini-2-5-pro"],
  ["gemini-3-flash", "gemini-2-5-flash"],
  ["gemini-2.5-pro", "gemini-2-5-pro"],
  ["gemini-2.5-flash", "gemini-2-5-flash"],
  ["gemini-2.0-flash", "gemini-2-0-flash"],
  ["gemini-1.5-pro", "gemini-1-5-pro"],
  ["gemini-1.5-flash", "gemini-1-5-flash"],
  ["gemini-1.0-ultra", "gemini-1-0-ultra"],
  ["gemini-exp", "gemini-2-5-pro"], // experimental versions

  // GLM (Zhipu)
  ["glm-5", "glm-5"], // May not exist yet
  ["glm-4", "glm-4"], // May not exist yet

  // Meta Llama — Epoch uses both "llama-" and "meta-llama-" and size variants
  ["llama-4-scout", "llama-4-scout"],
  ["llama-4-maverick", "llama-4-maverick"],
  ["meta-llama-3.1", "llama-3-1"],
  ["meta-llama-3-", "llama-3"],
  ["llama-3.3", "llama-3-3"],
  ["llama-3.1", "llama-3-1"],
  ["llama-3-", "llama-3"],
  ["llama-2-", "llama-2"],

  // Mistral
  ["mixtral-8x7b", "mixtral-8x7b"],
  ["mistral-large", "mistral-large-2"],
  ["mistral-small", "mistral-large-2"], // map to closest

  // xAI Grok — Epoch uses "grok-4-" for Grok 4
  ["grok-4", "grok-3"], // Grok 4 not in our list yet, map to family
  ["grok-3", "grok-3"],
  ["grok-2", "grok-2"],

  // DeepSeek
  ["deepseek-r1", "deepseek-r1"],
  ["deepseek-v3", "deepseek-v3"],
  ["deepseek-reasoner", "deepseek-r1"],
  ["deepseek-chat", "deepseek-v3"],

  // Qwen (Alibaba) — Epoch uses "qwen3-", "qwen2.5-", etc.
  ["qwen3-", "qwen-3"], // May not exist yet
  ["qwen2.5-", "qwen-2-5"], // May not exist yet
  ["qwen2-", "qwen-2"], // May not exist yet

  // Kimi (Moonshot)
  ["kimi-k2", "kimi-k2"], // May not exist yet
];

/**
 * Build a model matcher from our entity definitions.
 *
 * Returns a function that takes an Epoch model version string and returns
 * a ModelMatch if we can map it, or null if unmatched.
 */
export function buildModelMatcher(
  models: ModelEntity[],
): (epochModelVersion: string) => ModelMatch | null {
  // Build slug → entity lookup
  const slugToEntity = new Map<string, ModelEntity>();
  for (const m of models) {
    slugToEntity.set(m.id, m);
  }

  return (epochModelVersion: string): ModelMatch | null => {
    const normalized = normalizeModelVersion(epochModelVersion);

    // 1. Try manual overrides (prefix match, longest first)
    for (const [prefix, entitySlug] of MANUAL_OVERRIDES) {
      if (normalized.startsWith(prefix)) {
        const entity = slugToEntity.get(entitySlug);
        if (entity) {
          return {
            epochModelVersion,
            entitySlug: entity.id,
            stableId: entity.stableId,
          };
        }
      }
    }

    // 2. Try direct slug match (Epoch name minus suffixes)
    const stripped = stripSuffixes(normalized);
    if (slugToEntity.has(stripped)) {
      const entity = slugToEntity.get(stripped)!;
      return {
        epochModelVersion,
        entitySlug: entity.id,
        stableId: entity.stableId,
      };
    }

    // 3. Try prefix matching against our slugs (longest match wins)
    const sortedSlugs = [...slugToEntity.keys()].sort(
      (a, b) => b.length - a.length,
    );
    for (const slug of sortedSlugs) {
      if (normalized.startsWith(slug)) {
        const entity = slugToEntity.get(slug)!;
        return {
          epochModelVersion,
          entitySlug: entity.id,
          stableId: entity.stableId,
        };
      }
    }

    return null;
  };
}

/**
 * Normalize an Epoch model version string for matching.
 *
 * Transformations:
 *   - Lowercase
 *   - Strip provider prefixes (e.g. "openai/", "fireworks/")
 *   - Normalize dots to dashes in version-like segments that match our slugs
 */
function normalizeModelVersion(version: string): string {
  let v = version.toLowerCase().trim();

  // Strip provider prefixes
  const slashIdx = v.indexOf("/");
  if (slashIdx > 0 && slashIdx < 20) {
    v = v.slice(slashIdx + 1);
  }

  return v;
}

/**
 * Strip configuration/date/effort suffixes from an Epoch model version.
 *
 * Examples:
 *   "claude-sonnet-4-6_32K" → "claude-sonnet-4-6"
 *   "gpt-5.2-2025-12-11_xhigh" → "gpt-5.2"
 *   "claude-opus-4-5-20251101" → "claude-opus-4-5"
 */
function stripSuffixes(version: string): string {
  let v = version;

  // Strip _suffix (config level or context size)
  const underscoreIdx = v.indexOf("_");
  if (underscoreIdx > 0) {
    v = v.slice(0, underscoreIdx);
  }

  // Strip date suffixes like -20251101 or -2025-12-11
  v = v.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  v = v.replace(/-\d{8}$/, "");

  return v;
}

/**
 * Select the best score when a model has multiple entries in a benchmark.
 *
 * Epoch runs benchmarks at different effort levels (_low, _medium, _high, _xhigh).
 * We want the best score for each model.
 *
 * @param higherIsBetter - True for most benchmarks, false for e.g. SimpleQA (lower = fewer errors)
 */
export function pickBestScore(
  scores: Array<{ score: number; epochModelVersion: string }>,
  higherIsBetter: boolean = true,
): { score: number; epochModelVersion: string } {
  return scores.reduce((best, current) => {
    if (higherIsBetter) {
      return current.score > best.score ? current : best;
    }
    return current.score < best.score ? current : best;
  });
}
