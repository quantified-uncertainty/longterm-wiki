/**
 * Job Handler Types
 *
 * Shared types for the job processing system.
 */

import { z } from 'zod';

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

export const PageImproveParamsSchema = z.object({
  pageId: z.string(),
  tier: z.enum(['polish', 'standard', 'deep']).default('standard'),
  directions: z.string().optional(),
  batchId: z.string().optional(),
  apply: z.boolean().optional(),
});
export type PageImproveParams = z.infer<typeof PageImproveParamsSchema>;

export const PageCreateParamsSchema = z.object({
  title: z.string(),
  tier: z.enum(['budget', 'standard', 'premium']).default('standard'),
  batchId: z.string().optional(),
});
export type PageCreateParams = z.infer<typeof PageCreateParamsSchema>;

export const BatchCommitParamsSchema = z.object({
  batchId: z.string(),
  childJobIds: z.array(z.number()),
  branchName: z.string().optional(),
  prTitle: z.string(),
  prBody: z.string().optional(),
  prLabels: z.array(z.string()).optional(),
});
export type BatchCommitParams = z.infer<typeof BatchCommitParamsSchema>;

export const AutoUpdateDigestParamsSchema = z.object({
  budget: z.number().optional(),
  maxPages: z.number().optional(),
  sources: z.string().optional(),
  dryRun: z.boolean().optional(),
});
export type AutoUpdateDigestParams = z.infer<typeof AutoUpdateDigestParamsSchema>;

export interface ResourceIngestParams {
  /** Resource stableId */
  resourceId: string;
  /** URL to ingest */
  url: string;
  /** Hash of previously fetched content (for change detection) */
  previousContentHash?: string;
}

export interface ResourceEnrichParams {
  /** Resource stableId */
  resourceId: string;
  /** Resource URL */
  url: string;
}

