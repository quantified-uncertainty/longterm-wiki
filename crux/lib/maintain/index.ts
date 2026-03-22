/**
 * Maintenance library — re-exports from sub-modules.
 */

// Types
export type {
  MergedPR,
  SessionLogEntry,
  GitHubIssue,
  CruftItem,
  TriageCategory,
  HealthMetrics,
  FixChainPR,
} from './types.ts';

// Session log parsing
export {
  parseSessionLog,
  parseJsonArray,
  loadSessionLogsSince,
  loadSessionLogsFromFiles,
} from './session-logs.ts';

// Cruft detection
export {
  findTodoComments,
  findLargeFiles,
  findCommentedCode,
  detectAllCruft,
} from './cruft-detection.ts';

// Health metrics
export { collectHealthMetrics } from './health-metrics.ts';
