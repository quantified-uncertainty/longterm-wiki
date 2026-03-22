/**
 * Shared types and constants for GitHub issue management.
 */

import { LABELS, LABEL_META } from '../labels.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

export interface GitHubLabelResponse {
  name: string;
}

export interface ScoreBreakdown {
  priority: number;
  bugBonus: number;
  claudeReadyBonus: number;
  effortAdjustment: number;
  recencyBonus: number;
  ageBonus: number;
  total: number;
}

export interface RankedIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  url: string;
  priority: number; // 0 = highest (legacy compat)
  score: number; // higher = better
  scoreBreakdown: ScoreBreakdown;
  inProgress: boolean;
  blocked: boolean;
  recommendedModel: ModelName | null;
  missingSections: string[]; // empty = well-formatted
}

// ---------------------------------------------------------------------------
// Model names
// ---------------------------------------------------------------------------

/** Recognized model names for issue recommendations */
export const MODEL_NAMES = ['haiku', 'sonnet', 'opus'] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CLAUDE_WORKING_LABEL = LABELS.AGENT_WORKING;
export const CLAUDE_WORKING_COLOR = LABEL_META[LABELS.AGENT_WORKING].color;
export const CLAUDE_WORKING_DESC = LABEL_META[LABELS.AGENT_WORKING].description;

export const SKIP_LABELS = new Set(['wontfix', 'on-hold', 'invalid', 'duplicate', "won't fix"]);

/** Labels that indicate an issue is blocked or waiting */
export const BLOCKED_LABELS = new Set([
  'blocked',
  'waiting',
  'needs-info',
  'needs-response',
  'needs-discussion',
  'waiting-for-upstream',
  'stalled',
]);

/** Patterns in issue body that suggest blocking */
export const BLOCKED_BODY_PATTERNS = [
  /\bblocked by\b/i,
  /\bwaiting (for|on)\b/i,
  /\bdepends on #\d+/i,
];

/** Labels indicating this is a bug report */
export const BUG_LABELS = new Set(['bug', 'defect', 'regression', 'crash', 'fix']);

/** Labels indicating effort level */
export const HIGH_EFFORT_LABELS = new Set(['effort:high', 'large', 'epic', 'size:xl', 'size:l']);
export const LOW_EFFORT_LABELS = new Set(['effort:low', 'small', 'size:xs', 'size:s', 'good first issue', 'easy']);

/** Label for human-curated "well-scoped for AI" issues */
export const CLAUDE_READY_LABEL = 'claude-ready';

/** Labels that specify the recommended AI model */
export const MODEL_LABEL_PREFIX = 'model:';
export const MODEL_LABEL_COLORS: Record<ModelName, string> = {
  haiku: '1d76db',   // blue
  sonnet: 'e4e669',  // yellow
  opus: '7057ff',    // purple
};
export const MODEL_LABEL_DESCS: Record<ModelName, string> = {
  haiku: 'Recommended for Claude Haiku (fast, cheap)',
  sonnet: 'Recommended for Claude Sonnet (balanced)',
  opus: 'Recommended for Claude Opus (complex tasks)',
};

/** Priority label → base score */
export const PRIORITY_SCORES: Record<string, number> = {
  P0: 1000,
  p0: 1000,
  'priority:critical': 1000,
  P1: 500,
  p1: 500,
  'priority:high': 500,
  P2: 200,
  p2: 200,
  'priority:medium': 200,
  P3: 100,
  p3: 100,
  'priority:low': 100,
};

/** Legacy priority order (lower = higher priority) — kept for RankedIssue.priority */
export const PRIORITY_LABELS: Record<string, number> = {
  P0: 0,
  p0: 0,
  'priority:critical': 0,
  P1: 1,
  p1: 1,
  'priority:high': 1,
  P2: 2,
  p2: 2,
  'priority:medium': 2,
  P3: 3,
  p3: 3,
  'priority:low': 3,
};

/** ANSI colors for model badges */
export const MODEL_COLORS: Record<ModelName, string> = {
  haiku: '\x1b[36m',   // cyan
  sonnet: '\x1b[33m',  // yellow
  opus: '\x1b[35m',    // magenta
};
