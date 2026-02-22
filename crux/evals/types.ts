/**
 * Shared types for the hallucination detection eval framework.
 *
 * The eval system works by:
 * 1. Taking a "golden" page (known-good content)
 * 2. Injecting specific, documented errors (ErrorManifest)
 * 3. Running detection systems against the corrupted page
 * 4. Measuring whether each injected error was caught (EvalResult)
 */

// ---------------------------------------------------------------------------
// Error injection types
// ---------------------------------------------------------------------------

/** Categories of errors we can inject into pages. */
export type ErrorCategory =
  | 'wrong-number'          // Changed a numeric fact (date, amount, count)
  | 'wrong-attribution'     // Swapped who said/did something
  | 'fabricated-citation'   // Replaced real URL with fake one
  | 'fabricated-claim'      // Added false claim with real but unsupporting citation
  | 'temporal-error'        // Moved event to wrong time period
  | 'exaggeration'          // Inflated a claim (magnitude, role, impact)
  | 'missing-nuance'        // Removed hedging/qualification from a claim
  | 'entity-confusion';     // Swapped details between similar entities

/** A single injected error with full provenance for scoring. */
export interface InjectedError {
  /** Unique ID for this error instance. */
  id: string;
  /** Error category. */
  category: ErrorCategory;
  /** Human-readable description of what was changed. */
  description: string;
  /** The original (correct) text that was replaced. */
  originalText: string;
  /** The corrupted text that replaced the original. */
  corruptedText: string;
  /** Approximate paragraph index (0-based) where the error was injected. */
  paragraphIndex: number;
  /** Section heading under which the error appears (if any). */
  sectionHeading?: string;
  /** Severity: how obvious should this error be to detect? */
  detectability: 'easy' | 'medium' | 'hard';
}

/** Full manifest of all errors injected into a single page. */
export interface ErrorManifest {
  /** Page ID (e.g., "anthropic"). */
  pageId: string;
  /** Original page content (the golden version). */
  originalContent: string;
  /** Corrupted page content with all errors injected. */
  corruptedContent: string;
  /** All injected errors. */
  errors: InjectedError[];
  /** Timestamp of injection. */
  injectedAt: string;
}

// ---------------------------------------------------------------------------
// Detection result types
// ---------------------------------------------------------------------------

/** A finding from a detection system. */
export interface DetectorFinding {
  /** Which detector produced this finding. */
  detector: DetectorName;
  /** What the detector flagged. */
  description: string;
  /** Approximate paragraph index where the finding was located. */
  paragraphIndex?: number;
  /** Section heading where the finding was located. */
  sectionHeading?: string;
  /** The text the detector flagged. */
  flaggedText?: string;
  /** Severity assigned by the detector. */
  severity?: 'critical' | 'warning' | 'info';
  /** Raw detector output for debugging. */
  raw?: unknown;
}

/** Names of detection systems under test. */
export type DetectorName =
  | 'citation-auditor'
  | 'adversarial-review'
  | 'hallucination-risk'
  | 'content-integrity'
  | 'cross-reference-checker';

// ---------------------------------------------------------------------------
// Eval scoring types
// ---------------------------------------------------------------------------

/** Match result for a single injected error. */
export interface ErrorMatch {
  /** The injected error. */
  error: InjectedError;
  /** Whether any detector caught this error. */
  caught: boolean;
  /** Which detectors caught it (empty if not caught). */
  caughtBy: DetectorName[];
  /** The matching findings (empty if not caught). */
  matchingFindings: DetectorFinding[];
}

/** Aggregate scores for a single eval run. */
export interface EvalScores {
  /** Total injected errors. */
  totalErrors: number;
  /** Errors caught by at least one detector. */
  errorsCaught: number;
  /** Recall: errorsCaught / totalErrors. */
  recall: number;
  /** Total findings from all detectors. */
  totalFindings: number;
  /** Findings that matched an injected error. */
  truePositives: number;
  /** Findings that didn't match any injected error. */
  falsePositives: number;
  /** Precision: truePositives / totalFindings. */
  precision: number;
  /** F1 score: harmonic mean of precision and recall. */
  f1: number;
  /** Breakdown by error category. */
  byCategory: Record<ErrorCategory, { total: number; caught: number; recall: number }>;
  /** Breakdown by detector. */
  byDetector: Record<DetectorName, { findings: number; truePositives: number; precision: number }>;
}

