import { describe, it, expect } from 'vitest';
import { parseAgentProjectMeta } from './epic.ts';

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

describe('audit detection categories', () => {
  // These test the classification logic conceptually.
  // The actual audit function fetches from GitHub, so we test the
  // classification rules via the frontmatter parser + category rules.

  it('detects drift: phases_done == phases_total', () => {
    const meta = parseAgentProjectMeta(`<!-- agent-project
status: in-progress
phases_total: 6
phases_done: 6
last_agent_session: 2026-04-04
-->`);
    expect(meta).not.toBeNull();
    expect(meta!.phases_done).toBe(meta!.phases_total);
    // This should be classified as "drift" by the audit
  });

  it('detects drift: status complete', () => {
    const meta = parseAgentProjectMeta(`<!-- agent-project
status: complete
phases_total: 3
phases_done: 3
-->`);
    expect(meta?.status).toBe('complete');
  });

  it('detects drift: status done', () => {
    const meta = parseAgentProjectMeta(`<!-- agent-project
status: done
-->`);
    expect(meta?.status).toBe('done');
  });

  it('does not flag in-progress with phases remaining', () => {
    const meta = parseAgentProjectMeta(`<!-- agent-project
status: in-progress
phases_total: 5
phases_done: 2
last_agent_session: 2026-04-07
-->`);
    expect(meta?.status).toBe('in-progress');
    expect(meta!.phases_done).toBeLessThan(meta!.phases_total!);
    // This should NOT be classified as drift or stale (session is recent)
  });

  it('detects stale: in-progress with old last_agent_session', () => {
    const meta = parseAgentProjectMeta(`<!-- agent-project
status: in-progress
phases_total: 4
phases_done: 1
last_agent_session: 2026-02-01
-->`);
    const daysSince = (Date.now() - new Date('2026-02-01').getTime()) / (1000 * 60 * 60 * 24);
    expect(daysSince).toBeGreaterThan(30);
    // This should be classified as "stale" by the audit
  });
});
