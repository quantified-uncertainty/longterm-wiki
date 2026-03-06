/**
 * Tests for the KB CLI command handlers.
 *
 * These tests verify the command functions produce correct output
 * by loading the real KB data directory.
 */

import { describe, it, expect } from 'vitest';
import { commands } from './kb.ts';

// The tests load real data from packages/kb/data/ — no mocking needed.
// They are integration-style tests that exercise the full show/list/lookup flow.

describe('crux kb list', () => {
  it('lists all entities in table format', async () => {
    const result = await commands.list([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('anthropic');
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('organization');
    expect(result.output).toContain('mK9pX3rQ7n');
    expect(result.output).toContain('Total:');
  });

  it('filters by type', async () => {
    const result = await commands.list([], { type: 'person' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('dario-amodei');
    expect(result.output).not.toContain('anthropic '); // slug 'anthropic' not in person list
  });

  it('returns JSON in ci mode', async () => {
    const result = await commands.list([], { ci: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('id');
    expect(data[0]).toHaveProperty('name');
    expect(data[0]).toHaveProperty('factCount');
  });
});

describe('crux kb show', () => {
  it('shows entity details with facts and items', async () => {
    const result = await commands.show(['anthropic'], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('mK9pX3rQ7n');
    expect(result.output).toContain('organization');
    expect(result.output).toContain('Facts');
    expect(result.output).toContain('Revenue');
    expect(result.output).toContain('Items');
    expect(result.output).toContain('funding-rounds');
    expect(result.output).toContain('key-people');
  });

  it('formats financial values with proper units', async () => {
    const result = await commands.show(['anthropic'], {});
    expect(result.exitCode).toBe(0);
    // Revenue should show $XB format
    expect(result.output).toMatch(/\$\d+(\.\d)?B/);
  });

  it('resolves refs to names in facts', async () => {
    const result = await commands.show(['dario-amodei'], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Anthropic (anthropic)');
  });

  it('shows birth year without comma separator', async () => {
    const result = await commands.show(['dario-amodei'], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('1983');
    expect(result.output).not.toContain('1,983');
  });

  it('resolves refs in key-people items', async () => {
    const result = await commands.show(['anthropic'], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Dario Amodei');
    expect(result.output).toContain('CEO');
  });

  it('returns error for non-existent entity', async () => {
    const result = await commands.show(['nonexistent-entity-xyz'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Entity not found');
  });

  it('shows usage when no entity specified', async () => {
    const result = await commands.show([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
  });
});

describe('crux kb lookup', () => {
  it('looks up a known stableId', async () => {
    const result = await commands.lookup(['mK9pX3rQ7n'], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Anthropic');
    expect(result.output).toContain('anthropic');
  });

  it('returns error for unknown stableId', async () => {
    const result = await commands.lookup(['XXXXXXXXXX'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('No entity found');
  });

  it('returns JSON in ci mode', async () => {
    const result = await commands.lookup(['zR4nW8xB2f'], { ci: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.slug).toBe('dario-amodei');
    expect(data.name).toBe('Dario Amodei');
  });

  it('shows usage when no stableId specified', async () => {
    const result = await commands.lookup([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage');
  });
});
