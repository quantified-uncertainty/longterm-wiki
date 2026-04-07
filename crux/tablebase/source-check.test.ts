import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  buildStableIdNameMap,
  humanizeRecord,
  buildSourceCheckPrompt,
  runDeterministicChecks,
} from './source-check.ts';

// ---------------------------------------------------------------------------
// Mock fs so we can control database.json content
// ---------------------------------------------------------------------------

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    existsSync: vi.fn(actual.existsSync),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDatabaseJson(data: Record<string, unknown>): void {
  vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
    const pathStr = String(path);
    if (pathStr.includes('database.json')) return true;
    // Delegate to the real existsSync for everything else
    return (vi.importActual<typeof fs>('fs') as unknown as typeof fs).existsSync(path);
  });

  vi.mocked(fs.readFileSync).mockImplementation((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const pathStr = String(path);
    if (pathStr.includes('database.json')) {
      return JSON.stringify(data);
    }
    // Delegate to the real readFileSync for everything else
    const actual = (vi.importActual<typeof fs>('fs') as unknown as typeof fs);
    return (actual.readFileSync as Function)(path, ...rest);
  });
}

function mockNoDatabaseJson(): void {
  vi.mocked(fs.existsSync).mockImplementation((path: fs.PathLike) => {
    const pathStr = String(path);
    if (pathStr.includes('database.json')) return false;
    return (vi.importActual<typeof fs>('fs') as unknown as typeof fs).existsSync(path);
  });
}

const SAMPLE_DB = {
  idRegistry: {
    stableIdBySlug: {
      'anthropic': 'ABCdef1234',
      'openai': 'XYZ9876543',
      'dan-hendrycks': 'VoNqoBJkyg',
    },
  },
  typedEntities: [
    { id: 'anthropic', stableId: 'ABCdef1234', title: 'Anthropic' },
    { id: 'openai', stableId: 'XYZ9876543', title: 'OpenAI' },
    { id: 'dan-hendrycks', stableId: 'VoNqoBJkyg', title: 'Dan Hendrycks' },
    { id: 'no-title-entity', stableId: 'NoTitle0001' },
  ],
};

// ---------------------------------------------------------------------------
// buildStableIdNameMap
// ---------------------------------------------------------------------------

describe('buildStableIdNameMap', () => {
  it('resolves stableIds to entity titles from typedEntities', () => {
    mockDatabaseJson(SAMPLE_DB);
    const map = buildStableIdNameMap();

    expect(map.get('ABCdef1234')).toBe('Anthropic');
    expect(map.get('XYZ9876543')).toBe('OpenAI');
    expect(map.get('VoNqoBJkyg')).toBe('Dan Hendrycks');
  });

  it('falls back to entity id (slug) when title is missing', () => {
    mockDatabaseJson(SAMPLE_DB);
    const map = buildStableIdNameMap();

    expect(map.get('NoTitle0001')).toBe('no-title-entity');
  });

  it('includes idRegistry entries not in typedEntities', () => {
    mockDatabaseJson({
      idRegistry: {
        stableIdBySlug: {
          'orphan-slug': 'OrphanId001',
        },
      },
      typedEntities: [],
    });
    const map = buildStableIdNameMap();

    expect(map.get('OrphanId001')).toBe('orphan-slug');
  });

  it('returns an empty map when database.json does not exist', () => {
    mockNoDatabaseJson();
    const map = buildStableIdNameMap();

    expect(map.size).toBe(0);
  });

  it('returns an empty map when database.json has no entities', () => {
    mockDatabaseJson({ typedEntities: [], idRegistry: {} });
    const map = buildStableIdNameMap();

    expect(map.size).toBe(0);
  });

  it('handles malformed database.json gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');
    const map = buildStableIdNameMap();

    expect(map.size).toBe(0);
  });

  it('prefers title over slug when both are available', () => {
    mockDatabaseJson({
      idRegistry: {
        stableIdBySlug: { 'anthropic-slug': 'TestId00001' },
      },
      typedEntities: [
        { id: 'anthropic-slug', stableId: 'TestId00001', title: 'Anthropic (the company)' },
      ],
    });
    const map = buildStableIdNameMap();

    expect(map.get('TestId00001')).toBe('Anthropic (the company)');
  });
});

