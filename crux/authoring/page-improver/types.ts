/**
 * Types for the page-improver pipeline.
 */

export interface TierConfig {
  name: string;
  cost: string;
  phases: string[];
  description: string;
}

export interface PageData {
  id: string;
  title: string;
  path: string;
  quality?: number;
  readerImportance?: number;
  ratings?: {
    objectivity?: number;
    rigor?: number;
    focus?: number;
    novelty?: number;
    completeness?: number;
    concreteness?: number;
    actionability?: number;
    [key: string]: number | undefined;
  };
}

export interface AnalysisResult {
  currentState?: string;
  gaps?: string[];
  researchNeeded?: string[];
  improvements?: string[];
  entityLinks?: string[];
  objectivityIssues?: string[];
  citations?: unknown;
  raw?: string;
  error?: string;
}

export interface ResearchResult {
  sources: Array<{
    topic: string;
    title: string;
    url: string;
    author?: string;
    date?: string;
    facts: string[];
    relevance: string;
  }>;
  summary?: string;
  raw?: string;
  error?: string;
}

export interface ReviewResult {
  valid: boolean;
  issues: string[];
  suggestions?: string[];
  qualityScore?: number;
  raw?: string;
}

export interface ValidationIssue {
  rule: string;
  count?: number;
  output?: string;
  error?: string;
}

export interface ValidationResult {
  issues: {
    critical: ValidationIssue[];
    quality: ValidationIssue[];
  };
  hasCritical: boolean;
  improvedContent: string;
}

export interface RunAgentOptions {
  model?: string;
  maxTokens?: number;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  systemPrompt?: string;
}

export interface PipelineOptions {
  tier?: string;
  directions?: string;
  dryRun?: boolean;
  grade?: boolean;
  analysisModel?: string;
  researchModel?: string;
  improveModel?: string;
  reviewModel?: string;
  adversarialModel?: string;
  /** Maximum number of adversarial re-research iterations (default: 2). */
  maxAdversarialIterations?: number;
  deep?: boolean;
}

export interface PipelineResults {
  pageId: string;
  title: string;
  tier: string;
  directions: string;
  duration: string;
  phases: string[];
  review: ReviewResult | undefined;
  outputPath: string;
}

export interface TriageResult {
  pageId: string;
  title: string;
  lastEdited: string;
  recommendedTier: 'skip' | 'polish' | 'standard' | 'deep';
  reason: string;
  newDevelopments: string[];
  estimatedCost: string;
  triageCost: string;
}

export type AdversarialGapType =
  | 'fact-density'
  | 'speculation'
  | 'missing-standard-data'
  | 'redundancy'
  | 'source-gap';

export interface AdversarialGap {
  type: AdversarialGapType;
  description: string;
  /** Targeted query to run if re-research is warranted (omit for edit-only gaps). */
  reResearchQuery?: string;
  /** 're-research' = fetch new sources; 'edit' = fix without new data; 'none' = advisory only. */
  actionType: 're-research' | 'edit' | 'none';
}

export interface AdversarialReviewResult {
  gaps: AdversarialGap[];
  /** True if any gap has actionType === 're-research'. */
  needsReResearch: boolean;
  /** Flat list of re-research queries extracted from gaps. */
  reResearchQueries: string[];
  overallAssessment: string;
  raw?: string;
  error?: string;
}

export interface AdversarialLoopResult {
  iterations: number;
  adversarialReview: AdversarialReviewResult;
  /** Research gathered during the re-research loop (merged into existing research). */
  additionalResearch: ResearchResult;
  finalContent: string;
}

export interface ParsedArgs {
  _positional: string[];
  [key: string]: string | boolean | string[];
}
