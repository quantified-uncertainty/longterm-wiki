import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSessionLogContent, parseAllSessionLogs } from '../session-log-parser.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('parseSessionLogContent', () => {
  it('parses a single session entry with pages', () => {
    const content = `## 2026-02-15 | claude/my-branch | Fix some bug

**What was done:** Fixed the thing that was broken.

**Pages:** page-one, page-two

**Issues encountered:**
- None
`;
    const result = parseSessionLogContent(content);

    expect(Object.keys(result)).toEqual(['page-one', 'page-two']);
    expect(result['page-one']).toEqual([{
      date: '2026-02-15',
      branch: 'claude/my-branch',
      title: 'Fix some bug',
      summary: 'Fixed the thing that was broken.',
    }]);
    expect(result['page-two']).toEqual([{
      date: '2026-02-15',
      branch: 'claude/my-branch',
      title: 'Fix some bug',
      summary: 'Fixed the thing that was broken.',
    }]);
  });

  it('parses multiple session entries', () => {
    const content = `# Session Log

## 2026-02-14 | claude/branch-a | First session

**What was done:** Did thing A.

**Pages:** alpha

**Issues encountered:**
- None

---

## 2026-02-15 | claude/branch-b | Second session

**What was done:** Did thing B.

**Pages:** beta, gamma

**Issues encountered:**
- None
`;
    const result = parseSessionLogContent(content);

    expect(Object.keys(result).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(result['alpha'][0].date).toBe('2026-02-14');
    expect(result['beta'][0].date).toBe('2026-02-15');
    expect(result['gamma'][0].date).toBe('2026-02-15');
  });

  it('skips entries without Pages field (infrastructure-only)', () => {
    const content = `## 2026-02-15 | claude/infra | Update CI config

**What was done:** Changed CI config.

**Issues encountered:**
- None
`;
    const result = parseSessionLogContent(content);
    expect(Object.keys(result)).toEqual([]);
  });

  it('filters out non-slug page IDs like descriptive text', () => {
    const content = `## 2026-02-15 | claude/fix-tables | Fix tables

**What was done:** Fixed tables.

**Pages:** (no wiki content pages changed)

**Issues encountered:**
- None
`;
    const result = parseSessionLogContent(content);
    expect(Object.keys(result)).toEqual([]);
  });

  it('handles entry at EOF without trailing separator', () => {
    // This tests the edge case where the last entry has no --- or blank line after Pages
    const content = `## 2026-02-15 | claude/eof-test | EOF test

**What was done:** Summary here.

**Pages:** my-page`;
    // This won't match because the regex requires \n\n|\n\*\*|\n--- after the pages field
    // The parser silently skips entries where the Pages field can't be extracted
    const result = parseSessionLogContent(content);
    // The regex needs a terminator — at EOF with no trailing newline, it won't match
    // This is a known limitation; session files should always end with a newline
    expect(Object.keys(result)).toEqual([]);
  });

  it('handles entry at EOF with trailing newline', () => {
    const content = `## 2026-02-15 | claude/eof-test | EOF test

**What was done:** Summary here.

**Pages:** my-page

`;
    // With a trailing blank line the regex can find the \n\n terminator
    const result = parseSessionLogContent(content);
    expect(result['my-page']).toBeDefined();
    expect(result['my-page'][0].title).toBe('EOF test');
  });

  it('accumulates multiple entries for the same page', () => {
    const content = `## 2026-02-14 | claude/a | First edit

**What was done:** First change.

**Pages:** shared-page

---

## 2026-02-15 | claude/b | Second edit

**What was done:** Second change.

**Pages:** shared-page

`;
    const result = parseSessionLogContent(content);
    expect(result['shared-page']).toHaveLength(2);
    expect(result['shared-page'][0].date).toBe('2026-02-14');
    expect(result['shared-page'][1].date).toBe('2026-02-15');
  });
});

describe('parseAllSessionLogs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-log-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads from consolidated log file', () => {
    const logPath = path.join(tmpDir, 'session-log.md');
    fs.writeFileSync(logPath, `## 2026-02-13 | claude/a | Session A

**What was done:** Did A.

**Pages:** page-a

`);
    const sessionsDir = path.join(tmpDir, 'sessions');
    const result = parseAllSessionLogs(logPath, sessionsDir);

    expect(result['page-a']).toHaveLength(1);
    expect(result['page-a'][0].title).toBe('Session A');
  });

  it('reads from individual session files', () => {
    const logPath = path.join(tmpDir, 'session-log.md'); // doesn't exist
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(sessionsDir, '2026-02-15_branch-a.md'), `## 2026-02-15 | claude/branch-a | Session from file

**What was done:** Did something.

**Pages:** page-from-file

`);
    const result = parseAllSessionLogs(logPath, sessionsDir);

    expect(result['page-from-file']).toHaveLength(1);
    expect(result['page-from-file'][0].title).toBe('Session from file');
  });

  it('merges entries from both sources', () => {
    const logPath = path.join(tmpDir, 'session-log.md');
    fs.writeFileSync(logPath, `## 2026-02-13 | claude/old | Old session

**What was done:** Old work.

**Pages:** old-page

`);
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(sessionsDir, '2026-02-15_new.md'), `## 2026-02-15 | claude/new | New session

**What was done:** New work.

**Pages:** new-page

`);
    const result = parseAllSessionLogs(logPath, sessionsDir);

    expect(result['old-page']).toHaveLength(1);
    expect(result['new-page']).toHaveLength(1);
  });

  it('deduplicates entries appearing in both sources', () => {
    const logPath = path.join(tmpDir, 'session-log.md');
    const entry = `## 2026-02-13 | claude/dup | Duplicate session

**What was done:** Same work.

**Pages:** dup-page

`;
    fs.writeFileSync(logPath, entry);

    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(path.join(sessionsDir, '2026-02-13_dup.md'), entry);

    const result = parseAllSessionLogs(logPath, sessionsDir);

    // Should appear only once despite being in both sources
    expect(result['dup-page']).toHaveLength(1);
  });

  it('returns empty object when neither source exists', () => {
    const logPath = path.join(tmpDir, 'nonexistent.md');
    const sessionsDir = path.join(tmpDir, 'nonexistent-dir');
    const result = parseAllSessionLogs(logPath, sessionsDir);
    expect(result).toEqual({});
  });
});
