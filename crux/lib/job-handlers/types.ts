/**
 * Job Handler Types
 *
 * Shared types for the job processing system.
 */

// ---------------------------------------------------------------------------
// File Change — the unit of work output from content-modifying jobs
// ---------------------------------------------------------------------------

export interface FileChange {
  /** Relative path from project root (e.g., "content/docs/concepts/ai-safety.mdx") */
  path: string;
  /** Full file content after modification. null means file was deleted. */
  content: string | null;
}

// ---------------------------------------------------------------------------
// Job Handler interface
// ---------------------------------------------------------------------------

export interface JobHandlerContext {
  /** Unique worker identifier (e.g., "gha-12345-worker-1") */
  workerId: string;
  /** Project root directory */
  projectRoot: string;
  /** Whether to print verbose output */
  verbose: boolean;
}

export interface JobHandlerResult {
  /** Whether the job succeeded */
  success: boolean;
  /** Structured result data (stored in job.result) */
  data: Record<string, unknown>;
  /** Error message if failed */
  error?: string;
}

export type JobHandler = (
  params: Record<string, unknown>,
  context: JobHandlerContext,
) => Promise<JobHandlerResult>;

// ---------------------------------------------------------------------------
// Batch-related types
// ---------------------------------------------------------------------------

export interface BatchInfo {
  /** Unique batch identifier (e.g., "auto-update-2026-02-22") */
  batchId: string;
  /** Job IDs belonging to this batch */
  childJobIds: number[];
  /** Type of batch (determines commit behavior) */
  batchType: 'auto-update' | 'bulk-create' | 'bulk-improve';
  /** Human-readable description for PR title */
  description: string;
}

// ---------------------------------------------------------------------------
// Content job params
// ---------------------------------------------------------------------------

export interface PageImproveParams {
  pageId: string;
  tier: 'polish' | 'standard' | 'deep';
  directions?: string;
  batchId?: string;
  /** Whether to apply changes directly (default: true) */
  apply?: boolean;
}

export interface PageCreateParams {
  title: string;
  tier: 'budget' | 'standard' | 'premium';
  batchId?: string;
}

export interface BatchCommitParams {
  batchId: string;
  /** Job IDs to collect results from */
  childJobIds: number[];
  /** Branch name to create (default: auto-generated) */
  branchName?: string;
  /** PR title */
  prTitle: string;
  /** PR body description */
  prBody?: string;
  /** Labels to add to the PR */
  prLabels?: string[];
}

export interface AutoUpdateDigestParams {
  /** Max budget in dollars */
  budget?: number;
  /** Max pages to update */
  maxPages?: number;
  /** Comma-separated source IDs (empty = all) */
  sources?: string;
  /** Whether this is a dry run (no child jobs created) */
  dryRun?: boolean;
}
