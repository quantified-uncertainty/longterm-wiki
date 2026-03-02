/**
 * Session Checklist System (simplified)
 *
 * Generates a flat checklist of auto-verifiable and essential manual items.
 * Removed: 4-phase structure, 53-item catalog, elaborate descriptions,
 * event logging, backward-compat parsing.
 */

import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionType = 'content' | 'infrastructure' | 'bugfix' | 'refactor' | 'commands';

export type CheckStatus = 'checked' | 'unchecked' | 'na';

export interface ChecklistItem {
  id: string;
  label: string;
  applicableTypes: SessionType[] | 'all';
  /** blocking = must be checked or N/A before shipping. advisory = recommended. */
  priority: 'blocking' | 'advisory';
  /** Shell command for auto-verification. Exit 0 = pass. */
  verifyCommand?: string;
}

export interface ParsedItem {
  id: string;
  label: string;
  status: CheckStatus;
  naReason?: string;
}

export interface ChecklistStatus {
  items: ParsedItem[];
  totalChecked: number;
  totalItems: number;
  allPassing: boolean;
  decisions: string[];
}

export interface ChecklistMetadata {
  task: string;
  branch: string;
  issue?: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Checklist Item Catalog (~12 items; only auto-verified or genuinely enforced)
// ---------------------------------------------------------------------------

export const CHECKLIST_ITEMS: ChecklistItem[] = [
  // --- Auto-verified items (verifyCommand) ---
  {
    id: 'fix-escaping',
    label: 'Fix escaping (auto-verify)',
    applicableTypes: 'all',
    priority: 'blocking',
    verifyCommand: 'pnpm crux fix escaping',
  },
  {
    id: 'lockfile-fresh',
    label: 'Lockfile up to date (auto-verify)',
    applicableTypes: 'all',
    priority: 'blocking',
    verifyCommand: 'pnpm install --frozen-lockfile',
  },
  {
    id: 'gate-passes',
    label: 'Gate passes (auto-verify)',
    applicableTypes: 'all',
    priority: 'blocking',
    verifyCommand: 'pnpm crux validate gate --fix',
  },
  {
    id: 'pr-description',
    label: 'PR description (auto-verify)',
    applicableTypes: 'all',
    priority: 'blocking',
    verifyCommand: 'pnpm crux pr fix-body',
  },
  {
    id: 'ids-server-allocated',
    label: 'Entity IDs from server (auto-verify)',
    applicableTypes: 'all',
    priority: 'blocking',
    verifyCommand: 'node --import tsx/esm apps/web/scripts/assign-ids.mjs --dry-run',
  },
  {
    id: 'entitylinks-resolve',
    label: 'EntityLinks resolve (auto-verify)',
    applicableTypes: ['content'],
    priority: 'blocking',
    verifyCommand: 'pnpm crux validate unified --rules=entity-links --errors-only',
  },
  {
    id: 'mdx-escaping',
    label: 'MDX escaping correct (auto-verify)',
    applicableTypes: ['content'],
    priority: 'blocking',
    verifyCommand: 'pnpm crux validate unified --rules=comparison-operators,dollar-signs --errors-only',
  },
  {
    id: 'crux-typescript',
    label: 'Crux TypeScript check (auto-verify)',
    applicableTypes: ['infrastructure', 'commands', 'refactor'],
    priority: 'blocking',
    verifyCommand: 'cd crux && npx tsc --noEmit',
  },
  // --- Manual items (genuinely enforced or essential) ---
  {
    id: 'duplicate-check',
    label: 'Checked for duplicate/overlapping work',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'tests-written',
    label: 'Tests written for new logic',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'red-team',
    label: 'Adversarial inputs tested',
    applicableTypes: ['infrastructure', 'commands', 'bugfix', 'refactor'],
    priority: 'blocking',
  },
  {
    id: 'scope-complete',
    label: 'All acceptance criteria met',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'security',
    label: 'No secrets, no unsanitized input',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'issue-tracking',
    label: 'Issue tracking done (crux issues done)',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'push-ci-green',
    label: 'Pushed and CI green',
    applicableTypes: 'all',
    priority: 'blocking',
  },
];

// ---------------------------------------------------------------------------
// Label → Type Mapping
// ---------------------------------------------------------------------------

const LABEL_TYPE_MAP: Record<string, SessionType> = {
  bug: 'bugfix',
  defect: 'bugfix',
  refactor: 'refactor',
  cleanup: 'refactor',
  content: 'content',
  wiki: 'content',
  page: 'content',
  'claude-commands': 'commands',
};

export function detectTypeFromLabels(labels: string[]): SessionType {
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (LABEL_TYPE_MAP[lower]) return LABEL_TYPE_MAP[lower];
  }
  return 'infrastructure';
}

