import { describe, it, expect } from 'vitest';
import { commands, getHelp } from './matrix.ts';

describe('matrix commands', () => {
  it('scores returns entity type data', async () => {
    const result = await commands.scores([], { ci: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);

    const first = data[0];
    expect(first).toHaveProperty('type');
    expect(first).toHaveProperty('pageCount');
    expect(first).toHaveProperty('contentScore');
    expect(first).toHaveProperty('avgCoverageScore');
  });

  it('scores filters by entity type', async () => {
    const result = await commands.scores([], { ci: true, type: 'person' });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.length).toBe(1);
    expect(data[0].type).toBe('person');
  });

  it('pages returns ranked improvement targets', async () => {
    const result = await commands.pages([], { ci: true, dimension: 'content', limit: '5' });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeLessThanOrEqual(5);

    if (data.length > 0) {
      expect(data[0]).toHaveProperty('impactScore');
      expect(data[0]).toHaveProperty('reasons');
      // Should be sorted by impact descending
      for (let i = 1; i < data.length; i++) {
        expect(data[i].impactScore).toBeLessThanOrEqual(data[i - 1].impactScore);
      }
    }
  });

  it('pages --format=ids returns comma-separated IDs', async () => {
    const result = await commands.pages([], { format: 'ids', limit: '3', dimension: 'content' });
    expect(result.exitCode).toBe(0);
    const ids = result.output.split(',');
    expect(ids.length).toBeLessThanOrEqual(3);
    expect(ids[0]).toMatch(/^E\d+$/);
  });

  it('next-task returns a prompt', async () => {
    const result = await commands['next-task']([], { dimension: 'content' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('## Task:');
    expect(result.output).toContain('Steps');
  });

  it('next-task --format=json returns structured data', async () => {
    const result = await commands['next-task']([], { format: 'json', dimension: 'content' });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data).toHaveProperty('impactScore');
    expect(data).toHaveProperty('title');
  });

  it('getHelp returns non-empty string', () => {
    const help = getHelp();
    expect(help).toContain('Matrix Domain');
    expect(help).toContain('scores');
    expect(help).toContain('pages');
    expect(help).toContain('next-task');
  });
});
