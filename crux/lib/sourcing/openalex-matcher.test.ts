import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  tryOpenAlexMatch,
  searchAuthors,
  pickBestAuthor,
  checkAffiliation,
  clearAuthorCache,
  extractYear,
  shortOpenAlexId,
  type OpenAlexAuthor,
} from './openalex-matcher.ts';
import type { VerifyItem, RecordItemData } from './orchestrator-types.ts';

// ── Mock the OpenAlex API at HTTP level ────────────────────────────

let mockAuthorsByQuery: Record<string, OpenAlexAuthor[]> = {};
let mockErrorMode: 'none' | 'network' | 'http-500' = 'none';

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string) => {
    if (mockErrorMode === 'network') {
      throw new Error('ENOTFOUND api.openalex.org');
    }
    if (mockErrorMode === 'http-500') {
      return { ok: false, status: 500 } as Response;
    }

    const parsed = new URL(url);
    const q = parsed.searchParams.get('search') ?? '';
    const key = q.toLowerCase().trim();
    const results = mockAuthorsByQuery[key] ?? [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ results, meta: { count: results.length } }),
    } as unknown as Response;
  }),
);

beforeEach(() => {
  mockAuthorsByQuery = {};
  mockErrorMode = 'none';
  clearAuthorCache();
});

// ── Helpers ─────────────────────────────────────────────────────────

function makeAuthor(overrides: Partial<OpenAlexAuthor> = {}): OpenAlexAuthor {
  return {
    id: 'https://openalex.org/A5012345678',
    display_name: 'Jane Doe',
    works_count: 42,
    affiliations: [],
    ...overrides,
  };
}

function makePersonnelItem(overrides: {
  person: string;
  org: string;
  startDate?: string | null;
}): VerifyItem {
  const data: RecordItemData = {
    kind: 'record',
    recordType: 'personnel',
    recordId: `p_${overrides.person.replace(/\s/g, '_')}`,
    fields: {
      person: overrides.person,
      org: overrides.org,
      role: 'Researcher',
      startDate: overrides.startDate ?? null,
      endDate: null,
    },
    entityId: 'e_test',
    displayName: `${overrides.person} at ${overrides.org}`,
    entityDisplayName: overrides.org,
  };

  return {
    kind: 'record',
    id: data.recordId,
    description: data.displayName!,
    entityType: 'person',
    entityName: overrides.person,
    priority: 50,
    neverVerified: true,
    data,
  };
}

// ── extractYear ────────────────────────────────────────────────────

describe('extractYear', () => {
  it('pulls the 4-digit year out of an ISO date', () => {
    expect(extractYear('2023-01-15')).toBe(2023);
  });

  it('pulls the year out of a bare year string', () => {
    expect(extractYear('2021')).toBe(2021);
  });

  it('returns null for missing/empty input', () => {
    expect(extractYear(null)).toBeNull();
    expect(extractYear(undefined)).toBeNull();
    expect(extractYear('')).toBeNull();
  });

  it('returns null for strings without a plausible year', () => {
    expect(extractYear('unknown')).toBeNull();
    expect(extractYear('99')).toBeNull();
  });

  it('rejects years outside the 1900-2100 sanity window', () => {
    expect(extractYear('1800-01-01')).toBeNull();
    expect(extractYear('2200-01-01')).toBeNull();
  });
});

// ── shortOpenAlexId ────────────────────────────────────────────────

describe('shortOpenAlexId', () => {
  it('strips the https://openalex.org/ prefix', () => {
    expect(shortOpenAlexId('https://openalex.org/A5012345678')).toBe('A5012345678');
  });

  it('is case-insensitive on the host', () => {
    expect(shortOpenAlexId('HTTP://OPENALEX.ORG/A5012345678')).toBe('A5012345678');
  });

  it('leaves short IDs alone', () => {
    expect(shortOpenAlexId('A5012345678')).toBe('A5012345678');
  });
});

// ── searchAuthors — cache + error handling ────────────────────────

