/**
 * Issue management library — re-exports from sub-modules.
 */

// Types & constants
export type { GitHubIssueResponse, GitHubLabelResponse, ScoreBreakdown, RankedIssue, ModelName } from './types.ts';
export {
  MODEL_NAMES,
  CLAUDE_WORKING_LABEL,
  CLAUDE_WORKING_COLOR,
  CLAUDE_WORKING_DESC,
  SKIP_LABELS,
  BLOCKED_LABELS,
  MODEL_LABEL_PREFIX,
  MODEL_LABEL_COLORS,
  MODEL_LABEL_DESCS,
  MODEL_COLORS,
  CLAUDE_READY_LABEL,
} from './types.ts';

// Scoring & ranking
export { scoreIssue, issuePriority, isBlocked, rankIssues } from './scoring.ts';

// Search
export { stem, tokenize, scoreMatch } from './search.ts';

// Duplicate detection
export { findPotentialDuplicates } from './dedup.ts';

// Formatting & validation
export { checkIssueSections, buildIssueBody, mergeSections, formatScoreBreakdown, formatIssueRow } from './formatting.ts';

// Model extraction & labels
export { extractModel, applyModelLabel, isValidModel } from './models.ts';

// Rate limiting
export { DAILY_CREATE_LIMIT, getCreatesToday, recordCreate } from './rate-limit.ts';
