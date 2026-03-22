/**
 * Issue Scoring & Ranking — pure functions for scoring, ranking, and
 * classifying GitHub issues.
 *
 * Extracted from crux/commands/issues.ts to separate business logic
 * from CLI parsing and GitHub API calls.
 *
 * All functions in this module are pure: they take data in and return
 * scores/rankings out, with no I/O or GitHub API calls.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Labels that indicate an issue is blocked or waiting */
const BLOCKED_LABELS = new Set([
  'blocked',
  'waiting',
  'needs-info',
  'needs-response',
  'needs-discussion',
  'waiting-for-upstream',
  'stalled',
]);

/** Patterns in issue body that suggest blocking */
const BLOCKED_BODY_PATTERNS = [
  /\bblocked by\b/i,
  /\bwaiting (for|on)\b/i,
  /\bdepends on #\d+/i,
];

/** Labels indicating this is a bug report */
const BUG_LABELS = new Set(['bug', 'defect', 'regression', 'crash', 'fix']);

/** Labels indicating effort level */
const HIGH_EFFORT_LABELS = new Set(['effort:high', 'large', 'epic', 'size:xl', 'size:l']);
const LOW_EFFORT_LABELS = new Set(['effort:low', 'small', 'size:xs', 'size:s', 'good first issue', 'easy']);

/** Label for human-curated "well-scoped for AI" issues */
const CLAUDE_READY_LABEL = 'claude-ready';

/** Recognized model names for issue recommendations */
const MODEL_NAMES = ['haiku', 'sonnet', 'opus'] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

