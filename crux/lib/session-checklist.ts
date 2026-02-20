/**
 * Session Checklist System
 *
 * Type-aware checklist generation, parsing, and status reporting.
 * Replaces the static checklist-template.md with a programmatic catalog
 * that generates checklists tailored to the session's task type.
 */

import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionType = 'content' | 'infrastructure' | 'bugfix' | 'refactor' | 'commands';

export type ChecklistPhase = 'understand' | 'implement' | 'review' | 'ship';

export type CheckStatus = 'checked' | 'unchecked' | 'na';

export interface ChecklistItem {
  id: string;
  label: string;
  description: string;
  phase: ChecklistPhase;
  applicableTypes: SessionType[] | 'all';
  /** Shell command that can programmatically verify this item. Exit 0 = pass. */
  verifyCommand?: string;
}

export interface ParsedItem {
  id: string;
  label: string;
  status: CheckStatus;
  /** Reason provided when the item was marked N/A. */
  naReason?: string;
}

export interface PhaseStatus {
  phase: ChecklistPhase;
  items: ParsedItem[];
  checked: number;
  total: number;
}

export interface ChecklistStatus {
  phases: PhaseStatus[];
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
// Phase display names
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<ChecklistPhase, string> = {
  understand: 'Phase 1: Understand',
  implement: 'Phase 2: Implement',
  review: 'Phase 3: Review',
  ship: 'Phase 4: Ship',
};

// ---------------------------------------------------------------------------
// Checklist Item Catalog (43 items total; ~28-31 per session depending on type)
// ---------------------------------------------------------------------------

export const CHECKLIST_ITEMS: ChecklistItem[] = [
  // Phase 1: Understand
  {
    id: 'read-issue',
    label: 'Read the issue/request',
    description: 'Read the issue or request carefully. List acceptance criteria.',
    phase: 'understand',
    applicableTypes: 'all',
  },
  {
    id: 'explore-code',
    label: 'Explore relevant code',
    description: 'Read files that will be modified. Understand existing patterns.',
    phase: 'understand',
    applicableTypes: 'all',
  },
  {
    id: 'plan-approach',
    label: 'Plan approach',
    description: 'For non-trivial changes, think through the design before coding.',
    phase: 'understand',
    applicableTypes: 'all',
  },
  {
    id: 'root-cause',
    label: 'Root cause identified',
    description: 'Identify and document the root cause before attempting a fix.',
    phase: 'understand',
    applicableTypes: ['bugfix'],
  },
  {
    id: 'research-content',
    label: 'Research content',
    description: 'Gather sources, verify facts, and understand the topic before writing.',
    phase: 'understand',
    applicableTypes: ['content'],
  },

  // Phase 2: Implement
  {
    id: 'tests-written',
    label: 'Tests written',
    description: 'Tests cover happy paths AND edge cases.',
    phase: 'implement',
    applicableTypes: 'all',
  },
  {
    id: 'no-hardcoded',
    label: 'No hardcoded constants',
    description: 'URLs, magic numbers, and thresholds are in config or shared constants.',
    phase: 'implement',
    applicableTypes: 'all',
  },
  {
    id: 'fix-escaping',
    label: 'Fix escaping',
    description: 'Run `pnpm crux fix escaping` after any MDX or content changes.',
    phase: 'implement',
    applicableTypes: 'all',
    verifyCommand: 'pnpm crux fix escaping',
  },
  {
    id: 'typescript-used',
    label: 'TypeScript used',
    description: 'New code is in TypeScript where possible.',
    phase: 'implement',
    applicableTypes: ['infrastructure', 'refactor', 'commands'],
  },
  {
    id: 'crux-pipeline',
    label: 'Used crux content pipeline',
    description: 'Page created/improved via `crux content create` or `crux content improve`, not manually.',
    phase: 'implement',
    applicableTypes: ['content'],
  },
  {
    id: 'fix-minimal',
    label: 'Fix is minimal',
    description: 'Change is the smallest possible fix for the root cause. No scope creep.',
    phase: 'implement',
    applicableTypes: ['bugfix'],
  },
  {
    id: 'regression-test',
    label: 'Regression test added',
    description: 'A test that would have caught this bug before the fix.',
    phase: 'implement',
    applicableTypes: ['bugfix'],
  },
  {
    id: 'behavior-unchanged',
    label: 'Behavior unchanged',
    description: 'Existing behavior is preserved. No functional changes beyond the refactor.',
    phase: 'implement',
    applicableTypes: ['refactor'],
  },
  {
    id: 'callers-updated',
    label: 'All callers updated',
    description: 'Every call site of modified functions/types has been updated.',
    phase: 'implement',
    applicableTypes: ['refactor'],
  },
  {
    id: 'command-registered',
    label: 'Command registered',
    description: 'New command is registered in `crux/crux.mjs` and accessible via CLI.',
    phase: 'implement',
    applicableTypes: ['commands'],
  },
  {
    id: 'command-documented',
    label: 'Command documented',
    description: 'Help text, CLAUDE.md quick reference, and getHelp() are updated.',
    phase: 'implement',
    applicableTypes: ['commands'],
  },

  // Phase 3: Review
  {
    id: 'correctness',
    label: 'Correctness verified',
    description: 'Traced logic step by step. No off-by-one, flipped conditions, wrong variable names.',
    phase: 'review',
    applicableTypes: 'all',
  },
  {
    id: 'paranoid-review',
    label: 'Paranoid review done',
    description:
      'Spawn a fresh Task subagent with no prior context. Give it the git diff and this adversarial prompt: "Find every bug, DRY violation, dead code, missing export, test coverage gap, hardcoded constant, and deferred work item." Review all findings. Fix or document every issue raised before checking this off.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands', 'refactor', 'bugfix'],
  },
  {
    id: 'shell-injection',
    label: 'No shell injection',
    description: 'Any `curl -d` with variables uses `jq -n --arg`, not raw string interpolation.',
    phase: 'review',
    applicableTypes: 'all',
  },
  {
    id: 'security',
    label: 'Security checked',
    description: 'No hardcoded secrets, no unsanitized user input, nothing that should be in .gitignore.',
    phase: 'review',
    applicableTypes: 'all',
  },
  {
    id: 'no-dead-code',
    label: 'No dead code',
    description: 'Changes did not make existing code redundant. Grepped for replaced functions.',
    phase: 'review',
    applicableTypes: 'all',
  },
  {
    id: 'no-dry-violations',
    label: 'No DRY violations',
    description: 'New logic does not duplicate existing utilities.',
    phase: 'review',
    applicableTypes: 'all',
  },
  {
    id: 'full-integration',
    label: 'Full integration',
    description: 'New types have consumers, new CLI commands are registered, new pages are in sidebar nav.',
    phase: 'review',
    applicableTypes: 'all',
  },
  {
    id: 'no-regressions',
    label: 'No regressions',
    description: 'Grepped for patterns related to changes and verified nothing is stale or inconsistent.',
    phase: 'review',
    applicableTypes: 'all',
  },
  {
    id: 'live-data-test',
    label: 'Tested on live data',
    description:
      'If possible, run the code against real data, review the output, and adjust. Repeat the loop until results look correct. Do not ship untested scripts.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands', 'bugfix', 'refactor'],
  },
  {
    id: 'entitylinks-resolve',
    label: 'EntityLinks resolve',
    description: 'Every `<EntityLink id="X">` has a matching entity in `data/entities/*.yaml`.',
    phase: 'review',
    applicableTypes: ['content'],
    verifyCommand: 'pnpm crux validate unified --rules=entity-links --errors-only',
  },
  {
    id: 'numeric-ids-stable',
    label: 'Numeric IDs stable',
    description: 'No `numericId` values were removed or changed in entity YAML.',
    phase: 'review',
    applicableTypes: ['content'],
    verifyCommand: 'pnpm crux validate unified --rules=numeric-id-integrity --errors-only',
  },
  {
    id: 'mdx-escaping',
    label: 'MDX escaping correct',
    description: 'No unescaped `$` or `<` in prose. Run `crux validate unified --rules=comparison-operators,dollar-signs`.',
    phase: 'review',
    applicableTypes: ['content'],
    verifyCommand: 'pnpm crux validate unified --rules=comparison-operators,dollar-signs --errors-only',
  },
  {
    id: 'content-accuracy',
    label: 'Content accuracy',
    description: 'No round-number statistics without citations, no claims contradicting page data.',
    phase: 'review',
    applicableTypes: ['content'],
  },
  {
    id: 'citations-have-urls',
    label: 'Citations have URLs',
    description:
      'Every `[^N]:` footnote definition contains a markdown link `[Title](https://...)` or bare URL. Run `pnpm crux validate unified --rules=no-url-footnotes,citation-urls` to catch placeholders and missing URLs automatically.',
    phase: 'review',
    applicableTypes: ['content'],
    verifyCommand: 'pnpm crux validate unified --rules=no-url-footnotes,citation-urls --errors-only',
  },
  {
    id: 'citations-verify',
    label: 'Citations verified (spot check)',
    description:
      'For high-importance pages or pages with many new citations: run `pnpm crux citations verify <page-id>` to check URLs return 200 and match claimed titles. Focus on any footnote added in this session.',
    phase: 'review',
    applicableTypes: ['content'],
  },
  {
    id: 'backward-compatible',
    label: 'Backward compatible',
    description: 'Changes do not break existing consumers, APIs, or data formats.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'refactor'],
  },
  {
    id: 'multi-environment',
    label: 'Multi-environment',
    description: 'Works in Claude Code web sandboxes (limited network) and local dev.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands'],
  },
  {
    id: 'ci-coverage',
    label: 'CI covers new code',
    description: 'If you added a new test suite, package, or build step: verify it is wired into `.github/workflows/ci.yml`. New `pnpm test` invocations or scripts need a corresponding CI job step — they do not run automatically.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands', 'refactor'],
  },

  // Phase 4: Ship
  {
    id: 'self-audit-commands',
    label: 'Re-ran commands',
    description: 'Every command claimed to run has been re-run and output matches claims.',
    phase: 'ship',
    applicableTypes: 'all',
  },
  {
    id: 'self-audit-files',
    label: 'Verified files',
    description: 'Every file said to be modified has been re-read and confirmed correct.',
    phase: 'ship',
    applicableTypes: 'all',
  },
  {
    id: 'self-audit-no-fabrication',
    label: 'No fabricated outputs',
    description: 'Test counts, line counts, and error counts match actual output.',
    phase: 'ship',
    applicableTypes: 'all',
  },
  {
    id: 'gate-passes',
    label: 'Gate passes',
    description: '`pnpm crux validate gate --fix` passes. Record exact test count.',
    phase: 'ship',
    applicableTypes: 'all',
    verifyCommand: 'pnpm crux validate gate --fix',
  },
  {
    id: 'pr-description',
    label: 'PR description',
    description:
      'Summary, key changes, test plan. All items checked and true. Run `pnpm crux pr fix-body` to auto-repair any literal \\n in the PR body.',
    phase: 'ship',
    applicableTypes: 'all',
    verifyCommand: 'pnpm crux pr fix-body',
  },
  {
    id: 'issue-tracking',
    label: 'Issue tracking',
    description: '`pnpm crux issues done <N> --pr=<URL>` if working on an issue.',
    phase: 'ship',
    applicableTypes: 'all',
  },
  {
    id: 'session-log',
    label: 'Session log',
    description: '`.claude/sessions/YYYY-MM-DD_<branch-suffix>.yaml` created per session-logging rules.',
    phase: 'ship',
    applicableTypes: 'all',
    verifyCommand: 'ls .claude/sessions/$(date +%Y-%m-%d)_*.yaml 2>/dev/null | head -1 | grep -q .',
  },
  {
    id: 'push-ci-green',
    label: 'Push and CI green',
    description: 'Pushed to remote. CI checks pass (use `pnpm crux ci status --wait`).',
    phase: 'ship',
    applicableTypes: 'all',
  },
  {
    id: 'no-merge-conflicts',
    label: 'No merge conflicts',
    description: 'PR is mergeable (not "dirty"). If conflicts exist, rebase onto main.',
    phase: 'ship',
    applicableTypes: 'all',
  },
  {
    id: 'check-recent-merges',
    label: 'Check recent merges',
    description: 'Reviewed commits merged to main since session started. No conflicts or relevant overlapping changes.',
    phase: 'ship',
    applicableTypes: 'all',
  },
  {
    id: 'crux-typescript',
    label: 'Crux TypeScript check',
    description: '`cd crux && npx tsc --noEmit` passes (if crux/ files changed).',
    phase: 'ship',
    applicableTypes: ['infrastructure', 'commands', 'refactor'],
    verifyCommand: 'cd crux && npx tsc --noEmit',
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

/**
 * Detect session type from GitHub issue labels.
 * Returns the first matching type, or 'infrastructure' as default.
 */
export function detectTypeFromLabels(labels: string[]): SessionType {
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (LABEL_TYPE_MAP[lower]) {
      return LABEL_TYPE_MAP[lower];
    }
  }
  return 'infrastructure';
}

