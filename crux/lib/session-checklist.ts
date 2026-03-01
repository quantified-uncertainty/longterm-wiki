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

export type ChecklistPriority = 'blocking' | 'advisory';

export interface ChecklistItem {
  id: string;
  label: string;
  description: string;
  phase: ChecklistPhase;
  applicableTypes: SessionType[] | 'all';
  /**
   * blocking = must be checked before shipping (or explicitly marked N/A with reason).
   * advisory = should be checked but won't block the pre-push hook.
   */
  priority: ChecklistPriority;
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
// Checklist Item Catalog (56 items total; ~35-41 per session depending on type)
// Items marked 'blocking' must be checked or N/A'd before shipping.
// Items marked 'advisory' are recommended but won't block the pre-push hook.
// ---------------------------------------------------------------------------

export const CHECKLIST_ITEMS: ChecklistItem[] = [
  // =========================================================================
  // Phase 1: Understand
  // =========================================================================
  {
    id: 'read-issue',
    label: 'Read the issue/request',
    description: 'Read the issue or request carefully. List acceptance criteria.',
    phase: 'understand',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'explore-code',
    label: 'Explore relevant code',
    description: 'Read files that will be modified. Understand existing patterns.',
    phase: 'understand',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'plan-approach',
    label: 'Plan approach',
    description: 'For non-trivial changes, think through the design before coding.',
    phase: 'understand',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'duplicate-check',
    label: 'Checked for duplicates',
    description:
      'Before starting work: (1) Review conflict warnings from `crux agent-checklist init` output. ' +
      '(2) Search open PRs: `gh pr list --search "topic"`. ' +
      '(3) Search recent closed PRs: `gh pr list --state closed --search "topic" --limit 10`. ' +
      'If overlap found, coordinate or pick a different task.',
    phase: 'understand',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'root-cause',
    label: 'Root cause identified',
    description: 'Identify and document the root cause before attempting a fix.',
    phase: 'understand',
    applicableTypes: ['bugfix'],
    priority: 'blocking',
  },
  {
    id: 'research-content',
    label: 'Research content',
    description: 'Gather sources, verify facts, and understand the topic before writing.',
    phase: 'understand',
    applicableTypes: ['content'],
    priority: 'blocking',
  },

  // =========================================================================
  // Phase 2: Implement
  // =========================================================================
  // --- Change 2: Test-first ---
  {
    id: 'tests-written',
    label: 'Tests written BEFORE implementation',
    description:
      'Write tests FIRST, from acceptance criteria, before writing the implementation. ' +
      'The test encodes what the code SHOULD do, not what it DOES do. ' +
      'Cover happy paths AND edge cases. For schema changes: write a round-trip test (insert → read → compare). ' +
      'For CLI flags: test that each flag reaches its handler. ' +
      'For bug fixes: write the failing test first, then make it pass.',
    phase: 'implement',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'no-hardcoded',
    label: 'No hardcoded constants',
    description: 'URLs, magic numbers, and thresholds are in config or shared constants.',
    phase: 'implement',
    applicableTypes: 'all',
    priority: 'advisory',
  },
  {
    id: 'fix-escaping',
    label: 'Fix escaping',
    description: 'Run `pnpm crux fix escaping` after any MDX or content changes.',
    phase: 'implement',
    applicableTypes: 'all',
    priority: 'blocking',
    verifyCommand: 'pnpm crux fix escaping',
  },
  {
    id: 'typescript-used',
    label: 'TypeScript used',
    description: 'New code is in TypeScript where possible.',
    phase: 'implement',
    applicableTypes: ['infrastructure', 'refactor', 'commands'],
    priority: 'advisory',
  },
  {
    id: 'crux-pipeline',
    label: 'Used crux content pipeline',
    description: 'Page created/improved via `crux content create` or `crux content improve`, not manually.',
    phase: 'implement',
    applicableTypes: ['content'],
    priority: 'blocking',
  },
  {
    id: 'fix-minimal',
    label: 'Fix is minimal',
    description: 'Change is the smallest possible fix for the root cause. No scope creep.',
    phase: 'implement',
    applicableTypes: ['bugfix'],
    priority: 'blocking',
  },
  {
    id: 'regression-test',
    label: 'Regression test added',
    description: 'A test that would have caught this bug before the fix.',
    phase: 'implement',
    applicableTypes: ['bugfix'],
    priority: 'blocking',
  },
  {
    id: 'behavior-unchanged',
    label: 'Behavior unchanged',
    description: 'Existing behavior is preserved. No functional changes beyond the refactor.',
    phase: 'implement',
    applicableTypes: ['refactor'],
    priority: 'blocking',
  },
  {
    id: 'callers-updated',
    label: 'All callers updated',
    description: 'Every call site of modified functions/types has been updated.',
    phase: 'implement',
    applicableTypes: ['refactor'],
    priority: 'blocking',
  },
  {
    id: 'command-registered',
    label: 'Command registered',
    description: 'New command is registered in `crux/crux.mjs` and accessible via CLI.',
    phase: 'implement',
    applicableTypes: ['commands'],
    priority: 'blocking',
  },
  {
    id: 'command-documented',
    label: 'Command documented',
    description: 'Help text, CLAUDE.md quick reference, and getHelp() are updated.',
    phase: 'implement',
    applicableTypes: ['commands'],
    priority: 'advisory',
  },

  // =========================================================================
  // Phase 3: Review
  // =========================================================================
  {
    id: 'correctness',
    label: 'Correctness verified',
    description: 'Traced logic step by step. No off-by-one, flipped conditions, wrong variable names.',
    phase: 'review',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  // --- Change 1: Execution-based paranoid review ---
  {
    id: 'paranoid-review',
    label: 'Execution-based review done',
    description:
      'Spawn a fresh Task subagent with the git diff AND these execution instructions. ' +
      'The reviewer must RUN things and paste output — not just read code. Instructions: ' +
      '(1) For each new/changed function: run it with typical input AND with empty/null/edge-case input, paste both outputs. ' +
      '(2) For each DB/schema change: write a verification query that checks the expected invariant (e.g. row counts, column values), run it, paste the result. ' +
      '(3) For each CLI flag: run the command WITH the flag and WITHOUT it, show both outputs differ as expected. ' +
      '(4) For each UI data dependency: fetch the API endpoint the component uses, print the response keys, verify they match the component props. ' +
      '(5) Check for DRY violations, dead code, missing exports. ' +
      'Fix every issue found. Paste verification output into Key Decisions.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands', 'refactor', 'bugfix'],
    priority: 'blocking',
  },
  // --- Change 3: Category-specific verification items ---
  {
    id: 'verify-schema',
    label: 'Schema verification',
    description:
      'For every new/changed DB column: (1) Is the type correct? (REAL vs DOUBLE PRECISION, nullable vs NOT NULL — state your choice and why.) ' +
      '(2) Write an INSERT + SELECT round-trip test. (3) Run the migration, then run a verification query and paste the result. ' +
      '(4) For array/JSONB columns: test with empty arrays and null. ' +
      'Paste all query outputs into Key Decisions.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands'],
    priority: 'blocking',
  },
  {
    id: 'verify-cli',
    label: 'CLI flag verification',
    description:
      'For every CLI flag added or changed: (1) Trace the flag from its yargs/command definition through dispatch to where it is actually used. ' +
      '(2) Run the command with the flag and paste the output. (3) Run without the flag and confirm the behavior differs as expected. ' +
      '(4) If the flag is forwarded to a subprocess, log the subprocess args and verify the flag arrives. ' +
      'Paste command outputs into Key Decisions.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands'],
    priority: 'blocking',
  },
  {
    id: 'verify-ui',
    label: 'UI data contract verification',
    description:
      'For every UI component that fetches data: (1) Fetch the API endpoint it uses (curl or script). ' +
      '(2) Print the response JSON keys and compare to what the component destructures/expects. ' +
      '(3) Check: what renders when the data is empty? When a field is null? When the list has 0 items vs 1000? ' +
      'Paste the API response shape and component prop comparison into Key Decisions.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'bugfix'],
    priority: 'blocking',
  },
  {
    id: 'verify-llm-boundary',
    label: 'LLM output boundary check',
    description:
      'For any code that parses LLM output: (1) Run the extraction/pipeline on one real input and paste 2-3 example outputs. ' +
      '(2) Test with malformed JSON (missing closing brace), truncated response, and empty response. ' +
      '(3) Verify entity names are normalized (lowercased, trimmed, checked against existing entities). ' +
      '(4) Verify numeric values round-trip without precision loss. ' +
      'Paste example outputs into Key Decisions.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands'],
    priority: 'blocking',
  },
  {
    id: 'shell-injection',
    label: 'No shell injection',
    description: 'Any `curl -d` with variables uses `jq -n --arg`, not raw string interpolation.',
    phase: 'review',
    applicableTypes: 'all',
    priority: 'advisory',
  },
  {
    id: 'security',
    label: 'Security checked',
    description: 'No hardcoded secrets, no unsanitized user input, nothing that should be in .gitignore.',
    phase: 'review',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'red-team',
    label: 'Red-team check',
    description:
      'For each new endpoint, CLI flag, or data path: (1) Try injecting unexpected input — empty strings, very long strings, ' +
      'special characters ($, `, |, ;), SQL/shell metacharacters. (2) Try calling the endpoint without auth or with expired tokens. ' +
      '(3) For any new file read/write: try path traversal (../../etc/passwd). (4) For any new config: try missing/malformed values. ' +
      'Paste the adversarial test commands and their results into Key Decisions.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands', 'bugfix', 'refactor'],
    priority: 'blocking',
  },
  {
    id: 'scope-complete',
    label: 'Full scope delivered',
    description:
      'Re-read the original issue/request. Compare what was asked for vs what was implemented. ' +
      'For each acceptance criterion: cite the specific file + line where it is satisfied OR cite the test that covers it. ' +
      'If any criterion is not met, either implement it now or explicitly document it as "out of scope" in the PR description with a linked follow-up issue. ' +
      'A PR that needs a follow-up PR to be functional is incomplete.',
    phase: 'review',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'no-dead-code',
    label: 'No dead code',
    description: 'Changes did not make existing code redundant. Grepped for replaced functions.',
    phase: 'review',
    applicableTypes: 'all',
    priority: 'advisory',
  },
  {
    id: 'no-dry-violations',
    label: 'No DRY violations',
    description: 'New logic does not duplicate existing utilities.',
    phase: 'review',
    applicableTypes: 'all',
    priority: 'advisory',
  },
  {
    id: 'full-integration',
    label: 'Full integration',
    description: 'New types have consumers, new CLI commands are registered, new pages are in sidebar nav.',
    phase: 'review',
    applicableTypes: 'all',
    priority: 'advisory',
  },
  {
    id: 'no-regressions',
    label: 'No regressions',
    description: 'Grepped for patterns related to changes and verified nothing is stale or inconsistent.',
    phase: 'review',
    applicableTypes: 'all',
    priority: 'advisory',
  },
  // --- Change 4: Structural live-data test ---
  {
    id: 'live-data-test',
    label: 'Live data output pasted',
    description:
      'Run the new/changed code against real data. Paste the ACTUAL command output into Key Decisions — ' +
      'not "I verified it works" but the literal output. For DB changes: paste query results showing real rows. ' +
      'For CLI: paste the command and its output. For API endpoints: paste the curl response. ' +
      'If the output is too long, paste a representative sample with row/item counts. ' +
      'This item is not checked until output is visible in Key Decisions or the PR description.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands', 'bugfix', 'refactor'],
    priority: 'blocking',
  },
  {
    id: 'entitylinks-resolve',
    label: 'EntityLinks resolve',
    description: 'Every `<EntityLink id="X">` has a matching entity in `data/entities/*.yaml`.',
    phase: 'review',
    applicableTypes: ['content'],
    priority: 'blocking',
    verifyCommand: 'pnpm crux validate unified --rules=entity-links --errors-only',
  },
  {
    id: 'numeric-ids-stable',
    label: 'Numeric IDs stable',
    description: 'No `numericId` values were removed or changed in entity YAML.',
    phase: 'review',
    applicableTypes: ['content'],
    priority: 'blocking',
    verifyCommand: 'pnpm crux validate unified --rules=numeric-id-integrity --errors-only',
  },
  {
    id: 'ids-server-allocated',
    label: 'Entity IDs from server',
    description:
      'Any new entities or pages have `numericId` allocated from the wiki-server via `pnpm crux ids allocate <slug>` — never manually invented. ' +
      'The gate runs `assign-ids.mjs` automatically, but allocating early prevents conflicts between concurrent agents.',
    phase: 'review',
    applicableTypes: 'all',
    priority: 'blocking',
    verifyCommand: 'node --import tsx/esm apps/web/scripts/assign-ids.mjs --dry-run',
  },
  {
    id: 'mdx-escaping',
    label: 'MDX escaping correct',
    description: 'No unescaped `$` or `<` in prose. Run `crux validate unified --rules=comparison-operators,dollar-signs`.',
    phase: 'review',
    applicableTypes: ['content'],
    priority: 'blocking',
    verifyCommand: 'pnpm crux validate unified --rules=comparison-operators,dollar-signs --errors-only',
  },
  {
    id: 'content-accuracy',
    label: 'Content accuracy',
    description: 'No round-number statistics without citations, no claims contradicting page data.',
    phase: 'review',
    applicableTypes: ['content'],
    priority: 'blocking',
  },
  {
    id: 'citations-have-urls',
    label: 'Citations have URLs',
    description:
      'Every `[^N]:` footnote definition contains a markdown link `[Title](https://...)` or bare URL. Run `pnpm crux validate unified --rules=no-url-footnotes,citation-urls` to catch placeholders and missing URLs automatically.',
    phase: 'review',
    applicableTypes: ['content'],
    priority: 'blocking',
    verifyCommand: 'pnpm crux validate unified --rules=no-url-footnotes,citation-urls --errors-only',
  },
  {
    id: 'citations-verify',
    label: 'Citations verified (spot check)',
    description:
      'For high-importance pages or pages with many new citations: run `pnpm crux citations verify <page-id>` to check URLs return 200 and match claimed titles. Focus on any footnote added in this session.',
    phase: 'review',
    applicableTypes: ['content'],
    priority: 'advisory',
  },
  {
    id: 'backward-compatible',
    label: 'Backward compatible',
    description: 'Changes do not break existing consumers, APIs, or data formats.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'refactor'],
    priority: 'blocking',
  },
  {
    id: 'multi-environment',
    label: 'Multi-environment',
    description: 'Works in Claude Code web sandboxes (limited network) and local dev.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands'],
    priority: 'advisory',
  },
  {
    id: 'ci-coverage',
    label: 'CI covers new code',
    description: 'If you added a new test suite, package, or build step: verify it is wired into `.github/workflows/ci.yml`. New `pnpm test` invocations or scripts need a corresponding CI job step — they do not run automatically.',
    phase: 'review',
    applicableTypes: ['infrastructure', 'commands', 'refactor'],
    priority: 'advisory',
  },
  {
    id: 'tooling-gaps-found',
    label: 'Tooling gaps identified',
    description:
      'Before shipping: ask "what did I catch or fix manually in this session that a linter/validator could have caught automatically?" ' +
      'List each gap in the Key Decisions section below (even if the answer is "none"). ' +
      'Examples: patterns caught at PR review, fixes applied by hand that could be automated, CI checks that are missing.',
    phase: 'review',
    applicableTypes: 'all',
    priority: 'advisory',
  },

  // =========================================================================
  // Phase 4: Ship
  // =========================================================================
  {
    id: 'self-audit-commands',
    label: 'Re-ran commands',
    description: 'Every command claimed to run has been re-run and output matches claims.',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'self-audit-files',
    label: 'Verified files',
    description: 'Every file said to be modified has been re-read and confirmed correct.',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'self-audit-no-fabrication',
    label: 'No fabricated outputs',
    description: 'Test counts, line counts, and error counts match actual output.',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'lockfile-fresh',
    label: 'Lockfile up to date',
    description: 'If `package.json` changed, run `pnpm install` to update `pnpm-lock.yaml`. CI uses `--frozen-lockfile` and will fail on drift.',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
    verifyCommand: 'pnpm install --frozen-lockfile',
  },
  {
    id: 'gate-passes',
    label: 'Gate passes',
    description: '`pnpm crux validate gate --fix` passes. Record exact test count.',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
    verifyCommand: 'pnpm crux validate gate --fix',
  },
  {
    id: 'pr-description',
    label: 'PR description',
    description:
      'Summary, key changes, test plan. All items checked and true. Run `pnpm crux pr fix-body` to auto-repair any literal \\n in the PR body.',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
    verifyCommand: 'pnpm crux pr fix-body',
  },
  {
    id: 'issue-tracking',
    label: 'Issue tracking',
    description: '`pnpm crux issues done <N> --pr=<URL>` if working on an issue.',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'session-log',
    label: 'Session log',
    description: 'Session log synced to wiki-server DB (via `/agent-session-ready-PR` or `crux wiki-server sync-session`).',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'push-ci-green',
    label: 'Push and CI green',
    description: 'Pushed to remote. CI checks pass (use `pnpm crux ci status --wait`).',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'no-merge-conflicts',
    label: 'No merge conflicts',
    description: 'PR is mergeable (not "dirty"). If conflicts exist, rebase onto main.',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'check-recent-merges',
    label: 'Check recent merges',
    description: 'Reviewed commits merged to main since session started. No conflicts or relevant overlapping changes.',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'blocking',
  },
  {
    id: 'tooling-gaps-actioned',
    label: 'Tooling gaps actioned',
    description:
      'Review the gaps listed under `tooling-gaps-found` in Key Decisions. For each: implement now if easy (<1hr). ' +
      'For harder ones: `pnpm crux issues create "Add validation: <desc>" --label=tooling --model=haiku --criteria="..."` — then paste the URL in Key Decisions.',
    phase: 'ship',
    applicableTypes: 'all',
    priority: 'advisory',
  },
  {
    id: 'crux-typescript',
    label: 'Crux TypeScript check',
    description: '`cd crux && npx tsc --noEmit` passes (if crux/ files changed).',
    phase: 'ship',
    applicableTypes: ['infrastructure', 'commands', 'refactor'],
    priority: 'blocking',
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

    const blockingItems = phaseItems.filter(item => item.priority === 'blocking');
    const advisoryItems = phaseItems.filter(item => item.priority === 'advisory');

    lines.push(`## ${PHASE_LABELS[phase]}`);
    lines.push('');
    if (blockingItems.length > 0) {
      for (const item of blockingItems) {
        itemNumber++;
        const autoTag = item.verifyCommand ? ' *(auto-verify)*' : '';
        lines.push(`${itemNumber}. [ ] \`${item.id}\` **${item.label}**: ${item.description}${autoTag}`);
      }
    }
    if (advisoryItems.length > 0) {
      lines.push('');
      lines.push('*Advisory (recommended but non-blocking):*');
      for (const item of advisoryItems) {
        itemNumber++;
        const autoTag = item.verifyCommand ? ' *(auto-verify)*' : '';
        lines.push(`${itemNumber}. [ ] \`${item.id}\` ${item.label}: ${item.description}${autoTag}`);
      }
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

  // Pattern for new numbered format: "1. [ ] `id` **Label**: ..." (blocking) or "1. [ ] `id` Label: ..." (advisory)
  const numberedPattern = /^(\d+)\. \[([ x~])\] `([^`]+)` (?:\*\*([^*]+)\*\*|([^:]+)):/;
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
  // New numbered format: "1. [ ] `id` **Label**: ..." (blocking) or "1. [ ] `id` Label: ..." (advisory)
  const numberedItemPattern = /^\d+\. \[([ x~])\] `([^`]+)` (?:\*\*([^*]+)\*\*|([^:]+)):/;
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
        const label = (numberedMatch[3] || numberedMatch[4]).replace(/:$/, '');
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
      // Look up priority from catalog; default to blocking for unknown items
      const catalogItem = CHECKLIST_ITEMS.find(ci => ci.id === item.id);
      const isAdvisory = catalogItem?.priority === 'advisory';
      const prefix = isAdvisory ? `${c.dim}(advisory)${c.reset} ` : '';
      if (item.status === 'checked') {
        lines.push(`  ${c.green}[x]${c.reset} ${c.dim}${item.id}${c.reset} ${prefix}${item.label}`);
      } else if (item.status === 'na') {
        const reasonSuffix = item.naReason ? ` (N/A: ${item.naReason})` : ' (N/A)';
        lines.push(`  ${c.dim}[~]${c.reset} ${c.dim}${item.id}${c.reset} ${prefix}${c.dim}${item.label}${reasonSuffix}${c.reset}`);
      } else {
        const color = isAdvisory ? c.yellow : c.red;
        lines.push(`  ${color}[ ]${c.reset} ${c.dim}${item.id}${c.reset} ${prefix}${item.label}`);
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
