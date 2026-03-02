/**
 * Tests for crux/lib/session-checklist.ts (simplified)
 *
 * Focus areas:
 * - buildChecklist includes/excludes correct items per session type
 * - parseChecklist handles [x], [ ], [~] markers
 * - checkItems mutates markdown correctly
 * - detectTypeFromLabels maps labels to session types
 * - getItemsForType filters catalog correctly
 * - snapshot and header parsing
 */

import { describe, it, expect } from 'vitest';
import {
  buildChecklist,
  parseChecklist,
  checkItems,
  detectTypeFromLabels,
  getItemsForType,
  CHECKLIST_ITEMS,
  buildChecklistSnapshot,
  formatSnapshotAsYaml,
  parseChecklistHeader,
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

  it('includes content-specific items only for content type', () => {
    const contentItems = getItemsForType('content');
    const infraItems = getItemsForType('infrastructure');

    expect(contentItems.some(i => i.id === 'entitylinks-resolve')).toBe(true);
    expect(contentItems.some(i => i.id === 'mdx-escaping')).toBe(true);

    expect(infraItems.some(i => i.id === 'entitylinks-resolve')).toBe(false);
    expect(infraItems.some(i => i.id === 'mdx-escaping')).toBe(false);
  });

  it('includes crux-typescript for infrastructure, commands, refactor but not content or bugfix', () => {
    expect(getItemsForType('infrastructure').some(i => i.id === 'crux-typescript')).toBe(true);
    expect(getItemsForType('commands').some(i => i.id === 'crux-typescript')).toBe(true);
    expect(getItemsForType('refactor').some(i => i.id === 'crux-typescript')).toBe(true);
    expect(getItemsForType('content').some(i => i.id === 'crux-typescript')).toBe(false);
    expect(getItemsForType('bugfix').some(i => i.id === 'crux-typescript')).toBe(false);
  });

  it('all types get universal items', () => {
    const types: SessionType[] = ['content', 'infrastructure', 'bugfix', 'refactor', 'commands'];
    const universalIds = [
      'fix-escaping', 'lockfile-fresh', 'gate-passes', 'pr-description',
      'ids-server-allocated', 'duplicate-check', 'tests-written', 'scope-complete',
      'security', 'issue-tracking', 'push-ci-green',
    ];

    for (const type of types) {
      const items = getItemsForType(type);
      for (const id of universalIds) {
        expect(items.some(i => i.id === id), `${id} should be in ${type}`).toBe(true);
      }
    }
  });

  it('includes red-team for infrastructure, commands, bugfix, refactor but not content', () => {
    expect(getItemsForType('infrastructure').some(i => i.id === 'red-team')).toBe(true);
    expect(getItemsForType('commands').some(i => i.id === 'red-team')).toBe(true);
    expect(getItemsForType('bugfix').some(i => i.id === 'red-team')).toBe(true);
    expect(getItemsForType('refactor').some(i => i.id === 'red-team')).toBe(true);
    expect(getItemsForType('content').some(i => i.id === 'red-team')).toBe(false);
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

  it('includes Key Decisions section', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    expect(md).toContain('## Key Decisions');
  });

  it('all items start unchecked', () => {
    const md = buildChecklist('content', BASE_METADATA);
    const checked = (md.match(/\[x\]/g) || []).length;
    const unchecked = (md.match(/\[ \]/g) || []).length;
    expect(checked).toBe(0);
    expect(unchecked).toBeGreaterThan(0);
  });

  it('content checklist includes EntityLinks item', () => {
    const md = buildChecklist('content', BASE_METADATA);
    expect(md).toContain('EntityLinks resolve');
  });

  it('infrastructure checklist does not include content-specific items', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    expect(md).not.toContain('EntityLinks resolve');
    expect(md).not.toContain('MDX escaping');
  });

  it('items are numbered sequentially', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const lines = md.split('\n');
    const numberedLines = lines.filter(l => /^\d+\. \[ \]/.test(l));
    expect(numberedLines.length).toBeGreaterThan(0);
    expect(numberedLines[0]).toMatch(/^1\. /);
    for (let i = 0; i < numberedLines.length; i++) {
      expect(numberedLines[i]).toMatch(new RegExp(`^${i + 1}\\.`));
    }
  });

  it('items include their catalog ID in backticks', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    expect(md).toContain('`fix-escaping`');
    expect(md).toContain('`gate-passes`');
    expect(md).toContain('`tests-written`');
  });
});

// ---------------------------------------------------------------------------
// parseChecklist
// ---------------------------------------------------------------------------