describe('searchAuthors', () => {
  it('returns authors from the mocked API', async () => {
    mockAuthorsByQuery['amanda askell'] = [
      makeAuthor({ display_name: 'Amanda Askell', works_count: 30 }),
    ];
    const results = await searchAuthors('Amanda Askell');
    expect(results).toHaveLength(1);
    expect(results[0].display_name).toBe('Amanda Askell');
  });

  it('returns [] on network error', async () => {
    mockErrorMode = 'network';
    const results = await searchAuthors('Amanda Askell');
    expect(results).toEqual([]);
  });

  it('returns [] on HTTP 5xx', async () => {
    mockErrorMode = 'http-500';
    const results = await searchAuthors('Amanda Askell');
    expect(results).toEqual([]);
  });

  it('caches results within a single run', async () => {
    mockAuthorsByQuery['amanda askell'] = [makeAuthor({ display_name: 'Amanda Askell' })];

    await searchAuthors('Amanda Askell');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const callCount1 = fetchMock.mock.calls.length;

    // Second call should be cached — no additional fetch
    await searchAuthors('Amanda Askell');
    const callCount2 = fetchMock.mock.calls.length;

    expect(callCount2).toBe(callCount1);
  });

  it('caches null results so repeated failures do not re-hit the API', async () => {
    mockErrorMode = 'network';
    await searchAuthors('Nobody');
    mockErrorMode = 'none'; // even if the API recovers, cache should hold

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;
    const results = await searchAuthors('Nobody');
    const after = fetchMock.mock.calls.length;

    expect(results).toEqual([]);
    expect(after).toBe(before);
  });
});

// ── pickBestAuthor ─────────────────────────────────────────────────

describe('pickBestAuthor', () => {
  it('returns null when no candidate passes the name filter', () => {
    const candidates = [makeAuthor({ display_name: 'Jane Smith' })];
    expect(pickBestAuthor(candidates, 'Amanda Askell', 'Anthropic')).toBeNull();
  });

  it('returns the unique name match when there is only one', () => {
    const candidates = [makeAuthor({ display_name: 'Amanda Askell' })];
    const pick = pickBestAuthor(candidates, 'Amanda Askell', 'Anthropic');
    expect(pick?.display_name).toBe('Amanda Askell');
  });

  it('disambiguates multiple name matches via org context', () => {
    const candidates: OpenAlexAuthor[] = [
      makeAuthor({
        id: 'https://openalex.org/A1',
        display_name: 'James Chen',
        affiliations: [
          { institution: { id: 'I1', display_name: 'Stanford University' }, years: [2019, 2020] },
        ],
      }),
      makeAuthor({
        id: 'https://openalex.org/A2',
        display_name: 'James Chen',
        affiliations: [
          { institution: { id: 'I2', display_name: 'Anthropic' }, years: [2022, 2023] },
        ],
      }),
    ];
    const pick = pickBestAuthor(candidates, 'James Chen', 'Anthropic');
    expect(pick?.id).toBe('https://openalex.org/A2');
  });

  it('returns null when multiple candidates match both name and org (truly ambiguous)', () => {
    const candidates: OpenAlexAuthor[] = [
      makeAuthor({
        id: 'https://openalex.org/A1',
        display_name: 'Wei Li',
        affiliations: [
          { institution: { id: 'I1', display_name: 'DeepMind' }, years: [2020, 2021] },
        ],
      }),
      makeAuthor({
        id: 'https://openalex.org/A2',
        display_name: 'Wei Li',
        affiliations: [
          { institution: { id: 'I2', display_name: 'DeepMind' }, years: [2022, 2023] },
        ],
      }),
    ];
    expect(pickBestAuthor(candidates, 'Wei Li', 'DeepMind')).toBeNull();
  });

  it('returns null when multiple candidates match the name but none match the org', () => {
    const candidates: OpenAlexAuthor[] = [
      makeAuthor({
        id: 'https://openalex.org/A1',
        display_name: 'Jane Doe',
        affiliations: [
          { institution: { id: 'I1', display_name: 'MIT' }, years: [2019] },
        ],
      }),
      makeAuthor({
        id: 'https://openalex.org/A2',
        display_name: 'Jane Doe',
        affiliations: [
          { institution: { id: 'I2', display_name: 'Stanford' }, years: [2020] },
        ],
      }),
    ];
    expect(pickBestAuthor(candidates, 'Jane Doe', 'Anthropic')).toBeNull();
  });

  it('uses last_known_institution as an org disambiguator when affiliations miss', () => {
    const candidates: OpenAlexAuthor[] = [
      makeAuthor({
        id: 'https://openalex.org/A1',
        display_name: 'Jane Doe',
        affiliations: [],
        last_known_institution: { id: 'I1', display_name: 'MIT' },
      }),
      makeAuthor({
        id: 'https://openalex.org/A2',
        display_name: 'Jane Doe',
        affiliations: [],
        last_known_institution: { id: 'I2', display_name: 'Anthropic' },
      }),
    ];
    const pick = pickBestAuthor(candidates, 'Jane Doe', 'Anthropic');
    expect(pick?.id).toBe('https://openalex.org/A2');
  });
});

