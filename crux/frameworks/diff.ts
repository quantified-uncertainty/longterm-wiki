/**
 * Framework diff engine (QUA-691 Phase 4).
 *
 * Hybrid structured + LLM-classified diff between two framework versions.
 *
 * Step 1 — Structural diff over threshold rows keyed by
 *   (risk_domain_canonical, tier_sort_order). Emits per-change
 *   atomic items: added, removed, or modified.
 *
 * Step 2 — LLM classifier per diff item. Given before/after snapshots
 *   and the framework context, classifies as one of:
 *     weaker | stronger | rewrite_equivalent |
 *     scope_narrowed | scope_broadened | clarification
 *   plus a short rationale.
 *
 * Step 3 — Aggregation. Sets `weakening_flagged` / `strengthening_flagged`
 *   flags from item classifications. Never auto-publishes a verdict —
 *   all diffs land with `reviewVerdict: "unreviewed"` and public UI
 *   must gate on a human-confirmed verdict.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { parseJsonResponse } from '../lib/anthropic.ts';
import { escapeXml } from '../lib/prompt-utils.ts';
import type { ExtractedThreshold } from './extract.ts';
import type { CanonicalDomain } from './risk-domains.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const CHANGE_TYPES = [
  'threshold_added',
  'threshold_removed',
  'mitigation_softened',
  'mitigation_strengthened',
  'commitment_weakened',
  'commitment_strengthened',
  'scope_narrowed',
  'scope_broadened',
  'eval_changed',
  'clarification',
  'other',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const CLASSIFIER_TAGS = [
  'weaker',
  'stronger',
  'rewrite_equivalent',
  'scope_narrowed',
  'scope_broadened',
  'clarification',
] as const;
export type ClassifierTag = (typeof CLASSIFIER_TAGS)[number];

export const OVERALL_DIRECTIONS = [
  'weaker',
  'stronger',
  'mixed',
  'neutral',
  'rewrite',
] as const;
export type OverallDirection = (typeof OVERALL_DIRECTIONS)[number];

/** Atomic change item produced by the structured diff. */
export interface DiffItem {
  changeType: ChangeType;
  riskDomainCanonical: CanonicalDomain | null;
  beforeSnapshot: ThresholdSnapshot | null;
  afterSnapshot: ThresholdSnapshot | null;
  /** Populated by the LLM classifier. Null before classification. */
  classifierTag: ClassifierTag | null;
  rationale: string | null;
  severity: number | null; // 1-3, set by classifier
}

/** Minimal snapshot of a threshold for before/after comparison. */
export interface ThresholdSnapshot {
  riskDomainCanonical: CanonicalDomain;
  riskDomainLabel: string;
  tierLabel: string;
  tierSortOrder: number;
  triggerDescription: string;
  sourceQuote: string;
  requiredMitigations: Record<string, unknown> | null;
  associatedEvals: Record<string, unknown> | null;
  commitmentLanguage: string | null;
}

/** Aggregate result — one row in `framework_diffs`. */
export interface DiffAggregate {
  items: DiffItem[];
  weakeningFlagged: boolean;
  strengtheningFlagged: boolean;
  neutralChangesCount: number;
  overallDirection: OverallDirection;
  changeSummary: string;
}

// ---------------------------------------------------------------------------
// Step 1 — Structural diff
// ---------------------------------------------------------------------------

function toSnapshot(t: ExtractedThreshold): ThresholdSnapshot {
  return {
    riskDomainCanonical: t.riskDomainCanonical,
    riskDomainLabel: t.riskDomainLabel,
    tierLabel: t.tierLabel,
    tierSortOrder: t.tierSortOrder,
    triggerDescription: t.triggerDescription,
    sourceQuote: t.sourceQuote,
    requiredMitigations: t.requiredMitigations,
    associatedEvals: t.associatedEvals,
    commitmentLanguage: t.commitmentLanguage,
  };
}

function keyFor(t: ThresholdSnapshot): string {
  return `${t.riskDomainCanonical}|${t.tierSortOrder}`;
}

