/**
 * Issue formatting: validation, body templates, section merging, display formatting.
 */

import type { Colors } from '../output.ts';
import type { ScoreBreakdown, RankedIssue, ModelName } from './types.ts';
import {
  CLAUDE_WORKING_LABEL,
  CLAUDE_READY_LABEL,
  MODEL_LABEL_PREFIX,
  MODEL_COLORS,
  MODEL_NAMES,
} from './types.ts';
import { extractModel } from './models.ts';

// ---------------------------------------------------------------------------
// Issue validation
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
// Issue body templates
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

  // Evidence section — file path and/or concrete observation
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
// Display formatting
// ---------------------------------------------------------------------------

export function formatScoreBreakdown(bd: ScoreBreakdown, c: Colors): string {
  const parts: string[] = [];
  parts.push(`priority:${bd.priority}`);
  if (bd.bugBonus) parts.push(`bug:+${bd.bugBonus}`);
  if (bd.claudeReadyBonus) parts.push(`claude-ready:+${bd.claudeReadyBonus}`);
  if (bd.effortAdjustment > 0) parts.push(`effort:+${bd.effortAdjustment}`);
  if (bd.effortAdjustment < 0) parts.push(`effort:${bd.effortAdjustment}`);
  if (bd.recencyBonus) parts.push(`recent:+${bd.recencyBonus}`);
  if (bd.ageBonus) parts.push(`age:+${bd.ageBonus}`);
  return `${c.dim}[score:${bd.total} = ${parts.join(' ')}]${c.reset}`;
}

export function formatIssueRow(issue: RankedIssue, c: Colors, showScores = false): string {
  const priorityLabel = issue.priority < 99 ? `P${issue.priority}` : '  ';
  const inProgressMark = issue.inProgress ? `${c.yellow}[${CLAUDE_WORKING_LABEL}]${c.reset} ` : '';
  const blockedMark = issue.blocked ? `${c.red}[blocked]${c.reset} ` : '';
  const claudeReadyMark = issue.labels.includes(CLAUDE_READY_LABEL) ? `${c.green}[claude-ready]${c.reset} ` : '';
  const labelStr = issue.labels
    .filter(l => l !== CLAUDE_WORKING_LABEL && l !== CLAUDE_READY_LABEL && !l.startsWith(MODEL_LABEL_PREFIX))
    .map(l => `${c.dim}${l}${c.reset}`)
    .join(' ');

  // Model badge
  let modelBadge = '';
  if (issue.recommendedModel) {
    const modelColor = MODEL_COLORS[issue.recommendedModel];
    modelBadge = ` ${modelColor}[${issue.recommendedModel}]${c.reset}`;
  }

  // Format warning for missing sections (dim, only shown with --scores or when explicitly formatting)
  const warningStr = issue.missingSections.length > 0
    ? `${c.dim}  ⚠ missing: ${issue.missingSections.join(', ')}${c.reset}`
    : '';

  let row =
    `  ${c.cyan}#${String(issue.number).padEnd(5)}${c.reset}` +
    `${c.bold}[${priorityLabel}]${c.reset} ` +
    `${inProgressMark}${blockedMark}${claudeReadyMark}${issue.title}${modelBadge}` +
    (labelStr ? `\n         ${labelStr}` : '') +
    `  ${c.dim}(${issue.createdAt})${c.reset}`;

  if (showScores) {
    row += `\n         ${formatScoreBreakdown(issue.scoreBreakdown, c)}`;
  }

  if (warningStr) {
    row += `\n         ${warningStr}`;
  }

  return row;
}
