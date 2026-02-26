/**
 * Claim Validation — post-extraction quality checks
 *
 * Validates extracted claims for self-containment, formatting, and quality.
 * Used after LLM extraction to catch common quality issues:
 *   - Missing entity names (45.8% of claims historically)
 *   - Relative phrase starts (13.1%)
 *   - Multi-fact bundling (2.4%)
 *   - Vague language (1.3%)
 *
 * Usage:
 *   import { validateClaim, validateClaimBatch } from './validate-claim.ts';
 *   const result = validateClaim(claimText, entityId, entityName);
 *   if (!result.valid) console.warn(result.issues);
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaimValidationResult {
  valid: boolean;
  issues: string[];
  severity: 'reject' | 'warn';
}

export interface ClaimValidationStats {
  total: number;
  valid: number;
  warned: number;
  rejected: number;
  issueBreakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Relative phrases that indicate a non-self-contained claim start. */
const RELATIVE_START_PATTERNS = [
  /^The\s/,
  /^This\s/,
  /^However[,\s]/,
  /^Additionally[,\s]/,
  /^Furthermore[,\s]/,
  /^Moreover[,\s]/,
  /^In contrast[,\s]/,
  /^In addition[,\s]/,
  /^As a result[,\s]/,
  /^Nevertheless[,\s]/,
  /^Nonetheless[,\s]/,
  /^Meanwhile[,\s]/,
  /^Similarly[,\s]/,
  /^Consequently[,\s]/,
];

/** Generic pronouns/references that suggest missing entity names. */
const GENERIC_REFERENCES = [
  /\bthe company\b/i,
  /\bthe organization\b/i,
  /\bthe platform\b/i,
  /\bthe model\b/i,
  /\bthe system\b/i,
  /\bthe tool\b/i,
  /\bthe project\b/i,
  /\bthe institute\b/i,
  /\bthe lab\b/i,
  /\bthe framework\b/i,
];

/** Vague words that indicate low-quality claims when used without specifics. */
const VAGUE_PATTERNS = [
  /\bsignificant(?:ly)?\b/i,
  /\bvarious\b/i,
  /\bseveral\b/i,
  /\bnumerous\b/i,
  /\bmany\b/i,
  /\bsome\b/i,
];

/** Unresolved MDX tags that should have been stripped. */
const MDX_TAG_PATTERN = /<F\s+id="[^"]*"\s*\/>/;

// ---------------------------------------------------------------------------
// Core validation function
// ---------------------------------------------------------------------------

/**
 * Validate a single extracted claim for quality and self-containment.
 *
 * @param claimText    The claim text to validate
 * @param entityId     The page entity ID (e.g., "kalshi")
 * @param entityName   The display name of the entity (e.g., "Kalshi")
 * @returns            Validation result with issues and severity
 */
