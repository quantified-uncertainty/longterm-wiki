/**
 * Tests for crux/lib/session-checklist.ts
 *
 * Focus areas:
 * - buildChecklist includes/excludes correct items per session type
 * - parseChecklist handles [x], [ ], [~] markers correctly
 * - detectTypeFromLabels maps labels to session types
 * - formatStatus produces correct terminal output
 * - getItemsForType filters catalog correctly
 */

import { describe, it, expect } from 'vitest';
import {
  buildChecklist,
  parseChecklist,
  detectTypeFromLabels,
  formatStatus,
  getItemsForType,
  CHECKLIST_ITEMS,
  type SessionType,
  type ChecklistMetadata,
} from './session-checklist.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_METADATA: ChecklistMetadata = {
  task: 'Test task description',
  branch: 'claude/test-branch',
  timestamp: '2026-02-18T12:00:00Z',
};

const NO_COLORS = {
  green: '',
  yellow: '',
  red: '',
  cyan: '',
  bold: '',
  dim: '',
  reset: '',
};

// ---------------------------------------------------------------------------
// getItemsForType
// ---------------------------------------------------------------------------

describe('getItemsForType', () => {
  it('returns universal items for every type', () => {
    const types: SessionType[] = ['content', 'infrastructure', 'bugfix', 'refactor', 'commands'];
    const universalItems = CHECKLIST_ITEMS.filter(i => i.applicableTypes === 'all');

    for (const type of types) {
      const items = getItemsForType(type);
      for (const universal of universalItems) {
        expect(items.some(i => i.id === universal.id)).toBe(true);
      }
    }
  });

  it('includes bugfix-specific items only for bugfix type', () => {
    const bugfixItems = getItemsForType('bugfix');
    const infraItems = getItemsForType('infrastructure');

    expect(bugfixItems.some(i => i.id === 'root-cause')).toBe(true);
    expect(bugfixItems.some(i => i.id === 'regression-test')).toBe(true);
    expect(bugfixItems.some(i => i.id === 'fix-minimal')).toBe(true);

    expect(infraItems.some(i => i.id === 'root-cause')).toBe(false);
    expect(infraItems.some(i => i.id === 'regression-test')).toBe(false);
  });

  it('includes content-specific items only for content type', () => {
    const contentItems = getItemsForType('content');
    const infraItems = getItemsForType('infrastructure');

    expect(contentItems.some(i => i.id === 'research-content')).toBe(true);
    expect(contentItems.some(i => i.id === 'crux-pipeline')).toBe(true);
    expect(contentItems.some(i => i.id === 'entitylinks-resolve')).toBe(true);
    expect(contentItems.some(i => i.id === 'content-accuracy')).toBe(true);

    expect(infraItems.some(i => i.id === 'research-content')).toBe(false);
    expect(infraItems.some(i => i.id === 'crux-pipeline')).toBe(false);
  });

  it('includes commands-specific items only for commands type', () => {
    const cmdItems = getItemsForType('commands');
    const contentItems = getItemsForType('content');

    expect(cmdItems.some(i => i.id === 'command-registered')).toBe(true);
    expect(cmdItems.some(i => i.id === 'command-documented')).toBe(true);

    expect(contentItems.some(i => i.id === 'command-registered')).toBe(false);
  });

  it('includes refactor-specific items only for refactor type', () => {
    const refactorItems = getItemsForType('refactor');
    const bugfixItems = getItemsForType('bugfix');

    expect(refactorItems.some(i => i.id === 'behavior-unchanged')).toBe(true);
    expect(refactorItems.some(i => i.id === 'callers-updated')).toBe(true);

    expect(bugfixItems.some(i => i.id === 'behavior-unchanged')).toBe(false);
  });

  it('content type has more items than infrastructure', () => {
    const contentItems = getItemsForType('content');
    const infraItems = getItemsForType('infrastructure');
    expect(contentItems.length).toBeGreaterThan(infraItems.length);
  });
});

// ---------------------------------------------------------------------------
// buildChecklist
// ---------------------------------------------------------------------------

describe('buildChecklist', () => {
  it('generates valid markdown with header and metadata', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    expect(md).toContain('# Session Checklist');
    expect(md).toContain('Type: **infrastructure**');
    expect(md).toContain('Branch: `claude/test-branch`');
    expect(md).toContain('Task: Test task description');
    expect(md).toContain('2026-02-18T12:00:00Z');
  });

  it('includes issue number when provided', () => {
    const md = buildChecklist('bugfix', { ...BASE_METADATA, issue: 42 });
    expect(md).toContain('Issue: #42');
  });

  it('omits issue line when not provided', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    expect(md).not.toContain('Issue:');
  });

  it('includes all four phases and Key Decisions section', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    expect(md).toContain('## Phase 1: Understand');
    expect(md).toContain('## Phase 2: Implement');
    expect(md).toContain('## Phase 3: Review');
    expect(md).toContain('## Phase 4: Ship');
    expect(md).toContain('## Key Decisions');
  });

  it('all items start unchecked', () => {
    const md = buildChecklist('content', BASE_METADATA);
    const checked = (md.match(/- \[x\]/g) || []).length;
    const unchecked = (md.match(/- \[ \]/g) || []).length;
    expect(checked).toBe(0);
    expect(unchecked).toBeGreaterThan(0);
  });

  it('bugfix checklist includes root cause item', () => {
    const md = buildChecklist('bugfix', BASE_METADATA);
    expect(md).toContain('Root cause identified');
  });

  it('content checklist includes EntityLinks item', () => {
    const md = buildChecklist('content', BASE_METADATA);
    expect(md).toContain('EntityLinks resolve');
  });

  it('infrastructure checklist does not include content-specific items', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    expect(md).not.toContain('EntityLinks resolve');
    expect(md).not.toContain('Root cause identified');
    expect(md).not.toContain('crux content pipeline');
  });

  it('commands checklist includes command registration items', () => {
    const md = buildChecklist('commands', BASE_METADATA);
    expect(md).toContain('Command registered');
    expect(md).toContain('Command documented');
  });
});

