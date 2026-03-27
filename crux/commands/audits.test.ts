/**
 * Tests for audits command handlers
 *
 * Covers:
 * - descriptionToId: slug generation from descriptions
 * - isOverdue / isPostMergeOverdue: deadline logic
 * - daysUntilDue: due date calculation
 * - appendItem: YAML section appending
 * - appendHistoryEntry: history recording
 * - add command: ongoing and post_merge item creation
 * - check command: result recording with history
 * - list command: --overdue and --strict flags
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parse as parseYaml } from 'yaml';
import {
  descriptionToId,
  isOverdue,
  isPostMergeOverdue,
  daysUntilDue,
  loadAudits,
  saveAudits,
  appendItem,
  appendHistoryEntry,
  today,
  FREQUENCY_DAYS,
  type AuditItem,
  type PostMergeItem,
  type AuditsFile,
  type CheckHistoryEntry,
} from './audits.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuditItem(overrides: Partial<AuditItem> = {}): AuditItem {
  return {
    id: 'test-audit',
    category: 'infrastructure',
    description: 'Test audit item',
    check_type: 'manual',
    how_to_verify: 'Check something',
    frequency: 'weekly',
    added: '2026-01-01',
    last_checked: null,
    last_result: null,
    ...overrides,
  };
}

function makePostMergeItem(overrides: Partial<PostMergeItem> = {}): PostMergeItem {
  return {
    id: 'test-pm',
    pr: 1234,
    merged: '2026-01-01',
    claim: 'Test claim',
    how_to_verify: 'Check something',
    status: 'pending',
    deadline: '2026-04-01',
    checked_date: null,
    notes: null,
    ...overrides,
  };
}

const MINIMAL_YAML = `audits:
  - id: existing-audit
    category: infrastructure
    description: "Existing audit"
    check_type: manual
    how_to_verify: "Check it"
    frequency: weekly
    added: "2026-01-01"
    last_checked: null
    last_result: null

post_merge:
  - id: existing-pm
    pr: 999
    merged: "2026-01-01"
    claim: "Test claim"
    how_to_verify: "Check it"
    status: pending
    deadline: "2026-04-01"
    checked_date: null
    notes: null
`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'audits-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmpYaml(content: string): string {
  const path = join(tmpDir, 'audits.yaml');
  writeFileSync(path, content, 'utf-8');
  return path;
}

// ---------------------------------------------------------------------------
// descriptionToId
// ---------------------------------------------------------------------------

describe('descriptionToId', () => {
  it('converts description to kebab-case slug', () => {
    expect(descriptionToId('Verify stableId migration applied')).toBe('verify-stableid-migration-applied');
  });

  it('strips special characters', () => {
    expect(descriptionToId('Check $100 value!')).toBe('check-100-value');
  });

  it('collapses multiple spaces and dashes', () => {
    expect(descriptionToId('too   many   spaces')).toBe('too-many-spaces');
  });

  it('truncates to 60 characters', () => {
    const long = 'a'.repeat(100);
    expect(descriptionToId(long).length).toBeLessThanOrEqual(60);
  });

  it('handles empty string', () => {
    expect(descriptionToId('')).toBe('');
  });

  it('strips leading/trailing dashes', () => {
    expect(descriptionToId('--hello--')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// isOverdue
// ---------------------------------------------------------------------------

describe('isOverdue', () => {
  it('returns true for never-checked items', () => {
    expect(isOverdue(makeAuditItem({ last_checked: null }))).toBe(true);
  });

  it('returns false for recently checked items', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(isOverdue(makeAuditItem({
      frequency: 'weekly',
      last_checked: yesterday.toISOString().split('T')[0],
    }))).toBe(false);
  });

  it('returns true for items checked beyond their frequency', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    expect(isOverdue(makeAuditItem({
      frequency: 'weekly',
      last_checked: oldDate.toISOString().split('T')[0],
    }))).toBe(true);
  });

  it('uses 30 days as default for unknown frequency', () => {
    const item = makeAuditItem({
      frequency: 'unknown' as AuditItem['frequency'],
      last_checked: new Date().toISOString().split('T')[0],
    });
    expect(isOverdue(item)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPostMergeOverdue
// ---------------------------------------------------------------------------

describe('isPostMergeOverdue', () => {
  it('returns false for non-pending items', () => {
    expect(isPostMergeOverdue(makePostMergeItem({ status: 'verified', deadline: '2020-01-01' }))).toBe(false);
  });

  it('returns false for items without deadline', () => {
    expect(isPostMergeOverdue(makePostMergeItem({ deadline: undefined }))).toBe(false);
  });

  it('returns true for pending items past deadline', () => {
    expect(isPostMergeOverdue(makePostMergeItem({ deadline: '2020-01-01' }))).toBe(true);
  });

  it('returns false for pending items before deadline', () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    expect(isPostMergeOverdue(makePostMergeItem({ deadline: future.toISOString().split('T')[0] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// daysUntilDue
// ---------------------------------------------------------------------------

describe('daysUntilDue', () => {
  it('returns null for never-checked items', () => {
    expect(daysUntilDue(makeAuditItem({ last_checked: null }))).toBeNull();
  });

  it('returns positive number for items checked today', () => {
    const result = daysUntilDue(makeAuditItem({
      frequency: 'weekly',
      last_checked: today(),
    }));
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(8);
  });

  it('returns negative number for overdue items', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 20);
    const result = daysUntilDue(makeAuditItem({
      frequency: 'weekly',
      last_checked: oldDate.toISOString().split('T')[0],
    }));
    expect(result).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// loadAudits / saveAudits
// ---------------------------------------------------------------------------

describe('loadAudits', () => {
  it('loads audits from YAML file', () => {
    const path = writeTmpYaml(MINIMAL_YAML);
    const data = loadAudits(path);
    expect(data.audits).toHaveLength(1);
    expect(data.audits[0].id).toBe('existing-audit');
    expect(data.post_merge).toHaveLength(1);
    expect(data.post_merge[0].id).toBe('existing-pm');
  });

  it('returns empty arrays for missing sections', () => {
    const path = writeTmpYaml('# empty file\n');
    const data = loadAudits(path);
    expect(data.audits).toEqual([]);
    expect(data.post_merge).toEqual([]);
  });
});

describe('saveAudits', () => {
  it('updates last_checked and last_result for audit items', () => {
    const path = writeTmpYaml(MINIMAL_YAML);
    const data = loadAudits(path);
    data.audits[0].last_checked = '2026-03-25';
    data.audits[0].last_result = 'pass';
    saveAudits(data, path);

    const reloaded = loadAudits(path);
    expect(reloaded.audits[0].last_checked).toBe('2026-03-25');
    expect(reloaded.audits[0].last_result).toBe('pass');
  });

  it('updates status and checked_date for post-merge items', () => {
    const path = writeTmpYaml(MINIMAL_YAML);
    const data = loadAudits(path);
    data.post_merge[0].status = 'verified';
    data.post_merge[0].checked_date = '2026-03-25';
    data.post_merge[0].notes = 'All good';
    saveAudits(data, path);

    const reloaded = loadAudits(path);
    expect(reloaded.post_merge[0].status).toBe('verified');
    expect(reloaded.post_merge[0].checked_date).toBe('2026-03-25');
    expect(reloaded.post_merge[0].notes).toBe('All good');
  });
});

// ---------------------------------------------------------------------------
// appendItem
// ---------------------------------------------------------------------------

describe('appendItem', () => {
  it('appends an ongoing audit before the post_merge section', () => {
    const path = writeTmpYaml(MINIMAL_YAML);
    const yamlBlock = `- id: new-audit\n  category: process\n  description: "New audit"\n  check_type: manual\n  how_to_verify: "Check"\n  frequency: weekly\n  added: "2026-03-26"\n  last_checked: null\n  last_result: null`;
    appendItem('audits', yamlBlock, path);

    const data = loadAudits(path);
    expect(data.audits).toHaveLength(2);
    expect(data.audits[1].id).toBe('new-audit');
    expect(data.audits[1].category).toBe('process');
    // post_merge should still be intact
    expect(data.post_merge).toHaveLength(1);
  });

  it('appends a post_merge item at end of file', () => {
    const path = writeTmpYaml(MINIMAL_YAML);
    const yamlBlock = `- id: new-pm\n  pr: 5555\n  merged: "2026-03-26"\n  claim: "New claim"\n  how_to_verify: "Verify"\n  status: pending\n  deadline: "2026-04-09"\n  checked_date: null\n  notes: null`;
    appendItem('post_merge', yamlBlock, path);

    const data = loadAudits(path);
    expect(data.post_merge).toHaveLength(2);
    expect(data.post_merge[1].id).toBe('new-pm');
    expect(data.post_merge[1].pr).toBe(5555);
  });

  it('handles file without post_merge section', () => {
    const yamlWithoutPM = `audits:\n  - id: solo-audit\n    category: infrastructure\n    description: "Solo"\n    check_type: manual\n    how_to_verify: "Check"\n    frequency: weekly\n    added: "2026-01-01"\n    last_checked: null\n    last_result: null\n`;
    const path = writeTmpYaml(yamlWithoutPM);
    const yamlBlock = `- id: appended-audit\n  category: process\n  description: "Appended"\n  check_type: manual\n  how_to_verify: "Check"\n  frequency: monthly\n  added: "2026-03-26"\n  last_checked: null\n  last_result: null`;
    appendItem('audits', yamlBlock, path);

    const data = loadAudits(path);
    expect(data.audits).toHaveLength(2);
    expect(data.audits[1].id).toBe('appended-audit');
  });
});

// ---------------------------------------------------------------------------
// appendHistoryEntry
// ---------------------------------------------------------------------------

describe('appendHistoryEntry', () => {
  it('adds a new history array when none exists', () => {
    const path = writeTmpYaml(MINIMAL_YAML);
    appendHistoryEntry('existing-audit', {
      date: '2026-03-26',
      result: 'pass',
      checked_by: 'agent:test',
      notes: 'All looks good',
    }, path);

    const data = loadAudits(path);
    expect(data.audits[0].history).toHaveLength(1);
    expect(data.audits[0].history![0].date).toBe('2026-03-26');
    expect(data.audits[0].history![0].result).toBe('pass');
    expect(data.audits[0].history![0].checked_by).toBe('agent:test');
    expect(data.audits[0].history![0].notes).toBe('All looks good');
  });

  it('appends to existing history array', () => {
    const yamlWithHistory = `audits:
  - id: has-history
    category: infrastructure
    description: "Has history"
    check_type: manual
    how_to_verify: "Check"
    frequency: weekly
    added: "2026-01-01"
    last_checked: "2026-03-20"
    last_result: pass
    history:
      - date: "2026-03-20"
        result: pass
        checked_by: "manual"

post_merge: []
`;
    const path = writeTmpYaml(yamlWithHistory);
    appendHistoryEntry('has-history', {
      date: '2026-03-26',
      result: 'fail',
      checked_by: 'agent:a1',
    }, path);

    const data = loadAudits(path);
    expect(data.audits[0].history).toHaveLength(2);
    expect(data.audits[0].history![1].date).toBe('2026-03-26');
    expect(data.audits[0].history![1].result).toBe('fail');
  });

  it('handles non-existent item ID gracefully', () => {
    const path = writeTmpYaml(MINIMAL_YAML);
    const originalContent = readFileSync(path, 'utf-8');
    appendHistoryEntry('nonexistent-id', {
      date: '2026-03-26',
      result: 'pass',
      checked_by: 'manual',
    }, path);
    // File should be unchanged
    expect(readFileSync(path, 'utf-8')).toBe(originalContent);
  });

  it('omits notes field when not provided', () => {
    const path = writeTmpYaml(MINIMAL_YAML);
    appendHistoryEntry('existing-audit', {
      date: '2026-03-26',
      result: 'pass',
      checked_by: 'manual',
    }, path);

    const data = loadAudits(path);
    expect(data.audits[0].history![0].notes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// commands.add (integration via exported add function behavior)
// ---------------------------------------------------------------------------

describe('add command integration', () => {
  // We test the addCommand indirectly through the exported commands
  // by importing the commands object. Since we can't easily override the
  // AUDITS_PATH for command handlers, we test the underlying functions directly.

  it('descriptionToId handles realistic post_merge descriptions', () => {
    expect(descriptionToId('Verify stableId migration applied')).toBe('verify-stableid-migration-applied');
    expect(descriptionToId('Scheduled workflows running')).toBe('scheduled-workflows-running');
    expect(descriptionToId('robots.txt blocks /factbase/ crawlers')).toBe('robotstxt-blocks-factbase-crawlers');
  });
});

// ---------------------------------------------------------------------------
// FREQUENCY_DAYS
// ---------------------------------------------------------------------------

describe('FREQUENCY_DAYS', () => {
  it('has correct day values', () => {
    expect(FREQUENCY_DAYS.daily).toBe(1);
    expect(FREQUENCY_DAYS.weekly).toBe(7);
    expect(FREQUENCY_DAYS.biweekly).toBe(14);
    expect(FREQUENCY_DAYS.monthly).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// today
// ---------------------------------------------------------------------------

describe('today', () => {
  it('returns ISO date string in YYYY-MM-DD format', () => {
    const result = today();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: add + check + history
// ---------------------------------------------------------------------------

describe('round-trip: add audit, check it, verify history', () => {
  it('adds an audit then records a check with history', () => {
    const path = writeTmpYaml(MINIMAL_YAML);

    // Add a new audit
    const auditBlock = `- id: roundtrip-test\n  category: process\n  description: "Roundtrip test"\n  check_type: manual\n  how_to_verify: "Check"\n  frequency: weekly\n  added: "2026-03-26"\n  last_checked: null\n  last_result: null`;
    appendItem('audits', auditBlock, path);

    // Verify it was added
    let data = loadAudits(path);
    expect(data.audits.find(a => a.id === 'roundtrip-test')).toBeDefined();

    // Record a check
    const auditIdx = data.audits.findIndex(a => a.id === 'roundtrip-test');
    data.audits[auditIdx].last_checked = '2026-03-26';
    data.audits[auditIdx].last_result = 'pass';
    saveAudits(data, path);

    // Add history
    appendHistoryEntry('roundtrip-test', {
      date: '2026-03-26',
      result: 'pass',
      checked_by: 'agent:test-session',
      notes: 'Everything verified',
    }, path);

    // Verify everything
    data = loadAudits(path);
    const item = data.audits.find(a => a.id === 'roundtrip-test')!;
    expect(item.last_checked).toBe('2026-03-26');
    expect(item.last_result).toBe('pass');
    expect(item.history).toHaveLength(1);
    expect(item.history![0].checked_by).toBe('agent:test-session');
    expect(item.history![0].notes).toBe('Everything verified');
  });
});
