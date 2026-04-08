import { describe, it, expect } from 'vitest';
import { parseAgentProjectMeta, classifyDiscussion } from './epic.ts';
import type { AuditDiscussionInput } from './epic.ts';

describe('parseAgentProjectMeta', () => {
  it('returns null when no agent-project block exists', () => {
    expect(parseAgentProjectMeta('# Some Discussion\n\nNo metadata here.')).toBeNull();
    expect(parseAgentProjectMeta('')).toBeNull();
  });

  it('parses a complete agent-project block', () => {
    const body = `<!-- agent-project
priority: high
status: in-progress
phases_total: 5
phases_done: 3
last_agent_session: 2026-04-03
blocker: waiting on API key
-->

## Summary
Some discussion content.`;

    const meta = parseAgentProjectMeta(body);
    expect(meta).toEqual({
      priority: 'high',
      status: 'in-progress',
      phases_total: 5,
      phases_done: 3,
      last_agent_session: '2026-04-03',
      blocker: 'waiting on API key',
    });
  });

  it('parses a minimal block with only some fields', () => {
    const body = `<!-- agent-project
status: not-started
phases_total: 3
phases_done: 0
-->`;

    const meta = parseAgentProjectMeta(body);
    expect(meta).toEqual({
      status: 'not-started',
      phases_total: 3,
      phases_done: 0,
    });
  });

  it('handles phases_done: 0 as a valid value (not undefined)', () => {
    const body = `<!-- agent-project
phases_total: 4
phases_done: 0
-->`;

    const meta = parseAgentProjectMeta(body);
    expect(meta?.phases_done).toBe(0);
  });

  it('handles non-numeric phases values gracefully', () => {
    const body = `<!-- agent-project
phases_total: abc
phases_done: def
-->`;

    const meta = parseAgentProjectMeta(body);
    // parseInt returns NaN, so || undefined kicks in
    expect(meta?.phases_total).toBeUndefined();
    expect(meta?.phases_done).toBeUndefined();
  });

  it('handles extra whitespace in the block', () => {
    const body = `<!--   agent-project
  priority:  medium
  status:    complete
  phases_total:  6
  phases_done:   6
  last_agent_session:  2026-04-04
-->`;

    const meta = parseAgentProjectMeta(body);
    expect(meta).toEqual({
      priority: 'medium',
      status: 'complete',
      phases_total: 6,
      phases_done: 6,
      last_agent_session: '2026-04-04',
    });
  });

  it('ignores unknown keys', () => {
    const body = `<!-- agent-project
priority: low
custom_field: should be ignored
status: blocked
-->`;

    const meta = parseAgentProjectMeta(body);
    expect(meta).toEqual({
      priority: 'low',
      status: 'blocked',
    });
  });

  it('returns null when block exists but contains only unknown keys', () => {
    const body = `<!-- agent-project
custom_field: value
another_unknown: data
-->`;

    expect(parseAgentProjectMeta(body)).toBeNull();
  });

  it('returns null when block exists but is empty', () => {
    const body = `<!-- agent-project
-->`;

    expect(parseAgentProjectMeta(body)).toBeNull();
  });

  it('detects block embedded deep in the body', () => {
    const body = `# Big Discussion

Lots of content here.

## Phase 1

Done.

## Phase 2

In progress.

<!-- agent-project
priority: high
status: in-progress
phases_total: 3
phases_done: 1
last_agent_session: 2026-03-28
-->

## Phase 3

Not started.`;

    const meta = parseAgentProjectMeta(body);
    expect(meta?.priority).toBe('high');
    expect(meta?.phases_done).toBe(1);
    expect(meta?.phases_total).toBe(3);
  });
});

