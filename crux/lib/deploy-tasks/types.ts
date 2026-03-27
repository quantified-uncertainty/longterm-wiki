/**
 * Deploy Task Types
 *
 * Structured types for deploy tasks detected from PR diffs.
 * Tasks are deterministically detected (no LLM) based on file change patterns.
 */

export type DeployTaskCategory =
  | "migration" // New Drizzle migration files
  | "manual-migration" // Manual SQL scripts in apps/wiki-server/scripts/
  | "env" // New environment variable references
  | "ci" // GitHub Actions workflow changes
  | "schema" // Drizzle schema changes
  | "config" // Auto-update sources, vercel.json, next.config changes
  | "route" // New wiki-server API routes
  | "build" // Build pipeline changes (build-data.mjs, etc.)
  | "docker"; // Dockerfile or container config changes

export type DeployTaskPhase = "pre-merge" | "post-deploy" | "manual";

export interface DeployTask {
  /** Unique ID for this task (e.g., 'migration-0060') */
  id: string;
  /** Human-readable description */
  description: string;
  /** Category for grouping and ordering */
  category: DeployTaskCategory;
  /** When this task should be executed relative to the deploy */
  phase: DeployTaskPhase;
  /** Shell command to verify this task completed (if automatable) */
  verifyCommand?: string;
  /** Whether this task can be auto-verified or requires human judgment */
  automated: boolean;
  /** File(s) that triggered this detection */
  sourceFiles: string[];
}

export interface DeployTaskDetectionResult {
  /** Tasks detected from the diff */
  tasks: DeployTask[];
  /** Files that were analyzed */
  filesAnalyzed: number;
  /** Detection rules that matched */
  rulesMatched: string[];
  /** Error message if detection failed (e.g., invalid base ref) */
  error?: string;
}
