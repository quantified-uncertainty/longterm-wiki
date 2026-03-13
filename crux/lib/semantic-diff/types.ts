/**
 * Types for the semantic diff system.
 *
 * Tracks factual claims in AI-modified wiki pages to detect contradictions,
 * unauthorized scope changes, and provide audit trails.
 */

// ---------------------------------------------------------------------------
// Core claim types
// ---------------------------------------------------------------------------

/** Types of factual claims that can be extracted from MDX content. */
export type ClaimType =
  | 'numeric'       // Numbers, statistics, counts
  | 'temporal'      // Dates, years, time-related facts
  | 'causal'        // Cause-effect relationships
  | 'attribution'   // Attributions to people/organizations
  | 'existence'     // Something exists or occurred
  | 'comparison'    // Comparative statements
  | 'definition'    // Definitional claims
  | 'other';        // Uncategorized factual claims

/** Confidence level for a claim extraction. */
export type ExtractionConfidence = 'high' | 'medium' | 'low';

/**
 * A single extracted factual claim from page content.
 */
export interface ExtractedClaim {
  /** The claim text, as a concise assertable statement. */
  text: string;
  /** What type of claim this is. */
  type: ClaimType;
  /** Confidence in extraction quality. */
  confidence: ExtractionConfidence;
  /** Source sentence or paragraph this was extracted from (for verification). */
  sourceContext: string;
  /** Any specific value (number, date, name) that is the core of the claim. */
  keyValue?: string;
}

// ---------------------------------------------------------------------------
// Diff types
// ---------------------------------------------------------------------------

/** Status of a claim in the diff. */
export type ClaimDiffStatus =
  | 'added'    // New claim not in before content
  | 'removed'  // Claim present in before but not after
  | 'changed'  // Similar claim but with different key value or meaning
  | 'unchanged'; // Claim appears in both versions

/**
 * A single entry in a semantic diff.
 */
export interface ClaimDiffEntry {
  status: ClaimDiffStatus;
  /** The claim in the new (after) content. Undefined for 'removed'. */
  newClaim?: ExtractedClaim;
  /** The claim in the old (before) content. Undefined for 'added'. */
  oldClaim?: ExtractedClaim;
  /** If 'changed', a description of what changed. */
  changeDescription?: string;
}

/**
 * Result of diffing two versions of page content.
 */
export interface SemanticDiff {
  /** Number of claims in the before content. */
  claimsBefore: number;
  /** Number of claims in the after content. */
  claimsAfter: number;
  /** Detailed list of changes. */
  entries: ClaimDiffEntry[];
  /** Summary counts. */
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
}

// ---------------------------------------------------------------------------
// Contradiction types
// ---------------------------------------------------------------------------

/** Severity of a contradiction. */
export type ContradictionSeverity = 'high' | 'medium' | 'low';

/**
 * A detected contradiction between two claims.
 */
export interface Contradiction {
  /** The new claim that contradicts something. */
  newClaim: ExtractedClaim;
  /** The existing claim being contradicted. */
  existingClaim: ExtractedClaim;
  /** Why this is a contradiction. */
  reason: string;
  /** How severe is this contradiction. */
  severity: ContradictionSeverity;
}

/**
 * Result of checking for contradictions.
 */
export interface ContradictionResult {
  /** All detected contradictions. */
  contradictions: Contradiction[];
  /** Whether any high-severity contradictions were found. */
  hasHighSeverity: boolean;
  /** Summary of contradiction counts by severity. */
  summary: {
    high: number;
    medium: number;
    low: number;
  };
}

// ---------------------------------------------------------------------------
// Scope checking types
// ---------------------------------------------------------------------------

/**
 * A file that was changed outside the allowed scope.
 */
export interface ScopeViolation {
  /** The file path that was changed. */
  file: string;
  /** Why this is a violation. */
  reason: string;
}

/**
 * Result of a scope check.
 */
export interface ScopeCheckResult {
  /** Whether all changes are within allowed scope. */
  valid: boolean;
  /** Files changed that are within scope. */
  allowedChanges: string[];
  /** Files changed that are outside scope. */
  violations: ScopeViolation[];
}

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

/**
 * A before/after snapshot for audit trail purposes.
 */
export interface ContentSnapshot {
  /** Page ID (entity ID like 'anthropic'). */
  pageId: string;
  /** Timestamp of this snapshot. */
  timestamp: string;
  /** The agent/pipeline that made the change. */
  agent: string;
  /** Tier used for this improvement. */
  tier?: string;
  /** Content before modification. */
  beforeContent: string;
  /** Content after modification. */
  afterContent: string;
  /** Semantic diff result. */
  diff?: SemanticDiff;
  /** Contradictions detected. */
  contradictions?: ContradictionResult;
}

// ---------------------------------------------------------------------------
// Combined result
// ---------------------------------------------------------------------------

/**
 * Combined result of running the full semantic diff pipeline on a page change.
 */
export interface SemanticDiffResult {
  pageId: string;
  timestamp: string;
  diff: SemanticDiff;
  contradictions: ContradictionResult;
  /** Path where the snapshot was stored. */
  snapshotPath?: string;
  /** Overall assessment: 'safe', 'warn', or 'block' */
  assessment: 'safe' | 'warn' | 'block';
  /** Human-readable summary of issues found. */
  issues: string[];
}
