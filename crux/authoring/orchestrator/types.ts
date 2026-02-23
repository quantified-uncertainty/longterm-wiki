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
    maxToolCalls: 15,
    maxResearchQueries: 0,
    enabledTools: [
      // Core reading/writing
      'read_page', 'get_page_metrics', 'split_into_sections',
      'rewrite_section', 'add_entity_links', 'add_fact_refs', 'validate_content',
      // Low-cost context tools (all $0)
      'query_wiki_context', 'view_edit_history', 'edit_frontmatter', 'create_visual',
    ],
    estimatedCost: '$2-4',
  },
  standard: {
    name: 'Standard',
    maxToolCalls: 25,
    maxResearchQueries: 3,
    enabledTools: [
      // Core reading/writing
      'read_page', 'get_page_metrics', 'split_into_sections',
      'run_research', 'rewrite_section', 'audit_citations',
      'add_entity_links', 'add_fact_refs', 'validate_content',
      // Context & cross-page tools
      'query_wiki_context', 'read_related_page', 'edit_frontmatter',
      'view_edit_history', 'extract_facts', 'create_visual',
      // Cross-reference & linking
      'check_cross_references', 'suggest_cross_links',
      // Citation analysis
      'deep_citation_check',
      // Quality assurance ($0 — regex-only)
      'adversarial_review',
    ],
    estimatedCost: '$4-8',
  },
  deep: {
    name: 'Deep',
    maxToolCalls: 65,
    maxResearchQueries: 8,
    enabledTools: [
      // Core reading/writing
      'read_page', 'get_page_metrics', 'split_into_sections',
      'run_research', 'rewrite_section', 'audit_citations',
      'add_entity_links', 'add_fact_refs', 'validate_content',
      // Context & cross-page tools
      'query_wiki_context', 'read_related_page', 'edit_frontmatter',
      'view_edit_history', 'extract_facts', 'create_visual',
      // Cross-reference & linking
      'check_cross_references', 'suggest_cross_links',
      // Citation analysis
      'deep_citation_check',
      // Quality assurance ($0 — regex-only)
      'adversarial_review',
    ],
    estimatedCost: '$8-18',
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

/** Captured before/after diff for a single section rewrite. */
export interface SectionDiff {
  sectionId: string;
  before: string;
  after: string;
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
  /** Captured section-level diffs from rewrite_section calls. */
  sectionDiffs: SectionDiff[];
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
  /** Structural quality score (0-50, normalized from raw 0-15). */
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
   * AbortSignal for external cancellation (e.g. batch runner timeout).
   * When aborted, the orchestrator should stop at the next tool boundary.
   */
  signal?: AbortSignal;
  /**
   * Mode of operation.
   * - 'improve': improve an existing page (default)
   * - 'create': create a new page
   */
  mode?: 'improve' | 'create';
  /** For create mode: the topic/title of the new page. */
  topic?: string;
  /**
   * When true, save intermediate artifacts (research, citations, costs,
   * section diffs, quality gate results) to the wiki-server DB after the run.
   * Default: true.
   */
  saveArtifacts?: boolean;
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
