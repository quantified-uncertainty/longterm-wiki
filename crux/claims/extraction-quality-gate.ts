/**
 * Extraction Quality Gate — pre-insertion quality checks with auto-fix
 *
 * Runs between LLM extraction and DB insertion. Unlike validate-quality.ts
 * (post-hoc auditor that reads from DB), this gate operates on in-memory
 * claims before they're stored.
 *
 * Pipeline: LLM extraction → validate-claim.ts → **quality gate** → DB insert
 *
 * Auto-fixes:
 *   - strip-markup:    Remove MDX/JSX artifacts from claim text
 *   - add-entity-name: Prepend entity name to non-self-contained claims
 *   - add-punctuation:  Add terminal period if missing
 *
 * Rejections (unfixable):
 *   - non-atomic:       Multiple assertions in one claim
 *   - tautological:     Merely defines what the entity is
 *   - too-short:        Claim is under 20 chars after fixes
 *   - duplicate:        Near-duplicate of another claim in the batch
 */

import { isClaimDuplicate } from '../lib/claim-utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GateInput {
  claimText: string;
  claimType: string;
  section?: string;
  [key: string]: unknown;
}

export interface GateResult<T extends GateInput> {
  accepted: T[];
  rejected: Array<T & { rejectReasons: string[] }>;
  autoFixed: Array<{ claim: T; fixes: string[] }>;
  stats: GateStats;
}

export interface GateStats {
  total: number;
  accepted: number;
  rejected: number;
  autoFixedCount: number;
  fixBreakdown: Record<string, number>;
  rejectBreakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Markup stripping (reuses patterns from fix-quality.ts but operates inline)
// ---------------------------------------------------------------------------

const MARKUP_STRIP_RULES: Array<{ pattern: RegExp; replacement: string; label: string }> = [
  // <EntityLink id="...">Text</EntityLink> → Text
  { pattern: /<EntityLink\s+id="[^"]*"(?:\s+[^>]*)?>([^<]*)<\/EntityLink>/g, replacement: '$1', label: 'EntityLink' },
  // <F id="..." /> or <F e="..." f="..." /> → empty
  { pattern: /<F\s+[^>]*\/>/g, replacement: '', label: 'F-tag' },
  // <R id="...">Text</R> → Text
  { pattern: /<R\s+id="[^"]*">[^<]*<\/R>/g, replacement: '', label: 'R-tag' },
  // <Calc>...</Calc> → empty
  { pattern: /<Calc>[^<]*<\/Calc>/g, replacement: '', label: 'Calc' },
  // Remaining self-closing JSX tags
  { pattern: /<\w[\w.]*[^>]*\/>/g, replacement: '', label: 'JSX-self-closing' },
  // Remaining JSX block tags (non-greedy, single-line)
  { pattern: /<(\w[\w.]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g, replacement: '$2', label: 'JSX-block' },
  // MDX comments: {/* ... */}
  { pattern: /\{\/\*[\s\S]*?\*\/\}/g, replacement: '', label: 'MDX-comment' },
  // Curly brace expressions
  { pattern: /\{[^}]+\}/g, replacement: '', label: 'curly-expr' },
  // Escaped dollar signs: \$ → $
  { pattern: /\\\$/g, replacement: '$', label: 'escaped-dollar' },
  // Escaped angle brackets: \< → <
  { pattern: /\\</g, replacement: '<', label: 'escaped-lt' },
  // Bold markdown: **text** → text
  { pattern: /\*\*([^*]+)\*\*/g, replacement: '$1', label: 'bold-markdown' },
  // Markdown links: [text](url) → text
  { pattern: /\[([^\]]+)\]\([^)]+\)/g, replacement: '$1', label: 'markdown-link' },
];

