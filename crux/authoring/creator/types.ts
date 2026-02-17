/**
 * Shared types for the page creator pipeline.
 *
 * All phase functions receive a subset of these context fields.
 * Using Pick<CreatorContext, ...> keeps each function's requirements explicit
 * while eliminating the 12+ near-identical per-module interfaces.
 */

// ============================================================================
// PIPELINE CONTEXT
// ============================================================================

/** Full pipeline context — created once in page-creator.ts and threaded through phases. */
export interface CreatorContext {
  /** Timestamped phase logger: `[HH:MM:SS] [phase] message` */
  log: (phase: string, message: string) => void;

  /** Write a result artifact to the topic's temp directory. Returns the file path. */
  saveResult: (topic: string, filename: string, data: string | object) => string;

  /** Load a previously saved result artifact. Returns null if not found. */
  loadResult?: (topic: string, filename: string) => Record<string, unknown> | null;

  /** Get (or create) the temp directory for a topic. */
  getTopicDir: (topic: string) => string;

  /** Ensure a directory exists (recursive mkdir). */
  ensureDir: (dirPath: string) => void;

  /** Absolute path to the project root. */
  ROOT: string;
}

// ============================================================================
// CONVENIENCE TYPE ALIASES
// ============================================================================

/** Context with logging only. */
export type LogContext = Pick<CreatorContext, 'log'>;

/** Context for research phases (log + saveResult). */
export type ResearchPhaseContext = Pick<CreatorContext, 'log' | 'saveResult'>;

/** Context for phases that also read the topic directory. */
export type TopicPhaseContext = Pick<CreatorContext, 'log' | 'saveResult' | 'getTopicDir'>;

/** Context for deployment/review (needs ROOT + dir operations). */
export type DeployPhaseContext = Pick<CreatorContext, 'ROOT' | 'getTopicDir' | 'ensureDir'>;

/** Context for synthesis (needs ROOT + log). */
export type SynthesisPhaseContext = Pick<CreatorContext, 'log' | 'ROOT'>;

/** Context for validation loops (needs ROOT + log + getTopicDir). */
export type ValidationPhaseContext = Pick<CreatorContext, 'log' | 'ROOT' | 'getTopicDir'>;