export function validateClaim(
  claimText: string,
  entityId: string,
  entityName: string,
): ClaimValidationResult {
  const issues: string[] = [];
  let maxSeverity: 'reject' | 'warn' = 'warn';

  const text = claimText.trim();

  // --- Reject checks (hard failures) ---

  // Length bounds: too short or too long
  if (text.length < 20) {
    issues.push(`too-short: claim is ${text.length} chars (min 20)`);
    maxSeverity = 'reject';
  }
  if (text.length > 500) {
    issues.push(`too-long: claim is ${text.length} chars (max 500)`);
    maxSeverity = 'reject';
  }

  // Missing terminal punctuation
  if (text.length > 0 && !/[.!?]$/.test(text)) {
    issues.push('no-terminal-punctuation: claim does not end with . ! or ?');
    maxSeverity = 'reject';
  }

  // Entity name check: the claim must mention the entity by name or ID.
  // We check for the entity name, entity ID (slug), and common variations
  // (e.g., splitting hyphenated slugs into words).
  const hasEntityName = containsEntityReference(text, entityId, entityName);
  if (!hasEntityName) {
    issues.push(`missing-entity-name: claim does not mention "${entityName}" or "${entityId}"`);
    maxSeverity = 'reject';
  }

  // --- Warn checks (quality warnings, not hard failures) ---

  // Relative phrase starts
  for (const pattern of RELATIVE_START_PATTERNS) {
    if (pattern.test(text)) {
      issues.push(`relative-start: claim starts with "${text.split(/\s/)[0]}"`);
      break; // Only report once
    }
  }

  // Generic references (suggests missing entity name)
  for (const pattern of GENERIC_REFERENCES) {
    const match = text.match(pattern);
    if (match) {
      issues.push(`generic-reference: uses "${match[0]}" instead of entity name`);
      break;
    }
  }

  // Unresolved MDX <F> tags
  if (MDX_TAG_PATTERN.test(text)) {
    issues.push('unresolved-mdx: contains unresolved <F> tag');
  }

  // Tautological definition: "X is a/an Y" where X is the entity name
  if (isTautologicalDefinition(text, entityId, entityName)) {
    issues.push(`tautological-definition: claim merely defines what ${entityName} is`);
  }

  // Vague language check — only flag if no specific numbers/dates present
  const hasSpecifics = /\d/.test(text); // has at least one digit
  if (!hasSpecifics) {
    for (const pattern of VAGUE_PATTERNS) {
      if (pattern.test(text)) {
        issues.push(`vague-language: uses "${text.match(pattern)?.[0]}" without specifics`);
        break;
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    severity: maxSeverity,
  };
}

// ---------------------------------------------------------------------------
// Helper: check if claim text contains a reference to the entity
// ---------------------------------------------------------------------------

/**
 * Check if claim text mentions the entity by name, slug, or common variations.
 *
 * Checks (case-insensitive):
 *   1. Full entity name (e.g., "Anthropic")
 *   2. Entity ID/slug (e.g., "anthropic")
 *   3. Slug words for hyphenated slugs (e.g., "sam-altman" → "Sam Altman")
 */
function containsEntityReference(
  text: string,
  entityId: string,
  entityName: string,
): boolean {
  const lower = text.toLowerCase();

  // Check entity name (case-insensitive)
  if (entityName.length > 0 && lower.includes(entityName.toLowerCase())) {
    return true;
  }

  // Check entity ID / slug (case-insensitive)
  if (entityId.length > 0 && lower.includes(entityId.toLowerCase())) {
    return true;
  }

  // For hyphenated slugs like "sam-altman", check for "Sam Altman" (space-separated)
  if (entityId.includes('-')) {
    const slugWords = entityId.split('-').join(' ');
    if (lower.includes(slugWords.toLowerCase())) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helper: detect tautological definitions
// ---------------------------------------------------------------------------

/**
 * Check if a claim is a tautological definition like "X is a/an Y" where X
 * is the entity name. These are low-value claims that don't add information.
 *
 * Examples that match:
 *   "Kalshi is a prediction market platform."
 *   "Anthropic is an AI safety company."
 *
 * Examples that do NOT match:
 *   "Kalshi is valued at $1 billion."  (has numeric specifics)
 *   "Anthropic is headquartered in San Francisco."  (verifiable fact)
 */
function isTautologicalDefinition(
  text: string,
  entityId: string,
  entityName: string,
): boolean {
  const lower = text.toLowerCase();
  const entityLower = entityName.toLowerCase();
  const idLower = entityId.toLowerCase();

  // Check if the claim starts with the entity name followed by "is a/an"
  const startsWithEntity =
    lower.startsWith(entityLower + ' ') ||
    lower.startsWith(idLower + ' ');

  if (!startsWithEntity) return false;

  // Match patterns like "Entity is a/an [descriptive noun phrase]"
  const tautologyPattern = new RegExp(
    `^(?:${escapeRegex(entityLower)}|${escapeRegex(idLower)})\\s+(?:is|was)\\s+(?:a|an|the)\\s+`,
    'i',
  );

  if (!tautologyPattern.test(text)) return false;

  // If the remainder contains specific data (numbers, dates, proper nouns beyond
  // generic descriptions), it's NOT tautological
  const afterEntity = text.replace(tautologyPattern, '');
  const hasSpecifics = /\d/.test(afterEntity) || // numbers
    /\b(?:in|from|based|founded|headquartered|located)\b/i.test(afterEntity); // location/founding facts

  return !hasSpecifics;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Batch validation
// ---------------------------------------------------------------------------

/**
 * Validate a batch of claims and return stats + per-claim results.
 *
 * @param claims      Array of claims with at least claimText
 * @param entityId    The page entity ID
 * @param entityName  The display name of the entity
 * @param strict      If true, filter out claims with reject-severity issues
 * @returns           Object with filtered claims, rejected claims, and stats
 */
export function validateClaimBatch<T extends { claimText: string }>(
  claims: T[],
  entityId: string,
  entityName: string,
  strict = false,
): {
  accepted: T[];
  rejected: Array<T & { validationIssues: string[] }>;
  stats: ClaimValidationStats;
} {
  const accepted: T[] = [];
  const rejected: Array<T & { validationIssues: string[] }> = [];
  const stats: ClaimValidationStats = {
    total: claims.length,
    valid: 0,
    warned: 0,
    rejected: 0,
    issueBreakdown: {},
  };

  for (const claim of claims) {
    const result = validateClaim(claim.claimText, entityId, entityName);

    // Count issues
    for (const issue of result.issues) {
      const issueType = issue.split(':')[0];
      stats.issueBreakdown[issueType] = (stats.issueBreakdown[issueType] ?? 0) + 1;
    }

    if (result.issues.length === 0) {
      stats.valid++;
      accepted.push(claim);
    } else if (result.severity === 'reject' && strict) {
      stats.rejected++;
      rejected.push({ ...claim, validationIssues: result.issues });
    } else {
      // Warn but keep
      if (result.severity === 'reject') {
        stats.rejected++; // Count as rejected in stats even if not filtering
      } else {
        stats.warned++;
      }
      accepted.push(claim);
    }
  }

  return { accepted, rejected, stats };
}
