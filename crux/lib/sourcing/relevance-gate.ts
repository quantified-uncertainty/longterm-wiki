/**
 * Pre-LLM relevance gate — QUA-426.
 *
 * Before calling the LLM to verify a record against source content, check
 * whether the source content even mentions the record's subject (person name,
 * grantee name, company name, etc.). If it doesn't, short-circuit with a
 * `not_applicable` verdict instead of burning LLM tokens on a page that
 * obviously can't confirm or contradict the claim.
 *
 * Example this catches: the Amanda Askell personnel record pointed at
 * `https://anthropic.com/` — the bare Anthropic homepage. The LLM would
 * burn tokens reading the homepage and return `unverifiable 0.95`, adding
 * a noise row to Amanda's rollup. The gate catches this pre-LLM: the
 * homepage contains "Anthropic" but not "Amanda Askell", so the gate
 * records `not_applicable` and moves on.
 *
 * The gate is disabled by default. Set `RELEVANCE_GATE_ENABLED=true` to
 * turn it on. See ticket for rollout notes.
 */

import type { RecordItemData } from './orchestrator-types.ts';
import { isAnySid } from '../../../packages/id-utils/src/index.ts';

/**
 * Pages shorter than this are treated as "not enough content to decide" —
 * the gate passes and the LLM runs normally. Truncated or paywalled pages
 * can legitimately mention the subject in a full version we didn't fetch.
 */
const MIN_CONTENT_LENGTH_FOR_GATE = 500;

/**
 * Subjects shorter than this (after normalization) are too common to
 * substring-match reliably. "Wu", "Li", "Xu", "J" — false positive magnets.
 * Subjects below the threshold are dropped from matching, and if nothing
 * remains the gate passes (runs LLM).
 */
const MIN_SUBJECT_LENGTH = 3;

export interface RelevanceGateResult {
  /** True if the subject was found OR the gate couldn't decide — run the LLM. */
  passed: boolean;
  /** Human-readable reason, stored in evidence reasoning when the gate fires. */
  reason: string;
  /** Subjects that were extracted (for debugging / test assertions). */
  subjects: string[];
}

/**
 * Read the RELEVANCE_GATE_ENABLED env var. Returns false unless explicitly
 * set to `true` / `1`. Kept as a function (not a module constant) so tests
 * can flip the env between calls.
 */
export function isRelevanceGateEnabled(): boolean {
  const v = process.env.RELEVANCE_GATE_ENABLED;
  return v === 'true' || v === '1';
}

/**
 * Normalize a string for substring matching:
 * - Unicode NFC (collapses composed vs. decomposed forms)
 * - lowercase
 * - collapse whitespace
 *
 * We intentionally do NOT strip diacritics — "Lê Viết Quốc" should not
 * falsely match "Le Viet Quoc", and stripping would double the false-match
 * surface without a corresponding correctness win for the AI-safety corpus.
 */
export function normalizeForMatch(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract the list of subject anchor strings for a record.
 *
 * Each string is a candidate "does the source mention this" anchor. The
 * gate passes if ANY anchor is found. Multiple anchors handle the common
 * case of ambiguous personal names ("Wei Li") where the org provides
 * disambiguation, and also the case where display fields are sometimes
 * null — returning an empty list when nothing resolvable is available.
 *
 * Stable-ID-shaped strings and the literal `(unknown)` sentinel are
 * filtered out. The LLM path can't match on "sid_1LcLlMGLbw" anyway, so
 * dropping them just prevents false negatives when unresolved names leak
 * through from item collection.
 */
export function extractSubjects(data: RecordItemData): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (trimmed === '(unknown)') return;
    if (isAnySid(trimmed)) return;
    out.push(trimmed);
  };

  const f = data.fields;
  switch (data.recordType) {
    case 'personnel':
      // Primary: person name. Secondary: org (disambiguates common names).
      push(f.person);
      push(f.org);
      break;
    case 'grant':
      // grantee + funder + grant title; any one is enough
      push(f.grantee);
      push(f.funder);
      push(f.name);
      break;
    case 'funding-round':
      // Round name ("Series B") is useless alone; pair with company via entityDisplayName.
      push(data.entityDisplayName);
      push(f.name);
      break;
    case 'investment':
      // Investment fields don't include names today (amount/round/role only);
      // fall back to entityDisplayName (investor) as the single anchor.
      push(data.entityDisplayName);
      break;
    case 'benchmark-result':
      // modelId + benchmarkId are the paper-title-like strings the source
      // would mention. Both are acceptable anchors.
      push(f.modelId);
      push(f.benchmarkId);
      break;
    default:
      // Record types without subject extractors (division, funding-program,
      // equity-position, policy-stakeholder, publication, entity-event, etc.)
      // return an empty list so the gate passes and the LLM runs as before.
      break;
  }

  return out;
}

/**
 * Run the relevance gate against a single source-content payload.
 *
 * Returns `passed: true` (run the LLM) in these cases:
 * - No extractable subject (we have no anchor to check against)
 * - Content is too short (<500 chars) — may be a truncated scrape
 * - All extracted subjects are too short to substring-match safely
 * - Any subject anchor is present in the content
 *
 * Returns `passed: false` (short-circuit with `not_applicable`) only when:
 * - There is at least one long-enough subject AND
 * - None of the subjects appear in the (long-enough) content
 */
export function runRelevanceGate(
  data: RecordItemData,
  content: string,
): RelevanceGateResult {
  const subjects = extractSubjects(data);

  if (subjects.length === 0) {
    return {
      passed: true,
      reason: 'no_subject_extracted',
      subjects,
    };
  }

  if (content.length < MIN_CONTENT_LENGTH_FOR_GATE) {
    return {
      passed: true,
      reason: `short_content (${content.length} chars)`,
      subjects,
    };
  }

  const normalizedContent = normalizeForMatch(content);
  const matchable = subjects.filter(
    (s) => normalizeForMatch(s).length >= MIN_SUBJECT_LENGTH,
  );

  if (matchable.length === 0) {
    return {
      passed: true,
      reason: 'no_matchable_subject (all subjects too short)',
      subjects,
    };
  }

  for (const subject of matchable) {
    const normalized = normalizeForMatch(subject);
    if (normalizedContent.includes(normalized)) {
      return {
        passed: true,
        reason: `matched:${subject}`,
        subjects,
      };
    }
  }

  return {
    passed: false,
    reason: `no_subject_match (subjects=${matchable.join(' | ')})`,
    subjects,
  };
}
