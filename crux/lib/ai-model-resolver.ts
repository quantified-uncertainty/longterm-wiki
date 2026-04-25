/**
 * AI model name resolver (QUA-692).
 *
 * Maps freeform model names found in third-party evaluation reports
 * ("Claude 3.5 Sonnet (new)", "Claude Sonnet 3.5 upgraded", "GPT-4o",
 * "o1-preview", "claude-3-5-sonnet-20241022") to ai-model entity stableIds
 * from `data/entities/ai-models.yaml`.
 *
 * Strategy (cheap → expensive):
 *   1. Exact match against canonical name (title) or slug
 *   2. Normalized match (lowercase, strip punctuation, drop "(new)", drip
 *      trailing date suffix `-YYYYMMDD`)
 *   3. Token-based subset match (every meaningful token in the candidate
 *      appears in the entity name)
 *
 * Returns up to N candidates ranked by confidence. Callers decide where to
 * cut off — the `match_confidence` column on `third_party_evaluation_models`
 * captures whether the link was exact / fuzzy / manual.
 *
 * Pure ESM, no LLM calls. The dispatch CLI may layer an LLM fallback for
 * ambiguous cases on top of this.
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";

interface AiModelEntry {
  id: string;
  stableId?: string | null;
  title: string;
  modelFamily?: string | null;
  generation?: string | null;
  modelTier?: string | null;
  developer?: string | null;
  releaseDate?: string | null;
  type?: string;
}

export interface ResolveResult {
  /** entities.stable_id of the matched ai-model. */
  stableId: string;
  /** The slug (entities.id). */
  slug: string;
  /** Display title. */
  title: string;
  /** "exact" | "fuzzy" — caller writes this to match_confidence. */
  matchConfidence: "exact" | "fuzzy";
  /** Score in [0, 1]. */
  confidence: number;
  /** Why this matched (for debug / audit). */
  reason: string;
}

let _modelsCache: AiModelEntry[] | null = null;

function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(cur, "data", "entities", "ai-models.yaml"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

/** Load ai-model entries from data/entities/ai-models.yaml. */
export function loadAiModels(yamlPath?: string): AiModelEntry[] {
  if (_modelsCache && !yamlPath) return _modelsCache;
  const resolved =
    yamlPath ?? path.join(findRepoRoot(process.cwd()), "data", "entities", "ai-models.yaml");
  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as AiModelEntry[] | null;
  const list: AiModelEntry[] = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry.id === "string" &&
        typeof entry.title === "string" &&
        entry.type === "ai-model" &&
        entry.stableId
      ) {
        list.push(entry);
      }
    }
  }
  if (!yamlPath) _modelsCache = list;
  return list;
}

/** For testing — clear the in-process cache. */
export function clearAiModelCache(): void {
  _modelsCache = null;
}

/**
 * Normalize a model name string for fuzzy matching.
 *
 * - lowercase
 * - drop content in parentheses ("(new)", "(experimental)")
 * - drop a trailing API date suffix ("-20241022", "-2024-10-22")
 * - drop common filler words ("model", "the", "v")
 * - replace punctuation with spaces
 * - collapse whitespace
 */
