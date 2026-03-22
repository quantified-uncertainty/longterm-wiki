import { describe, it, expect, vi } from 'vitest';

// Mock the content-types module to provide PROJECT_ROOT
vi.mock('../lib/content-types.ts', () => ({
  PROJECT_ROOT: '/nonexistent-test-root',
}));

import { runDeterministicChecks } from './source-check.ts';
import type { VerificationIssue } from './source-check.ts';

describe('runDeterministicChecks', () => {
  it('flags records missing source URL', () => {
    const records = [
      { id: 'rec-1', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CEO' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const sourceIssues = issues.filter(i => i.field === 'source');
    expect(sourceIssues.length).toBe(1);
    expect(sourceIssues[0].severity).toBe('error');
    expect(sourceIssues[0].message).toContain('Missing source URL');
  });

  it('passes records with valid source URL', () => {
    const records = [
      { id: 'rec-1', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CEO', source: 'https://example.com' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const sourceIssues = issues.filter(i => i.field === 'source');
    expect(sourceIssues.length).toBe(0);
  });

  it('flags entity references that look like slugs instead of stableIds', () => {
    const records = [
      { id: 'rec-1', personId: 'this-is-a-slug-name', organizationId: 'VoNqoBJkyg', role: 'CTO', source: 'https://x.com' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const slugIssues = issues.filter(i => i.message.includes('slug'));
    // The slug check fires for personId (long hyphenated string)
    expect(slugIssues.length).toBeGreaterThanOrEqual(1);
    expect(slugIssues.some(i => i.field === 'personId')).toBe(true);
  });

  it('skips entity existence check when database.json is not available', () => {
    // With mocked PROJECT_ROOT pointing to nonexistent dir, knownIds is empty
    // so the entity existence check is skipped entirely
    const records = [
      { id: 'rec-1', personId: 'NONEXISTENT', organizationId: 'VoNqoBJkyg', role: 'CTO', source: 'https://x.com' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const entityIssues = issues.filter(i => i.message.includes('not in local'));
    expect(entityIssues.length).toBe(0); // Skipped because knownIds is empty
  });

  it('flags implausible dates', () => {
    const records = [
      { id: 'rec-1', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CEO', source: 'https://x.com', startDate: '1800-01-01' },
      { id: 'rec-2', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CTO', source: 'https://x.com', startDate: '2030-01-01' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const dateIssues = issues.filter(i => i.field === 'startDate');
    expect(dateIssues.length).toBe(2);
    expect(dateIssues[0].severity).toBe('error');
    expect(dateIssues[0].message).toContain('1800');
    expect(dateIssues[1].message).toContain('2030');
  });

  it('accepts valid dates', () => {
    const records = [
      { id: 'rec-1', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CEO', source: 'https://x.com', startDate: '2023-06-15' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const dateIssues = issues.filter(i => i.field === 'startDate');
    expect(dateIssues.length).toBe(0);
  });

  it('flags invalid roleType for personnel', () => {
    const records = [
      { id: 'rec-1', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CEO', roleType: 'executive', source: 'https://x.com' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const roleIssues = issues.filter(i => i.field === 'roleType');
    expect(roleIssues.length).toBe(1);
    expect(roleIssues[0].message).toContain('executive');
  });

  it('accepts valid roleTypes', () => {
    const records = [
      { id: 'rec-1', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CEO', roleType: 'key-person', source: 'https://x.com' },
      { id: 'rec-2', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'Director', roleType: 'board', source: 'https://x.com' },
      { id: 'rec-3', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'Engineer', roleType: 'career', source: 'https://x.com' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const roleIssues = issues.filter(i => i.field === 'roleType');
    expect(roleIssues.length).toBe(0);
  });

  it('detects duplicate personnel records', () => {
    const records = [
      { id: 'rec-1', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CEO', source: 'https://x.com' },
      { id: 'rec-2', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CEO', source: 'https://y.com' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const dupIssues = issues.filter(i => i.field === '_duplicate');
    expect(dupIssues.length).toBe(1);
    expect(dupIssues[0].recordId).toBe('rec-2');
    expect(dupIssues[0].message).toContain('rec-1');
  });

  it('does not flag distinct personnel records as duplicates', () => {
    const records = [
      { id: 'rec-1', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CEO', source: 'https://x.com' },
      { id: 'rec-2', personId: 'X9kLm2pR7w', organizationId: 'VoNqoBJkyg', role: 'CTO', source: 'https://x.com' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const dupIssues = issues.filter(i => i.field === '_duplicate');
    expect(dupIssues.length).toBe(0);
  });

  it('all issues have source=deterministic', () => {
    const records = [
      { id: 'rec-1' }, // Missing everything
    ];
    const issues = runDeterministicChecks('personnel', records);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.source).toBe('deterministic');
    }
  });
});

describe('parseVerificationResponse', () => {
  // Import the non-exported function via a workaround — test the behavior through
  // the public API instead. The parsing logic is tested via the LLM integration path,
  // but we can test the core pattern matching.

  it('handles empty records gracefully', () => {
    const issues = runDeterministicChecks('personnel', []);
    expect(issues).toEqual([]);
  });

  it('handles records with sourceUrl field (alternative to source)', () => {
    const records = [
      { id: 'rec-1', personId: 'X9kLm2pR7w', sourceUrl: 'https://example.com' },
    ];
    const issues = runDeterministicChecks('personnel', records);
    const sourceIssues = issues.filter(i => i.field === 'source');
    expect(sourceIssues.length).toBe(0);
  });
});

describe('TASK_TYPE_RECOMMENDED_MODEL', () => {
  it('maps all task types to a model', async () => {
    const { TASK_TYPES, TASK_TYPE_RECOMMENDED_MODEL } = await import('./types.ts');
    for (const taskType of TASK_TYPES) {
      expect(TASK_TYPE_RECOMMENDED_MODEL[taskType]).toBeDefined();
      expect(['haiku', 'sonnet', 'opus']).toContain(TASK_TYPE_RECOMMENDED_MODEL[taskType]);
    }
  });

  it('uses haiku for simple tasks and sonnet for complex ones', async () => {
    const { TASK_TYPE_RECOMMENDED_MODEL } = await import('./types.ts');
    expect(TASK_TYPE_RECOMMENDED_MODEL['benchmark-result-fill']).toBe('haiku');
    expect(TASK_TYPE_RECOMMENDED_MODEL['investment-linking']).toBe('haiku');
    expect(TASK_TYPE_RECOMMENDED_MODEL['personnel-enrichment']).toBe('sonnet');
    expect(TASK_TYPE_RECOMMENDED_MODEL['grant-grantee-backfill']).toBe('sonnet');
  });
});