// ---------------------------------------------------------------------------
// humanizeRecord
// ---------------------------------------------------------------------------

describe('humanizeRecord', () => {
  const nameMap = new Map([
    ['ABCdef1234', 'Anthropic'],
    ['XYZ9876543', 'OpenAI'],
    ['VoNqoBJkyg', 'Dan Hendrycks'],
  ]);

  it('replaces personId stableId with human-readable name', () => {
    const record = {
      id: 'rec-1',
      personId: 'VoNqoBJkyg',
      organizationId: 'ABCdef1234',
      role: 'CEO',
    };

    const result = humanizeRecord(record, nameMap);

    expect(result.personId).toBe('Dan Hendrycks');
    expect(result.organizationId).toBe('Anthropic');
    expect(result.role).toBe('CEO');
  });

  it('uses personResolvedName from API response when available', () => {
    const record = {
      id: 'rec-2',
      personId: 'UnknownId99',
      personResolvedName: 'John Smith',
      organizationId: 'ABCdef1234',
    };

    const result = humanizeRecord(record, nameMap);

    // Should use the resolved name from the API, not the nameMap
    expect(result.personId).toBe('John Smith');
    expect(result.organizationId).toBe('Anthropic');
  });

  it('uses orgResolvedName from API response when available', () => {
    const record = {
      id: 'rec-3',
      organizationId: 'UnknownOrgId',
      orgResolvedName: 'DeepMind',
    };

    const result = humanizeRecord(record, nameMap);

    expect(result.organizationId).toBe('DeepMind');
  });

  it('falls back to nameMap when resolved name not available', () => {
    const record = {
      id: 'rec-4',
      personId: 'VoNqoBJkyg',
    };

    const result = humanizeRecord(record, nameMap);

    expect(result.personId).toBe('Dan Hendrycks');
  });

  it('leaves original value when neither resolved name nor nameMap has entry', () => {
    const record = {
      id: 'rec-5',
      personId: 'CompletelyUnknown',
      companyId: 'AlsoUnknown1',
    };

    const result = humanizeRecord(record, nameMap);

    expect(result.personId).toBe('CompletelyUnknown');
    expect(result.companyId).toBe('AlsoUnknown1');
  });

  it('strips internal-only fields', () => {
    const record = {
      id: 'rec-6',
      personEntityId: 'VoNqoBJkyg',
      orgEntityId: 'ABCdef1234',
      syncedAt: '2025-01-01T00:00:00Z',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      role: 'Engineer',
    };

    const result = humanizeRecord(record, nameMap);

    expect(result.personEntityId).toBeUndefined();
    expect(result.orgEntityId).toBeUndefined();
    expect(result.syncedAt).toBeUndefined();
    expect(result.createdAt).toBeUndefined();
    expect(result.updatedAt).toBeUndefined();
    expect(result.role).toBe('Engineer');
  });

  it('strips redundant personResolvedName and orgResolvedName fields', () => {
    const record = {
      id: 'rec-7',
      personId: 'VoNqoBJkyg',
      personResolvedName: 'Dan Hendrycks',
      orgResolvedName: 'Anthropic',
    };

    const result = humanizeRecord(record, nameMap);

    expect(result.personResolvedName).toBeUndefined();
    expect(result.orgResolvedName).toBeUndefined();
  });

  it('strips nested person and organization ref objects', () => {
    const record = {
      id: 'rec-8',
      personId: 'VoNqoBJkyg',
      person: { stableId: 'VoNqoBJkyg', name: 'Dan Hendrycks', slug: 'dan-hendrycks' },
      organization: { stableId: 'ABCdef1234', name: 'Anthropic', slug: 'anthropic' },
    };

    const result = humanizeRecord(record, nameMap);

    expect(result.person).toBeUndefined();
    expect(result.organization).toBeUndefined();
  });

  it('handles null and undefined entity ID fields gracefully', () => {
    const record = {
      id: 'rec-9',
      personId: null as unknown as string,
      organizationId: undefined as unknown as string,
    };

    const result = humanizeRecord(record, nameMap);

    expect(result.personId).toBeNull();
    expect(result.organizationId).toBeUndefined();
  });

  it('handles empty string entity ID fields', () => {
    const record = {
      id: 'rec-10',
      personId: '',
      organizationId: '',
    };

    const result = humanizeRecord(record, nameMap);

    // Empty strings are falsy, so they should not be resolved
    expect(result.personId).toBe('');
    expect(result.organizationId).toBe('');
  });

  it('does not mutate the original record', () => {
    const record = {
      id: 'rec-11',
      personId: 'VoNqoBJkyg',
      personEntityId: 'VoNqoBJkyg',
      syncedAt: '2025-01-01T00:00:00Z',
    };

    humanizeRecord(record, nameMap);

    expect(record.personId).toBe('VoNqoBJkyg');
    expect(record.personEntityId).toBe('VoNqoBJkyg');
    expect(record.syncedAt).toBe('2025-01-01T00:00:00Z');
  });

  it('resolves companyId, investorId, benchmarkId, modelId, granteeId', () => {
    const extendedMap = new Map([
      ...nameMap,
      ['CompanyId01', 'Acme Corp'],
      ['InvestId001', 'Tiger Global'],
      ['BenchId0001', 'MMLU'],
      ['ModelId0001', 'GPT-4'],
      ['GranteeId01', 'MIRI'],
    ]);

    const record = {
      id: 'rec-12',
      companyId: 'CompanyId01',
      investorId: 'InvestId001',
      benchmarkId: 'BenchId0001',
      modelId: 'ModelId0001',
      granteeId: 'GranteeId01',
    };

    const result = humanizeRecord(record, extendedMap);

    expect(result.companyId).toBe('Acme Corp');
    expect(result.investorId).toBe('Tiger Global');
    expect(result.benchmarkId).toBe('MMLU');
    expect(result.modelId).toBe('GPT-4');
    expect(result.granteeId).toBe('MIRI');
  });

  it('works with an empty nameMap', () => {
    const record = {
      id: 'rec-13',
      personId: 'VoNqoBJkyg',
      organizationId: 'ABCdef1234',
    };

    const result = humanizeRecord(record, new Map());

    // Falls back to original values
    expect(result.personId).toBe('VoNqoBJkyg');
    expect(result.organizationId).toBe('ABCdef1234');
  });
});

