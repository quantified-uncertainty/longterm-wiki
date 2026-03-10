/**
 * Tests for the KB verify CLI command.
 *
 * Tests the dry-run mode with real KB data (no LLM calls needed).
 * The verify logic itself is tested via integration with the command handler.
 */

import { describe, it, expect } from 'vitest';
import { commands } from './kb.ts';

describe('crux kb verify --dry-run', () => {
  it('lists facts to verify for a specific entity', async () => {
    const result = await commands.verify([], {
      entity: 'anthropic',
      'dry-run': true,
      limit: '3',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Dry run');
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('would be verified');
  });

  it('returns JSON in CI mode', async () => {
    const result = await commands.verify([], {
      entity: 'anthropic',
      'dry-run': true,
      limit: '2',
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeLessThanOrEqual(2);
    expect(data[0]).toHaveProperty('factId');
    expect(data[0]).toHaveProperty('entityId');
    expect(data[0]).toHaveProperty('entityName');
    expect(data[0]).toHaveProperty('source');
  });

  it('finds a specific fact by ID', async () => {
    const result = await commands.verify([], {
      fact: 'f_dW5cR9mJ8q',
      'dry-run': true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('1 fact(s)');
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('Revenue');
  });

  it('reports no facts when entity has none with sources', async () => {
    const result = await commands.verify([], {
      entity: 'nonexistent-entity',
      'dry-run': true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('No facts with source URLs');
  });

  it('reports no facts when fact ID does not exist', async () => {
    const result = await commands.verify([], {
      fact: 'f_nonexistent',
      'dry-run': true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('not found or has no source URL');
  });

  it('respects --limit option', async () => {
    const result = await commands.verify([], {
      entity: 'anthropic',
      'dry-run': true,
      limit: '2',
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.length).toBe(2);
  });

  it('skips inverse facts (inv_ prefix)', async () => {
    // All facts in the dry-run output should be non-inverse
    const result = await commands.verify([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output) as Array<{ factId: string }>;
    for (const fact of data) {
      expect(fact.factId).not.toMatch(/^inv_/);
    }
  });

  it('all listed facts have source URLs', async () => {
    const result = await commands.verify([], {
      entity: 'anthropic',
      'dry-run': true,
      ci: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output) as Array<{ source: string }>;
    for (const fact of data) {
      expect(fact.source).toBeTruthy();
      expect(fact.source).toMatch(/^https?:\/\//);
    }
  });
});
