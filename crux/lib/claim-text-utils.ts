/**
 * Shared claim text utilities — canonical patterns and helpers used across
 * the claims pipeline (extraction gate, fix-all, fix-quality, quality-report,
 * validate-quality).
 *
 * Previously duplicated in 5+ files. Consolidated here to prevent drift.
 */

// ---------------------------------------------------------------------------
// Markup stripping patterns (superset — used by stripMarkup)
// ---------------------------------------------------------------------------

export interface MarkupRule {
  pattern: RegExp;
  replacement: string;
  label: string;
}

/**
 * Canonical list of markup patterns for stripping MDX/JSX from claim text.
 * Order matters: specific patterns (EntityLink, F-tag) before generic (JSX-block).
 *
 * IMPORTANT: Because these use global regexes, callers must reset lastIndex
 * before each use, or call stripMarkup() which handles this automatically.
 */
export const MARKUP_STRIP_RULES: MarkupRule[] = [
  { pattern: /<EntityLink\s+id="[^"]*"(?:\s+[^>]*)?>([^<]*)<\/EntityLink>/g, replacement: '$1', label: 'EntityLink' },
  { pattern: /<F\s+[^>]*\/>/g, replacement: '', label: 'F-tag' },
  { pattern: /<R\s+id="[^"]*">[^<]*<\/R>/g, replacement: '', label: 'R-tag' },
  { pattern: /<Calc>[^<]*<\/Calc>/g, replacement: '', label: 'Calc' },
  { pattern: /<\w[\w.]*[^>]*\/>/g, replacement: '', label: 'JSX-self-closing' },
  { pattern: /<(\w[\w.]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g, replacement: '$2', label: 'JSX-block' },
  { pattern: /\{\/\*[\s\S]*?\*\/\}/g, replacement: '', label: 'MDX-comment' },
  { pattern: /\{[^}]+\}/g, replacement: '', label: 'curly-expr' },
  { pattern: /^(?:import|export)\s+.*$/gm, replacement: '', label: 'import/export' },
  { pattern: /\\\$/g, replacement: '$', label: 'escaped-dollar' },
  { pattern: /\\</g, replacement: '<', label: 'escaped-lt' },
  { pattern: /\*\*([^*]+)\*\*/g, replacement: '$1', label: 'bold-markdown' },
  { pattern: /\[([^\]]+)\]\([^)]+\)/g, replacement: '$1', label: 'markdown-link' },
];

// ---------------------------------------------------------------------------
// Markup detection patterns (derived from strip rules + extras)
// ---------------------------------------------------------------------------

/**
 * Detection-only patterns for checking if text contains markup.
 * Includes all strip rule types plus additional MDX component patterns.
 * Uses non-global regexes for safe use with .test() and .some().
 */
export const MARKUP_DETECTORS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /<EntityLink\s/, label: 'EntityLink' },
  { pattern: /<F\s+/, label: 'F-tag' },
  { pattern: /<R\s+id="/, label: 'R-tag' },
  { pattern: /<Calc>/, label: 'Calc' },
  { pattern: /<SquiggleEstimate\b/, label: 'SquiggleEstimate' },
  { pattern: /\{\/\*/, label: 'MDX-comment' },
  { pattern: /\{#\w/, label: 'MDX-expression' },
  { pattern: /\\\$/, label: 'escaped-dollar' },
  { pattern: /\\</, label: 'escaped-lt' },
  { pattern: /\{[^}]+\}/, label: 'curly-expr' },
];

// ---------------------------------------------------------------------------
// Strip and detect functions
// ---------------------------------------------------------------------------

/**
 * Strip all known MDX/JSX markup from claim text.
 * Returns the cleaned text and labels of what was stripped.
 */
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
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return { cleaned, labels };
}

/**
 * Check if text contains any known markup patterns.
 * Uses non-global detection patterns (safe for repeated calls).
 */
export function hasMarkup(text: string): boolean {
  return MARKUP_DETECTORS.some(({ pattern }) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Entity reference utilities
// ---------------------------------------------------------------------------

/**
 * Escape special regex characters in a string.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a kebab-case slug to a display name (e.g. "anthropic-ipo" → "Anthropic Ipo").
 */
export function slugToDisplayName(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Check whether claim text references the given entity (by name, ID, or slug words).
 */
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
 * Check if a claim is a tautological definition (e.g. "Anthropic is an AI safety company").
 * Returns true for claims that merely restate what the entity is without adding specifics.
 */
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
