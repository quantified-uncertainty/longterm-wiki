import { describe, it, expect, afterEach } from 'vitest';
import { commands, getHelp } from './matrix.ts';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const EXCLUSION_FILE = join(PROJECT_ROOT, '.matrix-improved-test.txt');

describe('matrix commands', () => {
  afterEach(() => { if (existsSync(EXCLUSION_FILE)) unlinkSync(EXCLUSION_FILE); });

  it('scores returns entity type data', async () => {
    const result = await commands.scores([], { ci: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('contentScore');
  });

  it('scores filters by entity type', async () => {
    const result = await commands.scores([], { ci: true, type: 'person' });
    const data = JSON.parse(result.output);
    expect(data.length).toBe(1);
    expect(data[0].type).toBe('person');
  });

  it('scores accepts custom weights', async () => {
    const r = await commands.scores([], { ci: true, type: 'person', weights: 'quality:100,coverage:0,citations:0,freshness:0,pages:0' });
    const d = JSON.parse(r.output)[0];
    if (d.avgQuality != null) expect(d.contentScore).toBe(d.avgQuality);
  });

  it('pages returns items with action field', async () => {
    const result = await commands.pages([], { ci: true, dimension: 'content', limit: '5', includeStubs: true });
    const data = JSON.parse(result.output);
    if (data.length > 0) {
      expect(data[0]).toHaveProperty('action');
      expect(['create', 'improve']).toContain(data[0].action);
      expect(data[0]).toHaveProperty('isStub');
    }
  });

  it('pages --format=ids returns comma-separated IDs', async () => {
    const result = await commands.pages([], { format: 'ids', limit: '3', dimension: 'content' });
    const ids = result.output.split(',');
    expect(ids.length).toBeLessThanOrEqual(3);
    expect(ids[0]).toMatch(/^E\d+$/);
  });

  it('pages respects exclusion list', async () => {
    const r1 = await commands.pages([], { ci: true, dimension: 'content', limit: '1' });
    const topPage = JSON.parse(r1.output)[0];
    writeFileSync(EXCLUSION_FILE, `${topPage.numericId}\n`);
    const r2 = await commands.pages([], { ci: true, dimension: 'content', limit: '1', exclude: EXCLUSION_FILE });
    const newTop = JSON.parse(r2.output)[0];
    expect(newTop.numericId).not.toBe(topPage.numericId);
  });

  it('next-task returns prompt with action', async () => {
    const result = await commands['next-task']([], { dimension: 'content' });
    expect(result.output).toContain('## Task:');
    expect(result.output).toContain('Action');
  });

  it('next-task --format=json includes isStub and action', async () => {
    const result = await commands['next-task']([], { format: 'json', dimension: 'content' });
    const data = JSON.parse(result.output);
    expect(data).toHaveProperty('isStub');
    expect(data).toHaveProperty('action');
  });

  it('mark-done adds page to exclusion list', async () => {
    const result = await commands['mark-done'](['E357'], { exclude: EXCLUSION_FILE });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(EXCLUSION_FILE, 'utf-8')).toContain('E357');
  });

  it('getHelp covers all commands', () => {
    const help = getHelp();
    expect(help).toContain('scores');
    expect(help).toContain('mark-done');
    expect(help).toContain('--weights');
    expect(help).toContain('--include-stubs');
  });
});