describe('parseChecklist', () => {
  it('parses unchecked items from build output', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const status = parseChecklist(md);
    expect(status.totalItems).toBeGreaterThan(0);
    expect(status.totalChecked).toBe(0);
    expect(status.allPassing).toBe(false);
  });

  it('parses checked items', () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)
2. [x] \`gate-passes\` Gate passes (auto-verify)
3. [ ] \`tests-written\` Tests written for new logic
`;
    const status = parseChecklist(md);
    expect(status.totalItems).toBe(3);
    expect(status.totalChecked).toBe(2);
    expect(status.allPassing).toBe(false);
  });

  it('preserves exact IDs from markdown', () => {
    const md = `1. [ ] \`fix-escaping\` Fix escaping (auto-verify)
2. [x] \`gate-passes\` Gate passes (auto-verify)
`;
    const status = parseChecklist(md);
    expect(status.items[0].id).toBe('fix-escaping');
    expect(status.items[1].id).toBe('gate-passes');
  });

  it('treats [~] (N/A) as passing', () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)
2. [~] \`security\` No secrets, no unsanitized input
3. [x] \`gate-passes\` Gate passes (auto-verify)
`;
    const status = parseChecklist(md);
    expect(status.totalItems).toBe(3);
    expect(status.totalChecked).toBe(3);
    expect(status.allPassing).toBe(true);
  });

  it('round-trips through build then parse', () => {
    const md = buildChecklist('bugfix', BASE_METADATA);
    const status = parseChecklist(md);
    const expectedCount = getItemsForType('bugfix').length;
    expect(status.totalItems).toBe(expectedCount);
    expect(status.totalChecked).toBe(0);
    const allParsedIds = new Set(status.items.map(i => i.id));
    const expectedIds = new Set(getItemsForType('bugfix').map(i => i.id));
    expect(allParsedIds).toEqual(expectedIds);
  });

  it('handles empty input', () => {
    const status = parseChecklist('');
    expect(status.totalItems).toBe(0);
    expect(status.totalChecked).toBe(0);
    expect(status.allPassing).toBe(true);
    expect(status.decisions).toHaveLength(0);
  });

  it('parses N/A reason from HTML comment', () => {
    const md = `1. [~] \`issue-tracking\` Issue tracking done <!-- N/A: no GitHub issue -->`;
    const status = parseChecklist(md);
    expect(status.items[0].status).toBe('na');
    expect(status.items[0].naReason).toBe('no GitHub issue');
  });
});

// ---------------------------------------------------------------------------
// parseChecklist — decisions
// ---------------------------------------------------------------------------

