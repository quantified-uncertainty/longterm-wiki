/**
 * Semantic Diff — Main Module
 *
 * Orchestrates the full semantic diff pipeline for AI-generated content changes:
 * 1. Extract factual claims from before and after content (via Haiku LLM)
 * 2. Diff claims to find added/removed/changed facts
 * 3. Check for contradictions between new claims and existing page content
 * 4. Store before/after snapshots for audit trail
 *
 * Design principles:
 * - Non-blocking by default: returns 'warn' assessment, never blocks
 *   (blocking may be added later when confidence in the system is established)
 * - Fail-open for analysis (if LLM fails, still write the page with a warning)
 * - Fail-closed for scope checks (scope violations always block)
 * - Cost-conscious: uses Haiku for all LLM calls
 *
 * Usage:
 *   import { runSemanticDiff, checkScope } from './lib/semantic-diff/index.ts';
 *
 *   // After AI modifies page content:
 *   const result = await runSemanticDiff(pageId, beforeContent, afterContent, {
 *     agent: 'auto-update',
 *     tier: 'standard',
 *   });
 *   if (result.assessment !== 'safe') {
 *     console.warn('[semantic-diff]', result.issues.join('\n'));
 *   }
 */

import { extractClaims } from './claim-extractor.ts';
import { diffClaims } from './diff-engine.ts';
import { checkContradictions } from './contradiction-checker.ts';
import { storeSnapshot } from './snapshot-store.ts';
import type { SemanticDiffResult, ExtractedClaim } from './types.ts';