/** Full result of an eval run against a single page. */
export interface PageEvalResult {
  /** Page that was tested. */
  pageId: string;
  /** All injected errors and whether they were caught. */
  matches: ErrorMatch[];
  /** All detector findings (including false positives). */
  allFindings: DetectorFinding[];
  /** Aggregate scores. */
  scores: EvalScores;
  /** Timestamp of eval run. */
  runAt: string;
  /** Time taken in ms. */
  durationMs: number;
}

/** Full result of an eval suite run across multiple pages. */
export interface SuiteEvalResult {
  /** Suite name (e.g., "injection", "fake-entity"). */
  suite: string;
  /** Per-page results. */
  pages: PageEvalResult[];
  /** Aggregate scores across all pages. */
  aggregate: EvalScores;
  /** Timestamp. */
  runAt: string;
  /** Total time taken in ms. */
  durationMs: number;
  /** Estimated cost in USD. */
  estimatedCostUsd?: number;
}

// ---------------------------------------------------------------------------
// Fake entity eval types
// ---------------------------------------------------------------------------

/** A test case for the fake entity eval. */
export interface FakeEntityTestCase {
  /** Unique ID for this test case. */
  id: string;
  /** Name of the fake entity. */
  name: string;
  /** Entity type (organization, person, concept, event, risk). */
  entityType: string;
  /** Brief description to feed the research pipeline. */
  description: string;
  /** What a correct system should do. */
  expectedOutcome: 'refuse' | 'empty-research' | 'high-uncertainty';
}

/** Result of a fake entity eval run. */
export interface FakeEntityResult {
  /** The test case. */
  testCase: FakeEntityTestCase;
  /** Did the research phase find anything? */
  researchReturned: boolean;
  /** Number of "sources" found (should be 0 for fake entities). */
  sourceCount: number;
  /** Did the pipeline generate a page? */
  pageGenerated: boolean;
  /** If generated: word count of the output. */
  wordCount?: number;
  /** If generated: how many claims were unsourced? */
  unsourcedClaimCount?: number;
  /** If generated: citation auditor results. */
  auditResult?: { total: number; verified: number; unsupported: number; misattributed: number };
  /** Overall verdict: did the system correctly identify this as fake? */
  passed: boolean;
  /** Explanation of the verdict. */
  explanation: string;
}

// ---------------------------------------------------------------------------
// Adversarial agent types
// ---------------------------------------------------------------------------

/** Finding from an adversarial hunting agent. */
export interface AdversarialFinding {
  /** Page where the finding was discovered. */
  pageId: string;
  /** Agent that produced this finding. */
  agent: AdversarialAgentName;
  /** Category of the finding. */
  category: string;
  /** Severity. */
  severity: 'critical' | 'warning' | 'info';
  /** The claim or text that is problematic. */
  claim: string;
  /** What the agent found (evidence). */
  evidence: string;
  /** Suggested fix. */
  suggestion: string;
  /** Confidence score (0-1). */
  confidence: number;
  /** Section heading where the finding is located. */
  sectionHeading?: string;
  /** Paragraph index. */
  paragraphIndex?: number;
}

/** Names of adversarial hunting agents. */
export type AdversarialAgentName =
  | 'reference-sniffer'
  | 'description-auditor'
  | 'temporal-consistency'
  | 'numeric-verifier'
  | 'cross-reference-checker';

/** Result of an adversarial sweep across pages. */
export interface AdversarialSweepResult {
  /** Pages scanned. */
  pagesScanned: number;
  /** Total findings. */
  totalFindings: number;
  /** Findings by severity. */
  bySeverity: Record<string, number>;
  /** Findings by agent. */
  byAgent: Record<string, number>;
  /** All findings, sorted by severity then confidence. */
  findings: AdversarialFinding[];
  /** Timestamp. */
  runAt: string;
  /** Duration in ms. */
  durationMs: number;
  /** Estimated cost. */
  estimatedCostUsd?: number;
}