function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return `[${v.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
}

/**
 * Classify a pair of thresholds as added, removed, modified, or identical
 * (returned as null = no diff item emitted).
 */
function pairDelta(
  before: ThresholdSnapshot | null,
  after: ThresholdSnapshot | null,
): DiffItem | null {
  if (!before && after) {
    return {
      changeType: 'threshold_added',
      riskDomainCanonical: after.riskDomainCanonical,
      beforeSnapshot: null,
      afterSnapshot: after,
      classifierTag: null,
      rationale: null,
      severity: null,
    };
  }
  if (before && !after) {
    return {
      changeType: 'threshold_removed',
      riskDomainCanonical: before.riskDomainCanonical,
      beforeSnapshot: before,
      afterSnapshot: null,
      classifierTag: null,
      rationale: null,
      severity: null,
    };
  }
  if (!before || !after) return null;

  // Both present → check whether they differ.
  const identical =
    before.triggerDescription === after.triggerDescription &&
    before.tierLabel === after.tierLabel &&
    before.riskDomainLabel === after.riskDomainLabel &&
    before.commitmentLanguage === after.commitmentLanguage &&
    stableStringify(before.requiredMitigations) ===
      stableStringify(after.requiredMitigations) &&
    stableStringify(before.associatedEvals) === stableStringify(after.associatedEvals);

  if (identical) return null;

  // Pick the dominant change type for the structural label. The LLM
  // classifier refines this downstream.
  let changeType: ChangeType = 'other';
  const mitigationsChanged =
    stableStringify(before.requiredMitigations) !==
    stableStringify(after.requiredMitigations);
  const evalsChanged =
    stableStringify(before.associatedEvals) !== stableStringify(after.associatedEvals);
  const commitmentChanged = before.commitmentLanguage !== after.commitmentLanguage;

  if (commitmentChanged) {
    // "committed" → "aspirational" = weakened; reverse = strengthened
    const rank: Record<string, number> = {
      informational: 0,
      aspirational: 1,
      conditional: 2,
      committed: 3,
    };
    const b = before.commitmentLanguage ? rank[before.commitmentLanguage] ?? 1 : 1;
    const a = after.commitmentLanguage ? rank[after.commitmentLanguage] ?? 1 : 1;
    if (a < b) changeType = 'commitment_weakened';
    else if (a > b) changeType = 'commitment_strengthened';
    else changeType = 'clarification';
  } else if (evalsChanged) {
    changeType = 'eval_changed';
  } else if (mitigationsChanged) {
    changeType = 'mitigation_softened'; // provisional — classifier refines
  } else {
    changeType = 'clarification';
  }

  return {
    changeType,
    riskDomainCanonical: after.riskDomainCanonical,
    beforeSnapshot: before,
    afterSnapshot: after,
    classifierTag: null,
    rationale: null,
    severity: null,
  };
}

/**
 * Structural diff over two sets of thresholds. Output items still need
 * classifier tags — call `classifyDiffItems()` after this to fill them in.
 */
export function structuralDiff(
  before: ExtractedThreshold[],
  after: ExtractedThreshold[],
): DiffItem[] {
  const beforeMap = new Map<string, ThresholdSnapshot>();
  for (const t of before) beforeMap.set(keyFor(toSnapshot(t)), toSnapshot(t));

  const afterMap = new Map<string, ThresholdSnapshot>();
  for (const t of after) afterMap.set(keyFor(toSnapshot(t)), toSnapshot(t));

  const items: DiffItem[] = [];
  const keys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  for (const k of keys) {
    const item = pairDelta(beforeMap.get(k) ?? null, afterMap.get(k) ?? null);
    if (item) items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Step 2 — LLM classifier
// ---------------------------------------------------------------------------

const CLASSIFIER_SYSTEM = `You are a policy analyst comparing two versions of an AI safety framework's capability threshold.

Your job:
1. Read the <before> and <after> threshold snapshots.
2. Classify the change as exactly one of:
   - weaker: commitments softened, mitigations lifted, scope narrowed to reduce what the lab must do.
   - stronger: commitments tightened, mitigations added, thresholds lowered (more models fall inside).
   - rewrite_equivalent: wording changed but the substantive commitment is the same.
   - scope_narrowed: the rule now applies to fewer situations (could be weaker or clarifying).
   - scope_broadened: the rule now applies to more situations (usually stronger).
   - clarification: wording now clearer; neither stronger nor weaker.
3. Rate severity in [1..3]: 1 = minor, 2 = notable, 3 = major substantive change.
4. Write a 2-3 sentence rationale grounded in the snapshot text.
5. Do not say "weaker" or "stronger" without clear evidence; prefer "clarification" or "rewrite_equivalent" when evidence is thin.

