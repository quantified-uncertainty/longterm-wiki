/**
 * Types for the Agent Orchestrator
 *
 * The orchestrator replaces fixed improve/create pipelines with an LLM agent
 * that has modules as tools and decides what to call based on what the page
 * actually needs. See issue #692 and E766 Part 11.
 */

import type { SourceCacheEntry } from '../../lib/section-writer.ts';
import type { ParsedSection, SplitPage } from '../../lib/section-splitter.ts';
import type { CitationAudit } from '../../lib/citation-auditor.ts';

// ---------------------------------------------------------------------------
// Budget & tier configuration
// ---------------------------------------------------------------------------

/** Budget tier for the orchestrator. Maps to different tool-call limits. */
export type OrchestratorTier = 'polish' | 'standard' | 'deep';

/** Budget configuration per tier (from E766 Part 11). */
export interface BudgetConfig {
  /** Human-readable tier name. */
  name: string;
  /** Maximum number of tool calls the agent may make. */
  maxToolCalls: number;
  /** Maximum number of research queries allowed (0 = no research). */
  maxResearchQueries: number;
  /** Tool IDs that are enabled for this tier. */
  enabledTools: string[];
  /** Estimated cost range for the tier. */
  estimatedCost: string;
}

/** Budget configurations per tier. */
export const TIER_BUDGETS: Record<OrchestratorTier, BudgetConfig> = {
  polish: {
    name: 'Polish',
    maxToolCalls: 12,
    maxResearchQueries: 0,
    enabledTools: [
      'read_page', 'get_page_metrics', 'split_into_sections',
      'rewrite_section', 'add_entity_links', 'add_fact_refs', 'validate_content',
    ],
    estimatedCost: '$2-4',
  },
  standard: {
    name: 'Standard',
    maxToolCalls: 20,
    maxResearchQueries: 5,
    enabledTools: [
      'read_page', 'get_page_metrics', 'split_into_sections',
      'run_research', 'rewrite_section', 'audit_citations',
      'add_entity_links', 'add_fact_refs', 'validate_content',
    ],
    estimatedCost: '$5-10',
  },
  deep: {
    name: 'Deep',
    maxToolCalls: 50,
    maxResearchQueries: 15,
    enabledTools: [
      'read_page', 'get_page_metrics', 'split_into_sections',
      'run_research', 'rewrite_section', 'audit_citations',
      'add_entity_links', 'add_fact_refs', 'validate_content',
    ],
    estimatedCost: '$10-25',
  },
};

// ---------------------------------------------------------------------------
// Orchestrator context — mutable state shared across tool calls
// ---------------------------------------------------------------------------

/** Page metadata (matches PageData from page-improver). */
export interface OrchestratorPageData {
  id: string;
  title: string;
  path: string;
  quality?: number;
  readerImportance?: number;
  entityType?: string;
}

/** Cost tracking entry for a single tool call. */
export interface ToolCostEntry {
  toolName: string;
  estimatedCost: number;
  timestamp: number;
}

/**
 * Mutable state maintained across tool calls.
 *
 * Tool handlers are closures over this context — when rewrite_section
 * modifies the content, subsequent read_page calls see the update.
 */
export interface OrchestratorContext {
  /** Page metadata. */
  page: OrchestratorPageData;
  /** Absolute path to the MDX file on disk. */
  filePath: string;
  /** Current page content (mutable — updated by writing tools). */
  currentContent: string;
  /** Original page content (immutable — for diff/rollback). */
  originalContent: string;
  /** Accumulated source cache from research calls. */
  sourceCache: SourceCacheEntry[];
  /** Current page section split (updated when content changes). */
  sections: ParsedSection[] | null;
  /** Split page structure (frontmatter, preamble, sections). */
  splitPage: SplitPage | null;
  /** Number of tool calls made so far. */
  toolCallCount: number;
  /** Number of research queries made so far. */
  researchQueryCount: number;
  /** Accumulated cost entries. */
  costEntries: ToolCostEntry[];
  /** Total estimated cost. */
  totalCost: number;
  /** Budget configuration for this run. */
  budget: BudgetConfig;
  /** Free-text directions from the user. */
  directions: string;
  /** Citation audit results (if audit has been run). */
  citationAudit: CitationAudit[] | null;
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

/** Quality metrics extracted from the current content. */
export interface QualityMetrics {
  wordCount: number;
  footnoteCount: number;
  entityLinkCount: number;
  diagramCount: number;
  tableCount: number;
  sectionCount: number;
  /** Structural quality score (0-100). */
  structuralScore: number;
}

/** Result of a quality gate check. */
export interface QualityGateResult {
  /** Whether the quality gate passed. */
  passed: boolean;
  /** Quality metrics at the time of the check. */
  metrics: QualityMetrics;
  /** Human-readable summary of gaps (fed back to orchestrator). */
  gapSummary: string;
  /** Specific areas needing improvement. */
  gaps: string[];
}

// ---------------------------------------------------------------------------
// Orchestrator options & results
// ---------------------------------------------------------------------------

/** Options for running the orchestrator. */
export interface OrchestratorOptions {
  /** Budget tier (default: 'standard'). */
  tier?: OrchestratorTier;
  /** Free-text improvement directions. */
  directions?: string;
  /** If true, write output to a temp file instead of modifying the page. */
  dryRun?: boolean;
  /** If true, run auto-grading after apply. */
  grade?: boolean;
  /** If true, skip writing a session log to wiki-server. */
  skipSessionLog?: boolean;
  /** Model override for the orchestrator agent (default: Opus). */
  orchestratorModel?: string;
  /** Model override for section writing (default: Sonnet). */
  writerModel?: string;
  /**
   * Mode of operation.
   * - 'improve': improve an existing page (default)
   * - 'create': create a new page
   */
  mode?: 'improve' | 'create';
  /** For create mode: the topic/title of the new page. */
  topic?: string;
}

/** Result of an orchestrator run. */
export interface OrchestratorResult {
  /** Page ID. */
  pageId: string;
  /** Page title. */
  title: string;
  /** Budget tier used. */
  tier: OrchestratorTier;
  /** User-specified directions. */
  directions: string;
  /** Wall-clock duration in seconds. */
  duration: string;
  /** Number of tool calls made. */
  toolCallCount: number;
  /** Number of refinement cycles (quality gate re-entries). */
  refinementCycles: number;
  /** Total estimated cost. */
  totalCost: number;
  /** Per-tool cost breakdown. */
  costBreakdown: Record<string, number>;
  /** Final quality metrics. */
  qualityMetrics: QualityMetrics;
  /** Whether the quality gate passed. */
  qualityGatePassed: boolean;
  /** Path to the output file. */
  outputPath: string;
  /** The final improved content (MDX). */
  finalContent: string;
}