// ---------------------------------------------------------------------------
// Checklist Builder
// ---------------------------------------------------------------------------

export function getItemsForType(type: SessionType): ChecklistItem[] {
  return CHECKLIST_ITEMS.filter(
    item => item.applicableTypes === 'all' || item.applicableTypes.includes(type)
  );
}

export function buildChecklist(type: SessionType, metadata: ChecklistMetadata): string {
  const items = getItemsForType(type);
  const lines: string[] = [];

  lines.push('# Session Checklist');
  lines.push('');
  lines.push(`> Generated by \`crux agent-checklist init\` at ${metadata.timestamp}`);
  lines.push(`> Type: **${type}**`);
  lines.push(`> Branch: \`${metadata.branch}\``);
  lines.push(`> Task: ${metadata.task}`);
  if (metadata.issue) lines.push(`> Issue: #${metadata.issue}`);
  lines.push('');

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tag = item.priority === 'advisory' ? ' *(advisory)*' : '';
    lines.push(`${i + 1}. [ ] \`${item.id}\` ${item.label}${tag}`);
  }

  lines.push('');
  lines.push('## Key Decisions');
  lines.push('');
  lines.push('<!-- Log important decisions as you go. -->');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Checklist Mutation
// ---------------------------------------------------------------------------

export function checkItems(
  markdown: string,
  ids: string[],
  marker: 'x' | '~' = 'x',
  reason?: string
): { markdown: string; checked: string[]; notFound: string[] } {
  const lines = markdown.split('\n');
  const checked: string[] = [];
  const notFound: string[] = [];

  const itemPattern = /^\d+\. \[([ x~])\] `([^`]+)`/;

  for (const id of ids) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(itemPattern);
      if (match && match[2] === id) {
        let newLine = lines[i].replace(/\[([ x~])\]/, `[${marker}]`);
        if (marker === '~' && reason) {
          newLine = newLine.replace(/\s*<!-- N\/A:.*?-->/g, '');
          newLine += ` <!-- N/A: ${reason} -->`;
        }
        lines[i] = newLine;
        checked.push(id);
        found = true;
        break;
      }
    }
    if (!found) notFound.push(id);
  }

  return { markdown: lines.join('\n'), checked, notFound };
}

// ---------------------------------------------------------------------------
// Checklist Parser
// ---------------------------------------------------------------------------

export function parseChecklist(markdown: string): ChecklistStatus {
  const items: ParsedItem[] = [];
  const decisions: string[] = [];
  let inDecisions = false;

  const itemPattern = /^\d+\. \[([ x~])\] `([^`]+)` (.+?)(?:\s*\*(advisory)\*)?$/;

  for (const line of markdown.split('\n')) {
    if (/^## Key Decisions/.test(line)) { inDecisions = true; continue; }
    if (inDecisions && line.startsWith('## ')) { inDecisions = false; }

    if (inDecisions) {
      if (line.startsWith('<!--')) continue;
      const m = line.match(/^- (.+)/);
      if (m) decisions.push(m[1].trim());
      continue;
    }

    const match = line.match(itemPattern);
    if (match) {
      const status: CheckStatus = match[1] === 'x' ? 'checked' : match[1] === '~' ? 'na' : 'unchecked';
      const naMatch = line.match(/<!-- N\/A: (.+?) -->/);
      items.push({
        id: match[2],
        label: match[3].replace(/\s*\*\(advisory\)\*$/, '').trim(),
        status,
        ...(naMatch ? { naReason: naMatch[1] } : {}),
      });
    }
  }

  const totalChecked = items.filter(i => i.status !== 'unchecked').length;
  return { items, totalChecked, totalItems: items.length, allPassing: totalChecked === items.length, decisions };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function currentBranch(): string {
  try {
    return execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown-branch';
  }
}

// ---------------------------------------------------------------------------
// Checklist Header Parser
// ---------------------------------------------------------------------------

export interface ChecklistHeaderData {
  type: SessionType | null;
  initiated_at: string | null;
}

export function parseChecklistHeader(markdown: string): ChecklistHeaderData {
  const result: ChecklistHeaderData = { type: null, initiated_at: null };
  for (const line of markdown.split('\n')) {
    const tsMatch = line.match(/^> Generated by.*at (\d{4}-\d{2}-\d{2}T[\d:.Z]+)/);
    if (tsMatch) result.initiated_at = tsMatch[1];
    const typeMatch = line.match(/^> Type: \*\*([a-z]+)\*\*/);
    if (typeMatch) {
      const validTypes: SessionType[] = ['content', 'infrastructure', 'bugfix', 'refactor', 'commands'];
      if (validTypes.includes(typeMatch[1] as SessionType)) result.type = typeMatch[1] as SessionType;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Checklist Snapshot (for session log checks: field)
// ---------------------------------------------------------------------------

export interface ChecklistSnapshot {
  initialized: boolean;
  type?: string;
  initiated_at?: string;
  total?: number;
  completed?: number;
  na?: number;
  skipped?: number;
  items?: string[];
}

export function buildChecklistSnapshot(markdown: string): ChecklistSnapshot {
  const header = parseChecklistHeader(markdown);
  const status = parseChecklist(markdown);

  const completedItems: string[] = [];
  const naItems: string[] = [];
  const skippedItems: string[] = [];

  for (const item of status.items) {
    if (item.status === 'checked') completedItems.push(item.id);
    else if (item.status === 'na') naItems.push(item.id);
    else skippedItems.push(item.id);
  }

  return {
    initialized: true,
    ...(header.type ? { type: header.type } : {}),
    ...(header.initiated_at ? { initiated_at: header.initiated_at } : {}),
    total: status.totalItems,
    completed: completedItems.length,
    na: naItems.length,
    skipped: skippedItems.length,
    items: completedItems,
  };
}

export function formatSnapshotAsYaml(snapshot: ChecklistSnapshot): string {
  const lines: string[] = ['checks:'];

  if (!snapshot.initialized) {
    lines.push('  initialized: false');
    return lines.join('\n');
  }

  lines.push('  initialized: true');
  if (snapshot.type) lines.push(`  type: ${snapshot.type}`);
  if (snapshot.initiated_at) lines.push(`  initiated_at: "${snapshot.initiated_at}"`);
  if (snapshot.total !== undefined) lines.push(`  total: ${snapshot.total}`);
  if (snapshot.completed !== undefined) lines.push(`  completed: ${snapshot.completed}`);
  if (snapshot.na !== undefined) lines.push(`  na: ${snapshot.na}`);
  if (snapshot.skipped !== undefined) lines.push(`  skipped: ${snapshot.skipped}`);

  if (snapshot.items && snapshot.items.length > 0) {
    lines.push('  items:');
    for (const id of snapshot.items) lines.push(`    - ${id}`);
  } else {
    lines.push('  items: []');
  }

  return lines.join('\n');
}