describe('classifyDiscussion', () => {
  const now = new Date('2026-04-05T12:00:00Z');

  function makeDiscussion(overrides: Partial<AuditDiscussionInput> = {}): AuditDiscussionInput {
    return {
      number: 42,
      title: 'Test Discussion',
      body: '',
      createdAt: '2026-03-01T00:00:00Z',
      commentCount: 5,
      ...overrides,
    };
  }

  it('detects drift when phases_done == phases_total', () => {
    const d = makeDiscussion({
      body: `<!-- agent-project
status: in-progress
phases_total: 6
phases_done: 6
last_agent_session: 2026-04-04
-->`,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings.some((f) => f.category === 'drift')).toBe(true);
  });

  it('detects drift when status is complete', () => {
    const d = makeDiscussion({
      body: `<!-- agent-project
status: complete
phases_total: 3
phases_done: 3
-->`,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings.some((f) => f.category === 'drift')).toBe(true);
  });

  it('detects drift when status is done', () => {
    const d = makeDiscussion({
      body: `<!-- agent-project
status: done
-->`,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings.some((f) => f.category === 'drift')).toBe(true);
  });

  it('does not flag in-progress with phases remaining and recent session', () => {
    const d = makeDiscussion({
      body: `<!-- agent-project
status: in-progress
phases_total: 5
phases_done: 2
last_agent_session: 2026-04-03
-->`,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings).toEqual([]);
  });

  it('detects stale when in-progress with old last_agent_session', () => {
    const d = makeDiscussion({
      body: `<!-- agent-project
status: in-progress
phases_total: 4
phases_done: 1
last_agent_session: 2026-02-01
-->`,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings.some((f) => f.category === 'stale')).toBe(true);
    expect(findings.find((f) => f.category === 'stale')!.detail).toContain('2026-02-01');
  });

  it('detects orphaned discussions with 0 comments and 0 linked issues after 14 days', () => {
    const d = makeDiscussion({
      body: 'No metadata, no issue links.',
      createdAt: '2026-03-01T00:00:00Z',
      commentCount: 0,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings.some((f) => f.category === 'orphaned')).toBe(true);
  });

  it('does not flag orphaned if discussion has comments', () => {
    const d = makeDiscussion({
      body: 'No metadata, no issue links.',
      createdAt: '2026-03-01T00:00:00Z',
      commentCount: 3,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings.some((f) => f.category === 'orphaned')).toBe(false);
  });

  it('does not flag orphaned if discussion is younger than 14 days', () => {
    const d = makeDiscussion({
      body: 'No metadata, no issue links.',
      createdAt: '2026-03-30T00:00:00Z',
      commentCount: 0,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings.some((f) => f.category === 'orphaned')).toBe(false);
  });

  it('detects missing_frontmatter for old discussions without agent-project block', () => {
    const d = makeDiscussion({
      body: 'Just a regular discussion.',
      createdAt: '2026-03-01T00:00:00Z',
      commentCount: 3,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings.some((f) => f.category === 'missing_frontmatter')).toBe(true);
  });

  it('does not flag missing_frontmatter for discussions younger than 7 days', () => {
    const d = makeDiscussion({
      body: 'Just a regular discussion.',
      createdAt: '2026-04-02T00:00:00Z',
      commentCount: 3,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings.some((f) => f.category === 'missing_frontmatter')).toBe(false);
  });

  it('can produce multiple findings for one discussion', () => {
    // Drift + orphaned: completed discussion with 0 comments, 0 issues, old
    const d = makeDiscussion({
      body: `<!-- agent-project
status: done
-->`,
      createdAt: '2026-03-01T00:00:00Z',
      commentCount: 0,
    });
    const findings = classifyDiscussion(d, now);
    const categories = findings.map((f) => f.category);
    expect(categories).toContain('drift');
    expect(categories).toContain('orphaned');
  });

  it('returns empty array for healthy in-progress discussion', () => {
    const d = makeDiscussion({
      body: `<!-- agent-project
status: in-progress
phases_total: 5
phases_done: 2
last_agent_session: 2026-04-03
-->
- #100
- #101`,
      createdAt: '2026-03-01T00:00:00Z',
      commentCount: 10,
    });
    const findings = classifyDiscussion(d, now);
    expect(findings).toEqual([]);
  });
});