// ── checkAffiliation ───────────────────────────────────────────────

describe('checkAffiliation', () => {
  it('confirms when the org is present and the year is in window', () => {
    const author = makeAuthor({
      affiliations: [
        { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2021, 2022, 2023] },
      ],
    });
    const result = checkAffiliation(author, 'Anthropic', 2022);
    expect(result.matched).toBe(true);
    expect(result.matchedInstitution).toBe('Anthropic');
  });

  it('confirms when the target year is within ±2 slack of the window', () => {
    const author = makeAuthor({
      affiliations: [
        { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2022, 2023] },
      ],
    });
    // Target 2020 — outside the window by 2, inside the slack
    expect(checkAffiliation(author, 'Anthropic', 2020).matched).toBe(true);
    // Target 2025 — outside by 2, inside slack
    expect(checkAffiliation(author, 'Anthropic', 2025).matched).toBe(true);
  });

  it('flags wrongYear when the org matches but the year window is too far off', () => {
    const author = makeAuthor({
      affiliations: [
        { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2022, 2023] },
      ],
    });
    const result = checkAffiliation(author, 'Anthropic', 2015);
    expect(result.matched).toBe(false);
    expect(result.wrongYear).toBe(true);
    expect(result.wrongOrg).toBe(false);
    expect(result.matchedInstitution).toBe('Anthropic');
  });

  it('flags wrongOrg when no affiliation matches the target', () => {
    const author = makeAuthor({
      affiliations: [
        { institution: { id: 'I1', display_name: 'DeepMind' }, years: [2022, 2023] },
        { institution: { id: 'I2', display_name: 'OpenAI' }, years: [2020, 2021] },
      ],
    });
    const result = checkAffiliation(author, 'Anthropic', 2022);
    expect(result.matched).toBe(false);
    expect(result.wrongOrg).toBe(true);
    expect(result.wrongYear).toBe(false);
    expect(result.actualInstitutions).toEqual(['DeepMind', 'OpenAI']);
  });

  it('ignores the year check when affiliations have empty years arrays', () => {
    const author = makeAuthor({
      affiliations: [
        { institution: { id: 'I1', display_name: 'Anthropic' }, years: [] },
      ],
    });
    // No years → can't check year window → just trust the org match
    expect(checkAffiliation(author, 'Anthropic', 2022).matched).toBe(true);
  });

  it('falls back to last_known_institution when affiliations is empty', () => {
    const author = makeAuthor({
      affiliations: [],
      last_known_institution: { id: 'I1', display_name: 'Anthropic' },
    });
    const result = checkAffiliation(author, 'Anthropic', 2022);
    expect(result.matched).toBe(true);
    expect(result.matchedInstitution).toBe('Anthropic');
  });

  it('returns wrongOrg when both affiliations and last_known_institution miss', () => {
    const author = makeAuthor({
      affiliations: [],
      last_known_institution: { id: 'I1', display_name: 'Google' },
    });
    expect(checkAffiliation(author, 'Anthropic', 2022).wrongOrg).toBe(true);
  });
});

// ── tryOpenAlexMatch — end-to-end ──────────────────────────────────