// ---------------------------------------------------------------------------
// parseChecklist
// ---------------------------------------------------------------------------

describe('parseChecklist', () => {
  it('parses unchecked items', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const status = parseChecklist(md);
    expect(status.totalItems).toBeGreaterThan(0);
    expect(status.totalChecked).toBe(0);
    expect(status.allPassing).toBe(false);
  });

  it('parses checked items (x marker)', () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Read it.
- [x] **Explore relevant code**: Read files.
- [ ] **Plan approach**: Think.

## Phase 4: Ship

- [x] **Gate passes**: It passes.
`;
    const status = parseChecklist(md);
    expect(status.totalItems).toBe(4);
    expect(status.totalChecked).toBe(3);
    expect(status.allPassing).toBe(false);
  });

  it('treats [~] (N/A) as passing', () => {
    const md = `## Phase 3: Review

- [x] **Correctness verified**: Done.
- [~] **No shell injection**: N/A, no curl commands.
- [x] **Security checked**: Done.
`;
    const status = parseChecklist(md);
    expect(status.totalItems).toBe(3);
    expect(status.totalChecked).toBe(3);
    expect(status.allPassing).toBe(true);
  });

  it('reports allPassing when all items are checked or N/A', () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Done.
- [x] **Explore relevant code**: Done.

## Phase 4: Ship

- [~] **Gate passes**: N/A.
`;
    const status = parseChecklist(md);
    expect(status.allPassing).toBe(true);
  });

  it('groups items by phase correctly', () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Done.

## Phase 2: Implement

- [ ] **Tests written**: Not yet.
- [ ] **No hardcoded constants**: Not yet.

## Phase 3: Review

- [ ] **Correctness verified**: Not yet.
`;
    const status = parseChecklist(md);
    expect(status.phases).toHaveLength(3);
    expect(status.phases[0].phase).toBe('understand');
    expect(status.phases[0].items).toHaveLength(1);
    expect(status.phases[1].phase).toBe('implement');
    expect(status.phases[1].items).toHaveLength(2);
    expect(status.phases[2].phase).toBe('review');
    expect(status.phases[2].items).toHaveLength(1);
  });

  it('handles empty input', () => {
    const status = parseChecklist('');
    expect(status.totalItems).toBe(0);
    expect(status.totalChecked).toBe(0);
    expect(status.allPassing).toBe(true); // vacuously true
    expect(status.decisions).toHaveLength(0);
  });

  it('round-trips through build then parse', () => {
    const md = buildChecklist('bugfix', BASE_METADATA);
    const status = parseChecklist(md);
    const expectedCount = getItemsForType('bugfix').length;
    expect(status.totalItems).toBe(expectedCount);
    expect(status.totalChecked).toBe(0);
  });

  it('parses decisions from Key Decisions section', () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Done.

## Key Decisions

- **Used TypeScript over .mjs**: Better type safety for the new module.
- **Chose catalog pattern over template**: More flexible, testable.
`;
    const status = parseChecklist(md);
    expect(status.decisions).toHaveLength(2);
    expect(status.decisions[0]).toContain('Used TypeScript over .mjs');
    expect(status.decisions[1]).toContain('Chose catalog pattern over template');
  });

  it('ignores HTML comments in Key Decisions section', () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Done.

## Key Decisions

<!-- Log important decisions as you go. -->
<!-- Format: - **Decision**: rationale -->
- **Picked approach A**: Simpler.
`;
    const status = parseChecklist(md);
    expect(status.decisions).toHaveLength(1);
    expect(status.decisions[0]).toContain('Picked approach A');
  });

  it('returns empty decisions when section has no entries', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const status = parseChecklist(md);
    expect(status.decisions).toHaveLength(0);
  });

  it('decisions do not count as checklist items', () => {
    const md = `## Phase 1: Understand

- [x] **Read the issue/request**: Done.

## Key Decisions

- **Some decision**: Rationale here.
`;
    const status = parseChecklist(md);
    expect(status.totalItems).toBe(1);
    expect(status.totalChecked).toBe(1);
    expect(status.decisions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// detectTypeFromLabels
// ---------------------------------------------------------------------------

describe('detectTypeFromLabels', () => {
  it('maps bug to bugfix', () => {
    expect(detectTypeFromLabels(['bug'])).toBe('bugfix');
  });

  it('maps defect to bugfix', () => {
    expect(detectTypeFromLabels(['defect'])).toBe('bugfix');
  });

  it('maps refactor to refactor', () => {
    expect(detectTypeFromLabels(['refactor'])).toBe('refactor');
  });

  it('maps cleanup to refactor', () => {
    expect(detectTypeFromLabels(['cleanup'])).toBe('refactor');
  });

  it('maps content to content', () => {
    expect(detectTypeFromLabels(['content'])).toBe('content');
  });

  it('maps wiki to content', () => {
    expect(detectTypeFromLabels(['wiki'])).toBe('content');
  });

  it('maps page to content', () => {
    expect(detectTypeFromLabels(['page'])).toBe('content');
  });

  it('maps claude-commands to commands', () => {
    expect(detectTypeFromLabels(['claude-commands'])).toBe('commands');
  });

  it('defaults to infrastructure for unknown labels', () => {
    expect(detectTypeFromLabels(['enhancement', 'P1'])).toBe('infrastructure');
  });

  it('defaults to infrastructure for empty labels', () => {
    expect(detectTypeFromLabels([])).toBe('infrastructure');
  });

  it('returns first match when multiple type labels present', () => {
    // 'bug' comes first, so 'bugfix' wins
    expect(detectTypeFromLabels(['bug', 'refactor'])).toBe('bugfix');
  });

  it('is case-insensitive', () => {
    expect(detectTypeFromLabels(['Bug'])).toBe('bugfix');
    expect(detectTypeFromLabels(['REFACTOR'])).toBe('refactor');
  });
});

// ---------------------------------------------------------------------------
// formatStatus
// ---------------------------------------------------------------------------

describe('formatStatus', () => {
  it('shows progress summary', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const status = parseChecklist(md);
    const output = formatStatus(status, NO_COLORS);
    expect(output).toContain('Session Checklist Progress');
    expect(output).toContain(`0/${status.totalItems}`);
    expect(output).toContain('0%');
  });

  it('shows 100% when all items passing', () => {
    const status = parseChecklist(`## Phase 1: Understand

- [x] **Read the issue/request**: Done.
- [x] **Explore relevant code**: Done.
`);
    const output = formatStatus(status, NO_COLORS);
    expect(output).toContain('2/2');
    expect(output).toContain('100%');
  });

  it('marks N/A items with tilde', () => {
    const status = parseChecklist(`## Phase 3: Review

- [~] **Shell injection**: N/A.
`);
    const output = formatStatus(status, NO_COLORS);
    expect(output).toContain('[~]');
    expect(output).toContain('N/A');
  });

  it('marks unchecked items with empty brackets', () => {
    const status = parseChecklist(`## Phase 2: Implement

- [ ] **Tests written**: Not yet.
`);
    const output = formatStatus(status, NO_COLORS);
    expect(output).toContain('[ ]');
    expect(output).toContain('Tests written');
  });

  it('shows key decisions when present', () => {
    const status = parseChecklist(`## Phase 1: Understand

- [x] **Read the issue/request**: Done.

## Key Decisions

- **Used catalog pattern**: More flexible than static template.
- **Added decision log**: Feeds into session logs.
`);
    const output = formatStatus(status, NO_COLORS);
    expect(output).toContain('Key Decisions (2)');
    expect(output).toContain('Used catalog pattern');
    expect(output).toContain('Added decision log');
  });

  it('omits key decisions section when empty', () => {
    const status = parseChecklist(`## Phase 1: Understand

- [x] **Read the issue/request**: Done.
`);
    const output = formatStatus(status, NO_COLORS);
    expect(output).not.toContain('Key Decisions');
  });
});

// ---------------------------------------------------------------------------
// Catalog integrity
// ---------------------------------------------------------------------------

describe('checklist catalog integrity', () => {
  it('all items have unique ids', () => {
    const ids = CHECKLIST_ITEMS.map(i => i.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all items have non-empty labels and descriptions', () => {
    for (const item of CHECKLIST_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  it('all items have valid phases', () => {
    const validPhases = new Set(['understand', 'implement', 'review', 'ship']);
    for (const item of CHECKLIST_ITEMS) {
      expect(validPhases.has(item.phase)).toBe(true);
    }
  });

  it('all items have valid applicableTypes', () => {
    const validTypes = new Set(['content', 'infrastructure', 'bugfix', 'refactor', 'commands']);
    for (const item of CHECKLIST_ITEMS) {
      if (item.applicableTypes === 'all') continue;
      for (const t of item.applicableTypes) {
        expect(validTypes.has(t)).toBe(true);
      }
    }
  });

  it('catalog has items in all four phases', () => {
    const phases = new Set(CHECKLIST_ITEMS.map(i => i.phase));
    expect(phases.has('understand')).toBe(true);
    expect(phases.has('implement')).toBe(true);
    expect(phases.has('review')).toBe(true);
    expect(phases.has('ship')).toBe(true);
  });
});