/** Has any MDX/markup content? */
function hasMarkup(text: string): boolean {
  for (const { pattern } of MARKUP_STRIP_RULES) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

/** Strip markup and return cleaned text + list of what was stripped. */
export function stripMarkup(text: string): { cleaned: string; labels: string[] } {
  let cleaned = text;
  const labels: string[] = [];

  for (const { pattern, replacement, label } of MARKUP_STRIP_RULES) {
    pattern.lastIndex = 0;
    if (pattern.test(cleaned)) {
      labels.push(label);
      pattern.lastIndex = 0;
      cleaned = cleaned.replace(pattern, replacement);
    }
  }

  // Collapse multiple spaces and trim
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return { cleaned, labels };
}

// ---------------------------------------------------------------------------
// Self-containment fix — prepend entity name if missing
// ---------------------------------------------------------------------------

/** Escape special regex characters. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Check if claim text mentions the entity. */
export function containsEntityReference(
  text: string,
  entityId: string,
  entityName: string,
): boolean {
  const lower = text.toLowerCase();

  if (entityName.length > 0 && lower.includes(entityName.toLowerCase())) {
    return true;
  }
  if (entityId.length > 0 && lower.includes(entityId.toLowerCase())) {
    return true;
  }
  if (entityId.includes('-')) {
    const slugWords = entityId.split('-').join(' ');
    if (lower.includes(slugWords.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Try to fix a non-self-contained claim by replacing generic references
 * ("the company", "the model", etc.) with the entity name, or by prepending
 * the entity name.
 */
export function fixSelfContainment(
  text: string,
  entityName: string,
): { fixed: string; method: string } | null {
  // Strategy 1: Replace generic references with entity name
  const genericReplacements: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /\bThe company\b/, label: 'the-company' },
    { pattern: /\bthe company\b/, label: 'the-company' },
    { pattern: /\bThe organization\b/, label: 'the-organization' },
    { pattern: /\bthe organization\b/, label: 'the-organization' },
    { pattern: /\bThe platform\b/, label: 'the-platform' },
    { pattern: /\bthe platform\b/, label: 'the-platform' },
    { pattern: /\bThe model\b/, label: 'the-model' },
    { pattern: /\bthe model\b/, label: 'the-model' },
    { pattern: /\bThe institute\b/, label: 'the-institute' },
    { pattern: /\bthe institute\b/, label: 'the-institute' },
    { pattern: /\bThe lab\b/, label: 'the-lab' },
    { pattern: /\bthe lab\b/, label: 'the-lab' },
    { pattern: /\bThe project\b/, label: 'the-project' },
    { pattern: /\bthe project\b/, label: 'the-project' },
  ];

  for (const { pattern, label } of genericReplacements) {
    if (pattern.test(text)) {
      const fixed = text.replace(pattern, entityName);
      return { fixed, method: `replace-${label}` };
    }
  }

  // Strategy 2: If the claim starts with a relative phrase, try prepending
  const relativeStarts = [
    /^However,?\s+/i,
    /^Additionally,?\s+/i,
    /^Furthermore,?\s+/i,
    /^Moreover,?\s+/i,
    /^In contrast,?\s+/i,
    /^In addition,?\s+/i,
    /^Meanwhile,?\s+/i,
    /^Similarly,?\s+/i,
  ];

  for (const pattern of relativeStarts) {
    if (pattern.test(text)) {
      // Remove the relative start and try again
      const stripped = text.replace(pattern, '');
      if (containsEntityReference(stripped, '', entityName)) {
        return { fixed: stripped, method: 'strip-relative-start' };
      }
    }
  }

  // Strategy 3: If starts with "It " or "They ", replace pronoun
  if (/^It\s+/i.test(text)) {
    const fixed = text.replace(/^It\s+/i, `${entityName} `);
    return { fixed, method: 'replace-it-pronoun' };
  }
  if (/^They\s+/i.test(text)) {
    const fixed = text.replace(/^They\s+/i, `${entityName} `);
    return { fixed, method: 'replace-they-pronoun' };
  }

  // Can't auto-fix
  return null;
}

// ---------------------------------------------------------------------------
// Atomicity check — reject multi-fact claims
// ---------------------------------------------------------------------------

/** Check if a claim contains multiple assertions (non-atomic). */
export function isNonAtomic(text: string): string | null {
  // Semicolons splitting independent clauses
  if (/;\s+[A-Z]/.test(text)) {
    return 'semicolon-split';
  }

  // ", and [A-Z]" pattern suggesting multiple facts
  if (/,\s+and\s+(?:also\s+)?[A-Z]/.test(text)) {
    return 'compound-and';
  }

  // Multiple sentences joined by connective adverbs
  if (/\.\s+(?:Additionally|Also|Furthermore|Moreover),?\s+/i.test(text)) {
    return 'connective-multi-sentence';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tautological definition check
// ---------------------------------------------------------------------------

/** Check if the claim merely defines the entity (e.g., "Kalshi is a prediction market"). */
export function isTautologicalDefinition(
  text: string,
  entityId: string,
  entityName: string,
): boolean {
  const lower = text.toLowerCase();
  const entityLower = entityName.toLowerCase();
  const idLower = entityId.toLowerCase();

  const startsWithEntity =
    lower.startsWith(entityLower + ' ') || lower.startsWith(idLower + ' ');
  if (!startsWithEntity) return false;

  const tautologyPattern = new RegExp(
    `^(?:${escapeRegex(entityLower)}|${escapeRegex(idLower)})\\s+(?:is|was)\\s+(?:a|an|the)\\s+`,
    'i',
  );
  if (!tautologyPattern.test(text)) return false;

  const afterEntity = text.replace(tautologyPattern, '');
  const hasSpecifics =
    /\d/.test(afterEntity) ||
    /\b(?:in|from|based|founded|headquartered|located)\b/i.test(afterEntity);

  return !hasSpecifics;
}

// ---------------------------------------------------------------------------
// Main gate function
// ---------------------------------------------------------------------------

export interface GateOptions {
  entityId: string;
  entityName: string;
  /** If true, skip all checks and pass everything through. */
  disabled?: boolean;
}

/**
 * Run the extraction quality gate on a batch of claims.
 *
 * Auto-fixes what it can (markup, self-containment, punctuation).
 * Rejects what it can't (non-atomic, tautological, too short, duplicates).
 *
 * @returns GateResult with accepted, rejected, auto-fixed lists and stats
 */
export function runExtractionQualityGate<T extends GateInput>(
  claims: T[],
  options: GateOptions,
): GateResult<T> {
  const { entityId, entityName, disabled } = options;

  if (disabled) {
    return {
      accepted: [...claims],
      rejected: [],
      autoFixed: [],
      stats: {
        total: claims.length,
        accepted: claims.length,
        rejected: 0,
        autoFixedCount: 0,
        fixBreakdown: {},
        rejectBreakdown: {},
      },
    };
  }

  const accepted: T[] = [];
  const rejected: Array<T & { rejectReasons: string[] }> = [];
  const autoFixed: Array<{ claim: T; fixes: string[] }> = [];
  const fixBreakdown: Record<string, number> = {};
  const rejectBreakdown: Record<string, number> = {};
  const seenTexts: string[] = [];

  for (const claim of claims) {
    let text = claim.claimText;
    const fixes: string[] = [];
    const rejectReasons: string[] = [];

    // --- Auto-fix phase ---

    // Fix 1: Strip markup
    if (hasMarkup(text)) {
      const { cleaned, labels } = stripMarkup(text);
      if (cleaned !== text && cleaned.length >= 10) {
        text = cleaned;
        const fixLabel = `strip-markup(${labels.join(',')})`;
        fixes.push(fixLabel);
        fixBreakdown['strip-markup'] = (fixBreakdown['strip-markup'] ?? 0) + 1;
      }
    }

    // Fix 2: Self-containment — add entity name if missing
    if (!containsEntityReference(text, entityId, entityName)) {
      const result = fixSelfContainment(text, entityName);
      if (result) {
        text = result.fixed;
        fixes.push(`self-contain(${result.method})`);
        fixBreakdown['self-contain'] = (fixBreakdown['self-contain'] ?? 0) + 1;
      } else {
        rejectReasons.push('not-self-contained');
      }
    }

    // Fix 3: Add terminal punctuation if missing
    if (text.length > 0 && !/[.!?]$/.test(text.trim())) {
      text = text.trim() + '.';
      fixes.push('add-period');
      fixBreakdown['add-period'] = (fixBreakdown['add-period'] ?? 0) + 1;
    }

    // --- Reject phase ---

    // Check: non-atomic
    const atomicIssue = isNonAtomic(text);
    if (atomicIssue) {
      rejectReasons.push(`non-atomic(${atomicIssue})`);
    }

    // Check: tautological definition
    if (isTautologicalDefinition(text, entityId, entityName)) {
      rejectReasons.push('tautological');
    }

    // Check: too short after fixes
    if (text.trim().length < 20) {
      rejectReasons.push('too-short');
    }

    // Check: duplicate of an already-accepted claim
    const isDup = seenTexts.some(seen => isClaimDuplicate(text, seen));
    if (isDup) {
      rejectReasons.push('duplicate');
    }

    // --- Decision ---

    if (rejectReasons.length > 0) {
      for (const reason of rejectReasons) {
        const key = reason.split('(')[0];
        rejectBreakdown[key] = (rejectBreakdown[key] ?? 0) + 1;
      }
      rejected.push({ ...claim, rejectReasons });
    } else {
      // Apply fixes to the claim
      const fixedClaim = { ...claim, claimText: text };
      accepted.push(fixedClaim);
      seenTexts.push(text);
      if (fixes.length > 0) {
        autoFixed.push({ claim: fixedClaim, fixes });
      }
    }
  }

  return {
    accepted,
    rejected,
    autoFixed,
    stats: {
      total: claims.length,
      accepted: accepted.length,
      rejected: rejected.length,
      autoFixedCount: autoFixed.length,
      fixBreakdown,
      rejectBreakdown,
    },
  };
}