// ---------------------------------------------------------------------------
// Checklist Builder
// ---------------------------------------------------------------------------

/**
 * Filter the catalog to items applicable for the given session type.
 */
export function getItemsForType(type: SessionType): ChecklistItem[] {
  return CHECKLIST_ITEMS.filter(
    item => item.applicableTypes === 'all' || item.applicableTypes.includes(type)
  );
}

/**
 * Generate a markdown checklist for the given session type and metadata.
 */
export function buildChecklist(type: SessionType, metadata: ChecklistMetadata): string {
  const items = getItemsForType(type);
  const lines: string[] = [];

  lines.push('# Session Checklist');
  lines.push('');
  lines.push(`> Generated by \`crux agent-checklist init\` at ${metadata.timestamp}`);
  lines.push(`> Type: **${type}**`);
  lines.push(`> Branch: \`${metadata.branch}\``);
  lines.push(`> Task: ${metadata.task}`);
  if (metadata.issue) {
    lines.push(`> Issue: #${metadata.issue}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  const phases: ChecklistPhase[] = ['understand', 'implement', 'review', 'ship'];
  let itemNumber = 0;
  for (const phase of phases) {
    const phaseItems = items.filter(item => item.phase === phase);
    if (phaseItems.length === 0) continue;

    lines.push(`## ${PHASE_LABELS[phase]}`);
    lines.push('');
    for (const item of phaseItems) {
      itemNumber++;
      const autoTag = item.verifyCommand ? ' *(auto-verify)*' : '';
      lines.push(`${itemNumber}. [ ] \`${item.id}\` **${item.label}**: ${item.description}${autoTag}`);
    }
    lines.push('');
  }

  // Key Decisions log section
  lines.push('## Key Decisions');
  lines.push('');
  lines.push('<!-- Log important decisions as you go. These feed into the session log. -->');
  lines.push('<!-- Format: - **Decision**: rationale -->');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Checklist Mutation
// ---------------------------------------------------------------------------

/**
 * Check off one or more items in a checklist markdown string.
 * Returns the updated markdown, or null if any id was not found.
 * Supports checking [x] and marking N/A [~].
 */
export function checkItems(
  markdown: string,
  ids: string[],
  marker: 'x' | '~' = 'x',
  reason?: string
): { markdown: string; checked: string[]; notFound: string[] } {
  const lines = markdown.split('\n');
  const checked: string[] = [];
  const notFound: string[] = [];

  // Pattern for new numbered format: "1. [ ] `id` **Label**: ..."
  const numberedPattern = /^(\d+)\. \[([ x~])\] `([^`]+)` \*\*([^*]+)\*\*/;
  // Pattern for old unnumbered format: "- [ ] **Label**: ..."
  const unnumberedPattern = /^- \[([ x~])\] \*\*([^*]+)\*\*/;

  for (const id of ids) {
    const catalogItem = CHECKLIST_ITEMS.find(i => i.id === id);
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Try numbered format first
      const numberedMatch = line.match(numberedPattern);
      if (numberedMatch) {
        const lineId = numberedMatch[3];
        if (lineId === id) {
          let newLine = line.replace(/\[([ x~])\]/, `[${marker}]`);
          if (marker === '~' && reason) {
            newLine = newLine.replace(/\s*<!-- N\/A:.*?-->/g, '');
            newLine = newLine + ` <!-- N/A: ${reason} -->`;
          }
          lines[i] = newLine;
          checked.push(id);
          found = true;
          break;
        }
        continue;
      }

      // Fall back to unnumbered format (backward compat)
      const unnumberedMatch = line.match(unnumberedPattern);
      if (!unnumberedMatch) continue;

      const lineLabel = unnumberedMatch[2].replace(/:$/, '');
      const lineId = lineLabel.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

      if (
        (catalogItem && lineLabel === catalogItem.label) ||
        lineId === id
      ) {
        let newLine = line.replace(/^- \[[ x~]\]/, `- [${marker}]`);
        if (marker === '~' && reason) {
          newLine = newLine.replace(/\s*<!-- N\/A:.*?-->/g, '');
          newLine = newLine + ` <!-- N/A: ${reason} -->`;
        }
        lines[i] = newLine;
        checked.push(id);
        found = true;
        break;
      }
    }

    if (!found) {
      notFound.push(id);
    }
  }

  return { markdown: lines.join('\n'), checked, notFound };
}

// ---------------------------------------------------------------------------
// Checklist Parser
// ---------------------------------------------------------------------------

/**
 * Parse a markdown checklist and return status for each item.
 * Recognizes [x], [ ], and [~] markers.
 */
export function parseChecklist(markdown: string): ChecklistStatus {
  const phases: PhaseStatus[] = [];
  const decisions: string[] = [];
  let currentPhase: ChecklistPhase | null = null;
  let currentItems: ParsedItem[] = [];
  let inDecisions = false;

  const phasePattern = /^## Phase (\d): (\w+)/;
  const decisionsPattern = /^## Key Decisions/;
  // New numbered format: "1. [ ] `id` **Label**: ..."
  const numberedItemPattern = /^\d+\. \[([ x~])\] `([^`]+)` \*\*([^*]+)\*\*/;
  // Old unnumbered format: "- [ ] **Label**: ..."
  const unnumberedItemPattern = /^- \[([ x~])\] \*\*([^*]+)\*\*/;
  const decisionItemPattern = /^- (.+)/;

  const phaseNameMap: Record<string, ChecklistPhase> = {
    'Understand': 'understand',
    'Implement': 'implement',
    'Review': 'review',
    'Ship': 'ship',
  };

  for (const line of markdown.split('\n')) {
    // Check for Key Decisions section
    if (decisionsPattern.test(line)) {
      // Save previous phase if any
      if (currentPhase !== null) {
        const checked = currentItems.filter(i => i.status !== 'unchecked').length;
        phases.push({ phase: currentPhase, items: currentItems, checked, total: currentItems.length });
        currentPhase = null;
        currentItems = [];
      }
      inDecisions = true;
      continue;
    }

    // If we hit another ## heading, we're out of decisions
    if (inDecisions && line.startsWith('## ')) {
      inDecisions = false;
    }

    // Parse decisions
    if (inDecisions) {
      // Skip HTML comments
      if (line.startsWith('<!--')) continue;
      const decisionMatch = line.match(decisionItemPattern);
      if (decisionMatch) {
        decisions.push(decisionMatch[1].trim());
      }
      continue;
    }

    const phaseMatch = line.match(phasePattern);
    if (phaseMatch) {
      // Save previous phase
      if (currentPhase !== null) {
        const checked = currentItems.filter(i => i.status !== 'unchecked').length;
        phases.push({ phase: currentPhase, items: currentItems, checked, total: currentItems.length });
      }
      currentPhase = phaseNameMap[phaseMatch[2]] || 'understand';
      currentItems = [];
      continue;
    }

    if (currentPhase !== null) {
      // Try numbered format first: "1. [ ] `id` **Label**: ..."
      const numberedMatch = line.match(numberedItemPattern);
      if (numberedMatch) {
        const marker = numberedMatch[1];
        const id = numberedMatch[2];
        const label = numberedMatch[3].replace(/:$/, '');
        let status: CheckStatus;
        if (marker === 'x') status = 'checked';
        else if (marker === '~') status = 'na';
        else status = 'unchecked';
        const naReasonMatch = line.match(/<!-- N\/A: (.+?) -->/);
        const naReason = naReasonMatch ? naReasonMatch[1] : undefined;
        currentItems.push({ id, label, status, ...(naReason ? { naReason } : {}) });
        continue;
      }

      // Fall back to old unnumbered format: "- [ ] **Label**: ..."
      const unnumberedMatch = line.match(unnumberedItemPattern);
      if (unnumberedMatch) {
        const marker = unnumberedMatch[1];
        const label = unnumberedMatch[2].replace(/:$/, '');
        let status: CheckStatus;
        if (marker === 'x') status = 'checked';
        else if (marker === '~') status = 'na';
        else status = 'unchecked';
        // Derive an id from the label (lowercase, hyphenated)
        const id = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const naReasonMatch = line.match(/<!-- N\/A: (.+?) -->/);
        const naReason = naReasonMatch ? naReasonMatch[1] : undefined;
        currentItems.push({ id, label, status, ...(naReason ? { naReason } : {}) });
      }
    }
  }

  // Save last phase
  if (currentPhase !== null) {
    const checked = currentItems.filter(i => i.status !== 'unchecked').length;
    phases.push({ phase: currentPhase, items: currentItems, checked, total: currentItems.length });
  }

  const totalChecked = phases.reduce((sum, p) => sum + p.checked, 0);
  const totalItems = phases.reduce((sum, p) => sum + p.total, 0);
  const allPassing = totalChecked === totalItems;

  return { phases, totalChecked, totalItems, allPassing, decisions };
}

// ---------------------------------------------------------------------------
// Status Formatting
// ---------------------------------------------------------------------------

interface FormatColors {
  green: string;
  yellow: string;
  red: string;
  cyan: string;
  bold: string;
  dim: string;
  reset: string;
}

/**
 * Format checklist status for terminal output.
 */
export function formatStatus(status: ChecklistStatus, c: FormatColors): string {
  const lines: string[] = [];
  const pct = status.totalItems > 0 ? Math.round((status.totalChecked / status.totalItems) * 100) : 0;
  const color = status.allPassing ? c.green : pct >= 50 ? c.yellow : c.red;

  lines.push(`${c.bold}Session Checklist Progress${c.reset}`);
  lines.push(`${color}${status.totalChecked}/${status.totalItems} items complete (${pct}%)${c.reset}`);
  lines.push('');

  for (const phase of status.phases) {
    const phaseColor = phase.checked === phase.total ? c.green : c.yellow;
    lines.push(`${phaseColor}${PHASE_LABELS[phase.phase]}: ${phase.checked}/${phase.total}${c.reset}`);

    for (const item of phase.items) {
      if (item.status === 'checked') {
        lines.push(`  ${c.green}[x]${c.reset} ${c.dim}${item.id}${c.reset} ${item.label}`);
      } else if (item.status === 'na') {
        const reasonSuffix = item.naReason ? ` (N/A: ${item.naReason})` : ' (N/A)';
        lines.push(`  ${c.dim}[~]${c.reset} ${c.dim}${item.id}${c.reset} ${c.dim}${item.label}${reasonSuffix}${c.reset}`);
      } else {
        lines.push(`  ${c.red}[ ]${c.reset} ${c.dim}${item.id}${c.reset} ${item.label}`);
      }
    }
  }

  // Show decisions if any
  if (status.decisions.length > 0) {
    lines.push('');
    lines.push(`${c.bold}Key Decisions (${status.decisions.length}):${c.reset}`);
    for (const decision of status.decisions) {
      lines.push(`  ${c.cyan}-${c.reset} ${decision}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Utility: current branch
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

/**
 * Parse the metadata header block from a checklist markdown file.
 *
 * Extracts the session type and initialization timestamp from lines like:
 *   > Generated by `crux agent-checklist init` at 2026-02-19T12:00:00.000Z
 *   > Type: **infrastructure**
 */
export function parseChecklistHeader(markdown: string): ChecklistHeaderData {
  const result: ChecklistHeaderData = { type: null, initiated_at: null };

  for (const line of markdown.split('\n')) {
    // > Generated by `crux agent-checklist init` at <ISO timestamp>
    const timestampMatch = line.match(/^> Generated by.*at (\d{4}-\d{2}-\d{2}T[\d:.Z]+)/);
    if (timestampMatch) {
      result.initiated_at = timestampMatch[1];
    }

    // > Type: **infrastructure**
    const typeMatch = line.match(/^> Type: \*\*([a-z]+)\*\*/);
    if (typeMatch) {
      const candidate = typeMatch[1] as SessionType;
      const validTypes: SessionType[] = ['content', 'infrastructure', 'bugfix', 'refactor', 'commands'];
      if (validTypes.includes(candidate)) {
        result.type = candidate;
      }
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

/**
 * Build a snapshot of the current checklist state for inclusion in session logs.
 *
 * Returns a structured object representing checklist completion at ship time.
 * When no checklist exists, returns { initialized: false }.
 */
export function buildChecklistSnapshot(markdown: string): ChecklistSnapshot {
  const header = parseChecklistHeader(markdown);
  const status = parseChecklist(markdown);

  const completedItems: string[] = [];
  const naItems: string[] = [];
  const skippedItems: string[] = [];

  for (const phase of status.phases) {
    for (const item of phase.items) {
      if (item.status === 'checked') completedItems.push(item.id);
      else if (item.status === 'na') naItems.push(item.id);
      else skippedItems.push(item.id);
    }
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

/**
 * Format a ChecklistSnapshot as YAML lines for embedding in session log files.
 *
 * Produces the `checks:` block suitable for copy-paste into a session log.
 */
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
    for (const id of snapshot.items) {
      lines.push(`    - ${id}`);
    }
  } else {
    lines.push('  items: []');
  }

  return lines.join('\n');
}