Return ONLY a JSON object: {"classifierTag": "...", "severity": int, "rationale": "..."}. No prose, no markdown.`;

export interface ClassifyOptions {
  /** Override LLM model. Defaults to sonnet. */
  llmModel?: string;
  /** Override client (for testing). */
  client?: Anthropic;
}

/**
 * LLM-classify one diff item. Mutates the input item in place with
 * `classifierTag`, `severity`, and `rationale`.
 */
export async function classifyDiffItem(
  item: DiffItem,
  options: ClassifyOptions = {},
): Promise<void> {
  // Threshold added/removed don't need classification — the changeType
  // already tells the story. Still assign a reasonable tag + severity.
  if (item.changeType === 'threshold_added') {
    item.classifierTag = 'stronger';
    item.rationale = 'New threshold introduced in this version.';
    item.severity = 2;
    return;
  }
  if (item.changeType === 'threshold_removed') {
    item.classifierTag = 'weaker';
    item.rationale = 'Threshold removed from this version.';
    item.severity = 3;
    return;
  }

  const { llmModel = MODELS.sonnet, client: explicitClient } = options;
  const client = explicitClient ?? createLlmClient();

  const user = [
    `Classify the change between these two versions of a single capability threshold.`,
    `Structural change type (hint): ${item.changeType}`,
    `Risk domain: ${item.riskDomainCanonical ?? 'unknown'}`,
    ``,
    `<before>`,
    item.beforeSnapshot
      ? escapeXml(JSON.stringify(item.beforeSnapshot, null, 2))
      : '(not present)',
    `</before>`,
    ``,
    `<after>`,
    item.afterSnapshot
      ? escapeXml(JSON.stringify(item.afterSnapshot, null, 2))
      : '(not present)',
    `</after>`,
    ``,
    `Return {"classifierTag": one of [${CLASSIFIER_TAGS.join(', ')}], "severity": int in [1,3], "rationale": string}.`,
  ].join('\n');

  const response = await callLlm(
    client,
    { system: CLASSIFIER_SYSTEM, user },
    { model: llmModel, maxTokens: 500, temperature: 0, retryLabel: 'framework-diff-classify' },
  );

  const parsed = parseJsonResponse(response.text);
  const rec = parsed as Record<string, unknown>;
  const tag = typeof rec?.classifierTag === 'string' ? rec.classifierTag : null;
  if (tag && (CLASSIFIER_TAGS as readonly string[]).includes(tag)) {
    item.classifierTag = tag as ClassifierTag;
  } else {
    item.classifierTag = 'clarification';
  }

  const sevRaw = rec?.severity;
  const sev = typeof sevRaw === 'number' ? Math.floor(sevRaw) : 1;
  item.severity = Math.max(1, Math.min(3, sev));

  const rationale = typeof rec?.rationale === 'string' ? rec.rationale : null;
  item.rationale = rationale ? rationale.slice(0, 2000) : '(classifier returned no rationale)';
}

/**
 * Classify every un-classified diff item in sequence. Kept sequential to
 * avoid bursting the LLM rate limit on large diffs — diffs for frontier
 * frameworks rarely exceed 20 items.
 */
export async function classifyDiffItems(
  items: DiffItem[],
  options: ClassifyOptions = {},
): Promise<void> {
  for (const item of items) {
    if (item.classifierTag == null) {
      await classifyDiffItem(item, options);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Aggregate
// ---------------------------------------------------------------------------

/**
 * Compose the top-level `framework_diffs` row from classified items.
 * Returns the full aggregate shape including flags and change summary.
 */
export function aggregateDiff(items: DiffItem[]): DiffAggregate {
  let weaker = 0;
  let stronger = 0;
  let neutral = 0;

  for (const item of items) {
    if (item.classifierTag === 'weaker') weaker++;
    else if (item.classifierTag === 'stronger') stronger++;
    else if (item.classifierTag === 'scope_narrowed') weaker++;
    else if (item.classifierTag === 'scope_broadened') stronger++;
    else neutral++;
  }

  const weakeningFlagged = weaker > 0;
  const strengtheningFlagged = stronger > 0;

  let overall: OverallDirection;
  if (items.length === 0) {
    overall = 'neutral';
  } else if (weaker === 0 && stronger === 0) {
    overall = items.length > 10 ? 'rewrite' : 'neutral';
  } else if (weaker > 0 && stronger === 0) {
    overall = 'weaker';
  } else if (stronger > 0 && weaker === 0) {
    overall = 'stronger';
  } else {
    overall = 'mixed';
  }

  const parts: string[] = [];
  parts.push(`${items.length} change(s)`);
  if (weaker > 0) parts.push(`${weaker} weakening`);
  if (stronger > 0) parts.push(`${stronger} strengthening`);
  if (neutral > 0) parts.push(`${neutral} neutral`);
  const changeSummary = `${parts.join('; ')} (unreviewed)`;

  return {
    items,
    weakeningFlagged,
    strengtheningFlagged,
    neutralChangesCount: neutral,
    overallDirection: overall,
    changeSummary,
  };
}

/**
 * Convenience: run all three steps in sequence. Takes thresholds directly
 * so callers don't have to stitch the stages together. Uses the LLM in
 * Step 2 by default; pass `{ skipClassifier: true }` to skip it for
 * cheap structural-only diffs (e.g., when human review is imminent).
 */
export async function diffFrameworkVersions(
  before: ExtractedThreshold[],
  after: ExtractedThreshold[],
  options: ClassifyOptions & { skipClassifier?: boolean } = {},
): Promise<DiffAggregate> {
  const items = structuralDiff(before, after);
  if (!options.skipClassifier) {
    await classifyDiffItems(items, options);
  }
  return aggregateDiff(items);
}