// ---------------------------------------------------------------------------
// buildSourceCheckPrompt
// ---------------------------------------------------------------------------

describe('buildSourceCheckPrompt', () => {
  const nameMap = new Map([
    ['ABCdef1234', 'Anthropic'],
    ['VoNqoBJkyg', 'Dan Hendrycks'],
  ]);

  it('includes human-readable names instead of stableIds in the prompt', () => {
    const record = {
      id: 'rec-1',
      personId: 'VoNqoBJkyg',
      organizationId: 'ABCdef1234',
      role: 'CEO',
      source: 'https://example.com',
    };

    const prompt = buildSourceCheckPrompt('personnel', record, nameMap);

    // Should contain the resolved names
    expect(prompt).toContain('"Dan Hendrycks"');
    expect(prompt).toContain('"Anthropic"');
    // Should NOT contain the raw stableIds
    expect(prompt).not.toContain('VoNqoBJkyg');
    expect(prompt).not.toContain('ABCdef1234');
  });

  it('includes the table name in the prompt', () => {
    const prompt = buildSourceCheckPrompt('personnel', { id: 'r1' }, new Map());
    expect(prompt).toContain('personnel');
  });

  it('includes the source URL in the prompt', () => {
    const record = { id: 'r1', source: 'https://example.com/team' };
    const prompt = buildSourceCheckPrompt('personnel', record, new Map());
    expect(prompt).toContain('https://example.com/team');
  });

  it('shows "(none)" when source URL is missing', () => {
    const record = { id: 'r1' };
    const prompt = buildSourceCheckPrompt('personnel', record, new Map());
    expect(prompt).toContain('(none)');
  });

  it('includes note about entity reference resolution', () => {
    const prompt = buildSourceCheckPrompt('personnel', { id: 'r1' }, new Map());
    expect(prompt).toContain('Entity reference fields');
    expect(prompt).toContain('resolved to human-readable names');
  });

  it('strips internal fields from prompt JSON', () => {
    const record = {
      id: 'r1',
      personEntityId: 'VoNqoBJkyg',
      orgEntityId: 'ABCdef1234',
      syncedAt: '2025-01-01',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
    };

    const prompt = buildSourceCheckPrompt('personnel', record, nameMap);

    // Internal fields should be stripped
    expect(prompt).not.toContain('personEntityId');
    expect(prompt).not.toContain('orgEntityId');
    expect(prompt).not.toContain('syncedAt');
    expect(prompt).not.toContain('createdAt');
    expect(prompt).not.toContain('updatedAt');
  });

  it('handles records with no entity reference fields', () => {
    const record = {
      id: 'r1',
      name: 'Series A',
      raised: 100000000,
      source: 'https://example.com/funding',
    };

    const prompt = buildSourceCheckPrompt('funding-rounds', record, nameMap);

    expect(prompt).toContain('Series A');
    expect(prompt).toContain('100000000');
  });
});