/** Priority label -> base score */
const PRIORITY_SCORES: Record<string, number> = {
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

/** Legacy priority order (lower = higher priority) -- kept for RankedIssue.priority */
const PRIORITY_LABELS: Record<string, number> = {
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

/** Labels that specify the recommended AI model */
export const MODEL_LABEL_PREFIX = 'model:';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute legacy priority from labels (lower = higher priority).
 * Returns 99 if no priority label is found.
 */
export function issuePriority(labels: string[]): number {
  let best = 99;
  for (const label of labels) {
    const p = PRIORITY_LABELS[label];
    if (p !== undefined && p < best) best = p;
  }
  return best;
}

/**
 * Compute a weighted score for an issue based on labels, body, and timestamps.
 *
 * Score components:
 * - Priority label: P0=1000, P1=500, P2=200, P3=100, unlabeled=50
 * - Bug bonus: +50 for issues labeled 'bug', 'defect', 'regression', etc.
 * - Claude-ready bonus: +50% for issues labeled 'claude-ready'
 * - Effort adjustment: +20 for low-effort, -20 for high-effort
 * - Recency bonus: +15 if updated within 7 days
 * - Age bonus: +1/month since creation (capped at +10)
 */
export function scoreIssue(labels: string[], body: string, createdAt: string, updatedAt: string): ScoreBreakdown {
  // 1. Priority base score
  let priorityScore = 50; // unlabeled default
  for (const label of labels) {
    const s = PRIORITY_SCORES[label];
    if (s !== undefined && s > priorityScore) priorityScore = s;
  }

  // 2. Bug bonus (+50 for bugs -- concrete failures are actionable)
  const bugBonus = labels.some(l => BUG_LABELS.has(l)) ? 50 : 0;

  // 3. Claude-ready multiplier (1.5x, applied after other bonuses)
  const isClaudeReady = labels.includes(CLAUDE_READY_LABEL);

  // 4. Effort adjustment
  let effortAdjustment = 0;
  if (labels.some(l => LOW_EFFORT_LABELS.has(l))) effortAdjustment = +20;
  else if (labels.some(l => HIGH_EFFORT_LABELS.has(l))) effortAdjustment = -20;

  // 5. Recency bonus (+15 if updated within 7 days -- someone cares about it)
  const daysSinceUpdate = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  const recencyBonus = daysSinceUpdate <= 7 ? 15 : 0;

  // 6. Age bonus (older issues get up to +10 -- avoid starvation)
  const daysSinceCreate = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const ageBonus = Math.min(10, Math.floor(daysSinceCreate / 30)); // +1 per month, cap 10

  const baseTotal = priorityScore + bugBonus + effortAdjustment + recencyBonus + ageBonus;
  const claudeReadyBonus = isClaudeReady ? Math.round(baseTotal * 0.5) : 0;
  const total = baseTotal + claudeReadyBonus;

  return {
    priority: priorityScore,
    bugBonus,
    claudeReadyBonus,
    effortAdjustment,
    recencyBonus,
    ageBonus,
    total,
  };
}

// ---------------------------------------------------------------------------
// Blocking detection
// ---------------------------------------------------------------------------

/**
 * Determine whether an issue is blocked based on its labels and body text.
 */
export function isBlocked(labels: string[], body: string): boolean {
  if (labels.some(l => BLOCKED_LABELS.has(l))) return true;
  return BLOCKED_BODY_PATTERNS.some(p => p.test(body));
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Sort issues by weighted score (highest first), with ties broken by age
 * (oldest first).
 */
export function rankIssues(issues: RankedIssue[]): RankedIssue[] {
  return [...issues].sort((a, b) => {
    // Higher score = higher priority
    if (a.score !== b.score) return b.score - a.score;
    // Tiebreak: older issues first
    return a.createdAt.localeCompare(b.createdAt);
  });
}

// ---------------------------------------------------------------------------
// Model extraction
// ---------------------------------------------------------------------------

/**
 * Extract recommended model from labels, issue title, or body (in priority order).
 * Looks for:
 *   - Labels: model:haiku, model:sonnet, model:opus (primary -- machine-readable)
 *   - Body: "## Recommended Model" section header + model name (legacy)
 *   - Title: [haiku], [sonnet], [opus] suffix (legacy)
 */
export function extractModel(title: string, body: string, labels: string[] = []): ModelName | null {
  // Check labels first: model:haiku, model:sonnet, model:opus
  for (const label of labels) {
    const m = label.match(/^model:(haiku|sonnet|opus)$/i);
    if (m) return m[1].toLowerCase() as ModelName;
  }

  // Check body: look for "## Recommended Model" section header + model name
  // Handles blank lines between header and value (e.g., "## Recommended Model\n\n**Sonnet**...")
  const sectionMatch = body.match(/##\s+recommended\s+model[^\n]*\n[\s\S]{0,10}?(haiku|sonnet|opus)/i);
  if (sectionMatch) return sectionMatch[1].toLowerCase() as ModelName;

  // Check title: [haiku], [sonnet], [opus]
  const titleMatch = title.match(/\[(haiku|sonnet|opus)\]/i);
  if (titleMatch) return titleMatch[1].toLowerCase() as ModelName;

  return null;
}

// ---------------------------------------------------------------------------
// Issue formatting checks
// ---------------------------------------------------------------------------

/**
 * Check whether an issue body has required sections for a well-formatted issue.
 * Returns a list of missing section names.
 */
export function checkIssueSections(title: string, body: string, labels: string[] = []): string[] {
  const missing: string[] = [];

  // Must have a non-trivial body
  if (body.trim().length < 80) {
    return ['body (too short or empty)'];
  }

  // Must have a problem/description section
  const hasProblem =
    /##\s+(problem|summary|description|context|background)/i.test(body) ||
    body.trim().length > 300; // long freeform body counts
  if (!hasProblem) missing.push('## Problem / ## Summary section');

  // Must have acceptance criteria or checkboxes
  const hasCriteria =
    /##\s+(acceptance\s+criteria|ac|success\s+criteria|definition\s+of\s+done)/i.test(body) ||
    /- \[ \]/.test(body);
  if (!hasCriteria) missing.push('Acceptance Criteria (## section or - [ ] checkboxes)');

  // Must have model recommendation (label, body section, or title tag)
  const hasModel = extractModel(title, body, labels) !== null;
  if (!hasModel) missing.push('Recommended Model (model:haiku/sonnet/opus label, ## section, or [model] in title)');

  return missing;
}

// ---------------------------------------------------------------------------
// Issue body builder
// ---------------------------------------------------------------------------

/**
 * Build a structured issue body from template parameters.
 */
export function buildIssueBody(opts: {
  problem?: string;
  fix?: string;
  depends?: string;
  criteria?: string;
  model?: string;
  cost?: string;
  file?: string;
  evidence?: string;
}): string {
  const sections: string[] = [];

  if (opts.problem) {
    sections.push(`## Problem\n\n${opts.problem}`);
  }

  // Evidence section -- file path and/or concrete observation
  const evidenceParts: string[] = [];
  if (opts.file) evidenceParts.push(`**File:** \`${opts.file}\``);
  if (opts.evidence) evidenceParts.push(opts.evidence);
  if (evidenceParts.length > 0) {
    sections.push(`## Evidence\n\n${evidenceParts.join('\n\n')}`);
  }

  if (opts.fix) {
    sections.push(`## Proposed Fix\n\n${opts.fix}`);
  }

  // Dependencies (only add section if explicitly specified)
  const depsRaw = opts.depends ? opts.depends.split(',').map(d => d.trim()).filter(Boolean) : [];
  if (depsRaw.length > 0) {
    const depLinks = depsRaw.map(d => `#${d.replace('#', '')}`).join(', ');
    sections.push(`## Dependencies\n\nDepends on: ${depLinks}`);
  }

  // Recommended Model
  if (opts.model) {
    const modelName = opts.model.toLowerCase();
    const costNote = opts.cost ? ` Estimated cost: ${opts.cost}.` : '';
    sections.push(`## Recommended Model\n\n**${modelName.charAt(0).toUpperCase() + modelName.slice(1)}** — well-scoped for this model.${costNote}`);
  }

  // Acceptance Criteria
  if (opts.criteria) {
    const items = opts.criteria.split('|').map(s => s.trim()).filter(Boolean);
    const checklist = items.map(item => `- [ ] ${item}`).join('\n');
    sections.push(`## Acceptance Criteria\n\n${checklist}`);
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Find issue pairs with similar titles using word overlap (Jaccard similarity).
 */
export function findPotentialDuplicates(issues: RankedIssue[]): Array<{ a: RankedIssue; b: RankedIssue; similarity: number }> {
  const THRESHOLD = 0.55;
  const results: Array<{ a: RankedIssue; b: RankedIssue; similarity: number }> = [];

  // Stopwords to exclude from comparison
  const stopwords = new Set([
    'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'is', 'are',
    'add', 'fix', 'update', 'all', 'with', 'from', 'new', '--', '\u2014', '-',
  ]);

  function tokenize(title: string): Set<string> {
    return new Set(
      title.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopwords.has(w))
    );
  }

  function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    const intersection = new Set([...a].filter(x => b.has(x)));
    const union = new Set([...a, ...b]);
    return intersection.size / union.size;
  }

  const tokenized = issues.map(i => ({ issue: i, tokens: tokenize(i.title) }));

  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const sim = jaccard(tokenized[i].tokens, tokenized[j].tokens);
      if (sim >= THRESHOLD) {
        results.push({
          a: tokenized[i].issue,
          b: tokenized[j].issue,
          similarity: sim,
        });
      }
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity);
}

// ---------------------------------------------------------------------------
// Section merging
// ---------------------------------------------------------------------------

/**
 * Merge new sections into an existing issue body.
 * Sections with the same heading (e.g. "## Problem") are replaced in-place.
 * New sections that don't exist in the original are appended.
 */
export function mergeSections(existing: string, incoming: string): string {
  // Split a markdown body into sections keyed by heading
  function parseSections(text: string): { key: string; raw: string }[] {
    const sections: { key: string; raw: string }[] = [];
    const lines = text.split('\n');
    let currentKey = '';
    let currentLines: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)/);
      if (headingMatch) {
        if (currentKey || currentLines.length > 0) {
          sections.push({ key: currentKey, raw: currentLines.join('\n') });
        }
        currentKey = headingMatch[1].trim().toLowerCase();
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }
    if (currentKey || currentLines.length > 0) {
      sections.push({ key: currentKey, raw: currentLines.join('\n') });
    }
    return sections;
  }

  const existingSections = parseSections(existing);
  const incomingSections = parseSections(incoming);
  const existingKeys = new Set(existingSections.map(s => s.key));

  // Replace existing sections that match, collect new ones
  const result = existingSections.map(section => {
    const replacement = incomingSections.find(s => s.key && s.key === section.key);
    return replacement ? replacement.raw : section.raw;
  });

  // Append sections that don't exist in the original
  for (const section of incomingSections) {
    if (section.key && !existingKeys.has(section.key)) {
      result.push(section.raw);
    }
  }

  return result.join('\n\n');
}

// ---------------------------------------------------------------------------
// Re-exported constants for consumers
// ---------------------------------------------------------------------------

export { MODEL_NAMES, CLAUDE_READY_LABEL, BUG_LABELS, HIGH_EFFORT_LABELS, LOW_EFFORT_LABELS };