describe('tryOpenAlexMatch', () => {
  it('returns null for non-personnel records', async () => {
    const item = makePersonnelItem({ person: 'Jane Doe', org: 'Anthropic' });
    // Corrupt the record type
    (item.data as RecordItemData).recordType = 'grant' as never;
    expect(await tryOpenAlexMatch(item)).toBeNull();
  });

  it('returns null when the person name is missing', async () => {
    const item = makePersonnelItem({ person: '', org: 'Anthropic' });
    expect(await tryOpenAlexMatch(item)).toBeNull();
  });

  it('returns null when the person name is the (unknown) sentinel', async () => {
    const item = makePersonnelItem({ person: '(unknown)', org: 'Anthropic' });
    expect(await tryOpenAlexMatch(item)).toBeNull();
  });

  it('returns null when no author is found', async () => {
    mockAuthorsByQuery['nobody here'] = [];
    const item = makePersonnelItem({ person: 'Nobody Here', org: 'Anthropic' });
    expect(await tryOpenAlexMatch(item)).toBeNull();
  });

  it('returns null when the only candidate has works_count === 0 (non-publishing stub)', async () => {
    mockAuthorsByQuery['amanda askell'] = [
      makeAuthor({ display_name: 'Amanda Askell', works_count: 0 }),
    ];
    const item = makePersonnelItem({ person: 'Amanda Askell', org: 'Anthropic' });
    expect(await tryOpenAlexMatch(item)).toBeNull();
  });

  it('returns confirmed when the affiliation matches and year is in window', async () => {
    mockAuthorsByQuery['amanda askell'] = [
      makeAuthor({
        id: 'https://openalex.org/A5012345678',
        display_name: 'Amanda Askell',
        works_count: 30,
        affiliations: [
          { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2021, 2022, 2023] },
        ],
      }),
    ];

    const item = makePersonnelItem({
      person: 'Amanda Askell',
      org: 'Anthropic',
      startDate: '2022-06',
    });

    const result = await tryOpenAlexMatch(item);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('confirmed');
    expect(result!.confidence).toBeCloseTo(0.95);
    expect(result!.checkerModel).toBe('openalex-api');
    expect(result!.sourceUrl).toBe('https://openalex.org/A5012345678');
    expect(result!.reasoning).toContain('Anthropic');
    expect(result!.reasoning).toContain('A5012345678');
  });

  it('returns contradicted when the author is at a different org', async () => {
    mockAuthorsByQuery['jane doe'] = [
      makeAuthor({
        id: 'https://openalex.org/A9999',
        display_name: 'Jane Doe',
        works_count: 50,
        affiliations: [
          { institution: { id: 'I1', display_name: 'DeepMind' }, years: [2020, 2021, 2022] },
        ],
      }),
    ];

    const item = makePersonnelItem({
      person: 'Jane Doe',
      org: 'Anthropic',
      startDate: '2022',
    });

    const result = await tryOpenAlexMatch(item);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('contradicted');
    expect(result!.reasoning).toContain('DeepMind');
    expect(result!.reasoning).toContain('Anthropic');
  });

  it('returns contradicted with wrongYear reasoning when affiliation years miss the target', async () => {
    mockAuthorsByQuery['jane doe'] = [
      makeAuthor({
        id: 'https://openalex.org/A9999',
        display_name: 'Jane Doe',
        works_count: 50,
        affiliations: [
          { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2022, 2023] },
        ],
      }),
    ];

    const item = makePersonnelItem({
      person: 'Jane Doe',
      org: 'Anthropic',
      startDate: '2015',
    });

    const result = await tryOpenAlexMatch(item);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('contradicted');
    expect(result!.reasoning).toContain('year');
    expect(result!.reasoning).toContain('2015');
  });

  it('returns unverifiable when the author exists but has no affiliation data', async () => {
    mockAuthorsByQuery['jane doe'] = [
      makeAuthor({
        id: 'https://openalex.org/A9999',
        display_name: 'Jane Doe',
        works_count: 5,
        affiliations: [],
        last_known_institution: null,
      }),
    ];

    const item = makePersonnelItem({ person: 'Jane Doe', org: 'Anthropic' });
    const result = await tryOpenAlexMatch(item);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('unverifiable');
  });

  it('handles the missing-year case by skipping year enforcement', async () => {
    mockAuthorsByQuery['jane doe'] = [
      makeAuthor({
        id: 'https://openalex.org/A9999',
        display_name: 'Jane Doe',
        works_count: 50,
        affiliations: [
          { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2022] },
        ],
      }),
    ];

    const item = makePersonnelItem({
      person: 'Jane Doe',
      org: 'Anthropic',
      startDate: null,
    });

    const result = await tryOpenAlexMatch(item);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('confirmed');
  });
});