// ---------------------------------------------------------------------------
// runDeterministicChecks (unchanged behavior)
// ---------------------------------------------------------------------------

describe('runDeterministicChecks', () => {
  it('flags records with no source URL', () => {
    mockDatabaseJson(SAMPLE_DB);

    const issues = runDeterministicChecks('personnel', [
      { id: 'r1' },
    ]);

    expect(issues.some(i => i.field === 'source' && i.severity === 'error')).toBe(true);
  });

  it('flags slugs in entity ID fields', () => {
    mockDatabaseJson(SAMPLE_DB);

    const issues = runDeterministicChecks('personnel', [
      { id: 'r1', personId: 'some-long-hyphenated-slug', source: 'https://example.com' },
    ]);

    expect(issues.some(i =>
      i.field === 'personId' &&
      i.severity === 'warning' &&
      i.message.includes('slug')
    )).toBe(true);
  });

  it('flags implausible dates', () => {
    mockDatabaseJson(SAMPLE_DB);

    const issues = runDeterministicChecks('personnel', [
      { id: 'r1', startDate: '1800-01-01', source: 'https://example.com' },
    ]);

    expect(issues.some(i => i.field === 'startDate' && i.severity === 'error')).toBe(true);
  });

  it('flags invalid roleType for personnel', () => {
    mockDatabaseJson(SAMPLE_DB);

    const issues = runDeterministicChecks('personnel', [
      { id: 'r1', personId: 'abc', organizationId: 'def', role: 'CEO', roleType: 'invalid-type', source: 'https://example.com' },
    ]);

    expect(issues.some(i => i.field === 'roleType' && i.severity === 'error')).toBe(true);
  });

  it('detects duplicate personnel records', () => {
    mockDatabaseJson(SAMPLE_DB);

    const issues = runDeterministicChecks('personnel', [
      { id: 'r1', personId: 'p1', organizationId: 'o1', role: 'CEO', source: 'https://example.com' },
      { id: 'r2', personId: 'p1', organizationId: 'o1', role: 'CEO', source: 'https://example.com' },
    ]);

    expect(issues.some(i => i.field === '_duplicate' && i.severity === 'warning')).toBe(true);
  });

  it('passes clean records', () => {
    mockDatabaseJson(SAMPLE_DB);

    const issues = runDeterministicChecks('personnel', [
      {
        id: 'r1',
        personId: 'ABCdef1234',
        organizationId: 'XYZ9876543',
        role: 'CEO',
        roleType: 'key-person',
        startDate: '2024-01-01',
        source: 'https://example.com',
      },
    ]);

    // Only non-blocking issues (info about stableId existence) are expected
    const blockingIssues = issues.filter(i => i.severity === 'error' || i.severity === 'warning');
    expect(blockingIssues.length).toBe(0);
  });
});