// Re-export sub-modules for direct use
export { extractClaims } from './claim-extractor.ts';
export { diffClaims } from './diff-engine.ts';
export { checkContradictions } from './contradiction-checker.ts';
export { checkScope, checkContentScope, filterContentFiles, detectModifiedFiles } from './scope-checker.ts';
export { storeSnapshot, loadSnapshot, listSnapshots, getLatestSnapshot, getSnapshotsDir } from './snapshot-store.ts';
export type * from './types.ts';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SemanticDiffOptions {
  /** Agent or pipeline that made the change. Default: 'auto-update'. */
  agent?: string;
  /** Tier used for the improvement (e.g., 'polish', 'standard', 'deep'). */
  tier?: string;
  /** Whether to run contradiction checking. Default: true. */
  checkContradictions?: boolean;
  /** Whether to use LLM for contradiction checking. Default: true. */
  useLlmContradictions?: boolean;
  /** Whether to store a snapshot. Default: true. */
  storeSnapshot?: boolean;
  /** Whether to output progress logs. Default: false. */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Assessment logic
// ---------------------------------------------------------------------------

/**
 * Determine the overall assessment level based on diff and contradiction results.
 *
 * Currently:
 * - 'safe': No high-severity contradictions, reasonable claim changes
 * - 'warn': Medium-severity contradictions or unusual claim change ratio
 *
 * A 'block' level may be added in the future when confidence in the
 * system is established. For now, callers should treat 'warn' as
 * informational.
 */
function computeAssessment(
  diff: SemanticDiffResult['diff'],
  contradictions: SemanticDiffResult['contradictions'],
): { assessment: 'safe' | 'warn'; issues: string[] } {
  const issues: string[] = [];

  // High-severity contradictions = warn (not block yet, non-blocking mode)
  if (contradictions.hasHighSeverity) {
    issues.push(
      `${contradictions.summary.high} high-severity contradiction(s) detected. ` +
      `Review before publishing.`
    );
  }

  // Medium-severity contradictions = warn
  if (contradictions.summary.medium > 0) {
    issues.push(
      `${contradictions.summary.medium} medium-severity contradiction(s) detected.`
    );
  }

  // Unusual change ratio: more than 50% of claims changed
  const totalClaims = Math.max(diff.claimsBefore, diff.claimsAfter, 1);
  const changedRatio = (diff.summary.added + diff.summary.removed + diff.summary.changed) / totalClaims;
  if (changedRatio > 0.5 && totalClaims > 5) {
    issues.push(
      `${Math.round(changedRatio * 100)}% of claims changed ` +
      `(${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.changed} modified). ` +
      `Consider reviewing scope of changes.`
    );
  }

  // Many claims removed = potential content loss
  if (diff.summary.removed > 5) {
    issues.push(`${diff.summary.removed} claims removed. Verify important information was not lost.`);
  }

  const assessment = issues.length === 0 ? 'safe' : 'warn';

  return { assessment, issues };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full semantic diff pipeline on a page change.
 *
 * Extracts claims from before/after content, diffs them, checks for
 * contradictions, and stores a snapshot. Returns a structured result
 * with an overall assessment.
 *
 * This function is designed to be non-blocking — it will always return
 * a result even if individual steps fail (with appropriate warnings).
 *
 * @param pageId - The page entity ID (e.g., 'anthropic', 'miri')
 * @param beforeContent - Raw MDX content before the AI modification
 * @param afterContent - Raw MDX content after the AI modification
 * @param options - Configuration options
 */
export async function runSemanticDiff(
  pageId: string,
  beforeContent: string,
  afterContent: string,
  options: SemanticDiffOptions = {},
): Promise<SemanticDiffResult> {
  const {
    agent = 'auto-update',
    tier,
    checkContradictions: doCheckContradictions = true,
    useLlmContradictions = true,
    storeSnapshot: doStoreSnapshot = true,
    verbose = false,
  } = options;

  const timestamp = new Date().toISOString();

  if (verbose) {
    console.log(`[semantic-diff] Analyzing changes for ${pageId}...`);
  }

  // Step 1: Extract claims from both versions
  let beforeClaims: ExtractedClaim[] = [];
  let afterClaims: ExtractedClaim[] = [];

  try {
    if (verbose) console.log('[semantic-diff] Extracting claims from before content...');
    beforeClaims = await extractClaims(beforeContent);
    if (verbose) console.log(`[semantic-diff] Found ${beforeClaims.length} claims in before content`);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(`[semantic-diff] Before-content claim extraction failed: ${error.message}`);
  }

  try {
    if (verbose) console.log('[semantic-diff] Extracting claims from after content...');
    afterClaims = await extractClaims(afterContent);
    if (verbose) console.log(`[semantic-diff] Found ${afterClaims.length} claims in after content`);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(`[semantic-diff] After-content claim extraction failed: ${error.message}`);
  }

  // Step 2: Diff the claims
  const diff = diffClaims(beforeClaims, afterClaims);

  if (verbose) {
    console.log(
      `[semantic-diff] Diff: +${diff.summary.added} added, -${diff.summary.removed} removed, ` +
      `~${diff.summary.changed} changed, =${diff.summary.unchanged} unchanged`
    );
  }

  // Step 3: Check for contradictions (only on added/changed claims)
  let contradictionResult: SemanticDiffResult['contradictions'] = {
    contradictions: [],
    hasHighSeverity: false,
    summary: { high: 0, medium: 0, low: 0 },
  };

  if (doCheckContradictions) {
    // Only check new/changed claims against existing claims
    const newAndChangedClaims = [
      ...diff.entries
        .filter(e => e.status === 'added')
        .map(e => e.newClaim!),
      ...diff.entries
        .filter(e => e.status === 'changed')
        .map(e => e.newClaim!),
    ];

    if (newAndChangedClaims.length > 0 && beforeClaims.length > 0) {
      try {
        if (verbose) console.log(`[semantic-diff] Checking ${newAndChangedClaims.length} new/changed claims for contradictions...`);
        contradictionResult = await checkContradictions(
          newAndChangedClaims,
          beforeClaims,
          { useLlm: useLlmContradictions },
        );
        if (verbose) {
          console.log(
            `[semantic-diff] Contradictions: ${contradictionResult.summary.high} high, ` +
            `${contradictionResult.summary.medium} medium, ${contradictionResult.summary.low} low`
          );
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.warn(`[semantic-diff] Contradiction check failed: ${error.message}`);
      }
    }
  }

  // Step 4: Compute assessment
  const { assessment, issues } = computeAssessment(diff, contradictionResult);

  // Step 5: Store snapshot
  let snapshotPath: string | undefined;
  if (doStoreSnapshot) {
    const stored = storeSnapshot(pageId, beforeContent, afterContent, {
      agent,
      tier,
      diff,
      contradictions: contradictionResult,
    });
    snapshotPath = stored ?? undefined;

    if (verbose && snapshotPath) {
      console.log(`[semantic-diff] Snapshot stored: ${snapshotPath}`);
    }
  }

  const result: SemanticDiffResult = {
    pageId,
    timestamp,
    diff,
    contradictions: contradictionResult,
    snapshotPath,
    assessment,
    issues,
  };

  // Always log issues at warn level so they appear in pipeline output
  if (issues.length > 0) {
    console.warn(`[semantic-diff] ${pageId}: ${assessment.toUpperCase()} — ${issues.join(' | ')}`);
  } else if (verbose) {
    console.log(`[semantic-diff] ${pageId}: SAFE`);
  }

  return result;
}