describe('parseChecklist (decisions)', () => {
  it('parses decisions from Key Decisions section', () => {
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)

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
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)

## Key Decisions

<!-- Log important decisions as you go. -->
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
    const md = `1. [x] \`fix-escaping\` Fix escaping (auto-verify)

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
// checkItems
// ---------------------------------------------------------------------------

describe('checkItems', () => {
  it('checks off a single item', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const result = checkItems(md, ['fix-escaping']);
    expect(result.checked).toEqual(['fix-escaping']);
    expect(result.notFound).toEqual([]);
    const status = parseChecklist(result.markdown);
    const item = status.items.find(i => i.id === 'fix-escaping');
    expect(item?.status).toBe('checked');
  });

  it('checks off multiple items at once', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const result = checkItems(md, ['fix-escaping', 'lockfile-fresh', 'gate-passes']);
    expect(result.checked).toEqual(['fix-escaping', 'lockfile-fresh', 'gate-passes']);
    expect(result.notFound).toEqual([]);
  });

  it('marks items as N/A with ~ marker', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const result = checkItems(md, ['fix-escaping'], '~');
    expect(result.checked).toEqual(['fix-escaping']);
    const status = parseChecklist(result.markdown);
    const item = status.items.find(i => i.id === 'fix-escaping');
    expect(item?.status).toBe('na');
  });

  it('adds N/A reason as HTML comment', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const result = checkItems(md, ['fix-escaping'], '~', 'no MDX changes');
    expect(result.markdown).toContain('<!-- N/A: no MDX changes -->');
  });

  it('reports not-found IDs', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const result = checkItems(md, ['fix-escaping', 'nonexistent-id']);
    expect(result.checked).toEqual(['fix-escaping']);
    expect(result.notFound).toEqual(['nonexistent-id']);
  });

  it('handles all not-found IDs', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const result = checkItems(md, ['fake-1', 'fake-2']);
    expect(result.checked).toEqual([]);
    expect(result.notFound).toEqual(['fake-1', 'fake-2']);
  });

  it('idempotent: re-checking already-checked item works', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const first = checkItems(md, ['fix-escaping']);
    const second = checkItems(first.markdown, ['fix-escaping']);
    expect(second.checked).toEqual(['fix-escaping']);
    const status = parseChecklist(second.markdown);
    const item = status.items.find(i => i.id === 'fix-escaping');
    expect(item?.status).toBe('checked');
  });

  it('round-trip: check all items then verify allPassing', () => {
    const md = buildChecklist('bugfix', BASE_METADATA);
    const allIds = getItemsForType('bugfix').map(i => i.id);
    const result = checkItems(md, allIds);
    expect(result.notFound).toEqual([]);
    const status = parseChecklist(result.markdown);
    expect(status.allPassing).toBe(true);
    expect(status.totalChecked).toBe(status.totalItems);
  });
});

// ---------------------------------------------------------------------------
// detectTypeFromLabels
// ---------------------------------------------------------------------------

describe('detectTypeFromLabels', () => {
  it('maps bug to bugfix', () => expect(detectTypeFromLabels(['bug'])).toBe('bugfix'));
  it('maps defect to bugfix', () => expect(detectTypeFromLabels(['defect'])).toBe('bugfix'));
  it('maps refactor to refactor', () => expect(detectTypeFromLabels(['refactor'])).toBe('refactor'));
  it('maps cleanup to refactor', () => expect(detectTypeFromLabels(['cleanup'])).toBe('refactor'));
  it('maps content to content', () => expect(detectTypeFromLabels(['content'])).toBe('content'));
  it('maps wiki to content', () => expect(detectTypeFromLabels(['wiki'])).toBe('content'));
  it('maps page to content', () => expect(detectTypeFromLabels(['page'])).toBe('content'));
  it('maps claude-commands to commands', () => expect(detectTypeFromLabels(['claude-commands'])).toBe('commands'));
  it('defaults to infrastructure for unknown labels', () => expect(detectTypeFromLabels(['enhancement', 'P1'])).toBe('infrastructure'));
  it('defaults to infrastructure for empty labels', () => expect(detectTypeFromLabels([])).toBe('infrastructure'));
  it('returns first match when multiple type labels present', () => expect(detectTypeFromLabels(['bug', 'refactor'])).toBe('bugfix'));
  it('is case-insensitive', () => {
    expect(detectTypeFromLabels(['Bug'])).toBe('bugfix');
    expect(detectTypeFromLabels(['REFACTOR'])).toBe('refactor');
  });
});

// ---------------------------------------------------------------------------
// Catalog integrity
// ---------------------------------------------------------------------------

describe('checklist catalog integrity', () => {
  it('all items have unique ids', () => {
    const ids = CHECKLIST_ITEMS.map(i => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all items have non-empty labels', () => {
    for (const item of CHECKLIST_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
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

  it('verifyCommand items reference non-empty commands', () => {
    const verifiable = CHECKLIST_ITEMS.filter(i => i.verifyCommand);
    expect(verifiable.length).toBeGreaterThan(0);
    for (const item of verifiable) {
      expect(item.verifyCommand!.length).toBeGreaterThan(0);
    }
  });

  it('catalog has exactly 15 items', () => {
    expect(CHECKLIST_ITEMS.length).toBe(15);
  });

  it('all items have valid priority', () => {
    const validPriorities = new Set(['blocking', 'advisory']);
    for (const item of CHECKLIST_ITEMS) {
      expect(validPriorities.has(item.priority)).toBe(true);
    }
  });

  it('all current items are blocking', () => {
    expect(CHECKLIST_ITEMS.every(i => i.priority === 'blocking')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseChecklistHeader
// ---------------------------------------------------------------------------

describe('parseChecklistHeader', () => {
  it('extracts type and timestamp from generated checklist', () => {
    const md = buildChecklist('content', BASE_METADATA);
    const header = parseChecklistHeader(md);
    expect(header.type).toBe('content');
    expect(header.initiated_at).toBe('2026-02-18T12:00:00Z');
  });

  it('returns nulls for empty input', () => {
    const header = parseChecklistHeader('');
    expect(header.type).toBeNull();
    expect(header.initiated_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildChecklistSnapshot + formatSnapshotAsYaml
// ---------------------------------------------------------------------------

describe('buildChecklistSnapshot', () => {
  it('produces snapshot from generated checklist', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const snap = buildChecklistSnapshot(md);
    expect(snap.initialized).toBe(true);
    expect(snap.type).toBe('infrastructure');
    expect(snap.initiated_at).toBe('2026-02-18T12:00:00Z');
    expect(snap.total).toBe(getItemsForType('infrastructure').length);
    expect(snap.completed).toBe(0);
    expect(snap.items).toEqual([]);
  });

  it('tracks completed items', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const result = checkItems(md, ['fix-escaping', 'gate-passes']);
    const snap = buildChecklistSnapshot(result.markdown);
    expect(snap.completed).toBe(2);
    expect(snap.items).toContain('fix-escaping');
    expect(snap.items).toContain('gate-passes');
  });

  it('tracks N/A items separately', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const result = checkItems(md, ['fix-escaping'], '~', 'not needed');
    const snap = buildChecklistSnapshot(result.markdown);
    expect(snap.na).toBe(1);
    expect(snap.completed).toBe(0);
  });
});

describe('formatSnapshotAsYaml', () => {
  it('formats initialized snapshot as YAML', () => {
    const md = buildChecklist('infrastructure', BASE_METADATA);
    const snap = buildChecklistSnapshot(md);
    const yaml = formatSnapshotAsYaml(snap);
    expect(yaml).toContain('checks:');
    expect(yaml).toContain('initialized: true');
    expect(yaml).toContain('type: infrastructure');
    expect(yaml).toContain('items: []');
  });

  it('formats uninitialized snapshot', () => {
    const yaml = formatSnapshotAsYaml({ initialized: false });
    expect(yaml).toContain('initialized: false');
  });
});