export function normalizeName(s: string): string {
  let out = s.toLowerCase();
  out = out.replace(/\([^)]*\)/g, " ");
  out = out.replace(/-\d{8}\b/g, " ");
  out = out.replace(/-\d{4}-\d{2}-\d{2}\b/g, " ");
  out = out.replace(/\b(model|models|the|v)\b/g, " ");
  out = out.replace(/[^\w\s.+/]/g, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/** Tokenize a normalized string. Drops 1-char tokens but keeps numbers. */
function tokenize(s: string): string[] {
  return s
    .split(/[\s/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 || /^\d/.test(t));
}

/**
 * Build all comparable representations of a model entity:
 *   - canonical title (e.g. "Claude 3.5 Sonnet")
 *   - slug (e.g. "claude-3-5-sonnet")
 *   - "<modelFamily> <generation> <modelTier>" composite
 *
 * Returns deduplicated normalized strings.
 */
function entityNormalizedForms(entry: AiModelEntry): string[] {
  const forms = new Set<string>();
  forms.add(normalizeName(entry.title));
  forms.add(normalizeName(entry.id));
  if (entry.modelFamily && entry.generation && entry.modelTier) {
    forms.add(
      normalizeName(`${entry.modelFamily} ${entry.generation} ${entry.modelTier}`),
    );
  }
  if (entry.modelFamily && entry.generation) {
    forms.add(normalizeName(`${entry.modelFamily} ${entry.generation}`));
  }
  // Empty string can show up after normalization; drop it.
  forms.delete("");
  return [...forms];
}

/**
 * Resolve a model name to one or more ai-model stableIds.
 *
 * Returns matches sorted by confidence descending. An empty result means
 * no match was found above the minimum threshold.
 */
export function resolveAiModel(
  rawName: string,
  options: { maxResults?: number; minConfidence?: number; yamlPath?: string } = {},
): ResolveResult[] {
  const { maxResults = 3, minConfidence = 0.6, yamlPath } = options;
  const trimmed = rawName.trim();
  if (trimmed.length === 0) return [];

  const models = loadAiModels(yamlPath);
  const normInput = normalizeName(trimmed);
  const inputTokens = tokenize(normInput);
  if (inputTokens.length === 0) return [];
  const inputTokenSet = new Set(inputTokens);

  const exactResults: ResolveResult[] = [];
  const fuzzyResults: ResolveResult[] = [];

  for (const entry of models) {
    if (!entry.stableId) continue;
    const forms = entityNormalizedForms(entry);

    // Tier 1: exact match against any normalized form.
    if (forms.some((f) => f === normInput)) {
      exactResults.push({
        stableId: entry.stableId,
        slug: entry.id,
        title: entry.title,
        matchConfidence: "exact",
        confidence: 1,
        reason: `exact-match:${entry.id}`,
      });
      continue;
    }

    // Tier 2: token Jaccard similarity (intersection / union). The
    // Jaccard denominator naturally penalizes entities whose name is a
    // tiny subset of the input ("Claude" vs "Claude 3.5 Sonnet") and
    // entities whose name is a superset ("Claude 3.5 Sonnet" vs "Claude").
    let bestScore = 0;
    let bestFormSize = 0;
    for (const form of forms) {
      const formTokens = new Set(tokenize(form));
      if (formTokens.size === 0) continue;
      let overlap = 0;
      for (const tok of inputTokenSet) if (formTokens.has(tok)) overlap++;
      const union = formTokens.size + inputTokenSet.size - overlap;
      const score = union === 0 ? 0 : overlap / union;
      if (score > bestScore) {
        bestScore = score;
        bestFormSize = formTokens.size;
      }
    }
    if (bestScore >= minConfidence) {
      fuzzyResults.push({
        stableId: entry.stableId,
        slug: entry.id,
        title: entry.title,
        matchConfidence: "fuzzy",
        confidence: Number(bestScore.toFixed(2)),
        // Encode form size in the reason so the post-sort tie-breaker can
        // prefer more specific entities. (Sort key below.)
        reason: `token-jaccard:${entry.id}:formSize=${bestFormSize}`,
      });
    }
  }

  // If we found any exact matches, return only those — a fuzzy match on a
  // less-specific entity (umbrella "Claude") is worse than a specific
  // exact match on the right version, never an alternative to it.
  if (exactResults.length > 0) {
    return exactResults.slice(0, maxResults);
  }

  // Sort fuzzy by confidence desc, then by form size desc (specificity
  // tie-breaker), then by slug for deterministic output.
  fuzzyResults.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const formSizeA = parseInt(a.reason.split("formSize=")[1] ?? "0", 10);
    const formSizeB = parseInt(b.reason.split("formSize=")[1] ?? "0", 10);
    if (formSizeB !== formSizeA) return formSizeB - formSizeA;
    return a.slug.localeCompare(b.slug);
  });
  return fuzzyResults.slice(0, maxResults);
}

/**
 * Bulk resolver: given a list of raw model name strings, return the
 * highest-confidence match for each. Strings with no acceptable match are
 * returned as `null` so the caller can route them to the unlinked queue.
 */
export function resolveAiModels(
  names: string[],
  options?: { minConfidence?: number; yamlPath?: string },
): Array<ResolveResult | null> {
  return names.map((name) => {
    const matches = resolveAiModel(name, { ...options, maxResults: 1 });
    return matches[0] ?? null;
  });
}
