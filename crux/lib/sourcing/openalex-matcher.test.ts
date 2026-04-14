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
let mockErrorMode:
  | 'none'
  | 'network'
  | 'http-500'
  | 'json-throws'
  | 'non-array-results' = 'none';

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string) => {
    if (mockErrorMode === 'network') {
      throw new Error('ENOTFOUND api.openalex.org');
    }
    if (mockErrorMode === 'http-500') {
      return { ok: false, status: 500 } as Response;
    }
    if (mockErrorMode === 'json-throws') {
      // ok=true but the body is HTML (e.g. a CDN error page). response.json()
      // throws.
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      } as unknown as Response;
    }
    if (mockErrorMode === 'non-array-results') {
      return {
        ok: true,
        status: 200,
        // `results` as a string instead of an array — API shape drift case.
        json: async () => ({ results: 'whoops' as unknown, meta: { count: 0 } }),
      } as unknown as Response;
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

  // Regression: under concurrency=8, two concurrent calls for the same name
  // previously both missed the cache (populated post-await) and triggered two
  // duplicate fetches. The in-flight dedup map synchronously records the
  // promise before the await, so the second call returns the same promise.
  it('deduplicates concurrent fetches for the same name', async () => {
    mockAuthorsByQuery['amanda askell'] = [makeAuthor({ display_name: 'Amanda Askell' })];

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;

    // Kick off two fetches in the same tick — neither await yet.
    const [a, b] = await Promise.all([
      searchAuthors('Amanda Askell'),
      searchAuthors('Amanda Askell'),
    ]);

    const after = fetchMock.mock.calls.length;
    expect(after - before).toBe(1);
    expect(a).toBe(b);
  });

  it('projects only the fields the matcher reads (smaller OpenAlex payload)', async () => {
    mockAuthorsByQuery['amanda askell'] = [makeAuthor({ display_name: 'Amanda Askell' })];
    await searchAuthors('Amanda Askell');

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const calledUrl = String(fetchMock.mock.calls.at(-1)?.[0] ?? '');
    expect(calledUrl).toContain('select=');
    expect(calledUrl).toContain('display_name');
    expect(calledUrl).toContain('affiliations');
    expect(calledUrl).toContain('works_count');
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

  it('returns [] when response.json() throws (HTML error page disguised as 200)', async () => {
    mockErrorMode = 'json-throws';
    const results = await searchAuthors('Amanda Askell');
    expect(results).toEqual([]);
  });

  it('returns [] when the JSON response has non-array `results` (shape drift)', async () => {
    mockErrorMode = 'non-array-results';
    const results = await searchAuthors('Amanda Askell');
    expect(results).toEqual([]);
    // Critical: the caller will filter/some/map over this array. A string
    // value would have thrown deep in pickBestAuthor. The Array.isArray
    // guard in searchAuthors is what makes this safe.
  });
});

// ── pickBestAuthor ─────────────────────────────────────────────────

describe('pickBestAuthor', () => {
  it('returns null when no candidate passes the name filter', () => {
    const candidates = [makeAuthor({ display_name: 'Jane Smith' })];
    expect(pickBestAuthor(candidates, 'Amanda Askell', 'Anthropic')).toBeNull();
  });

  it('returns the unique name match with disambiguation=unique when there is only one', () => {
    const candidates = [makeAuthor({ display_name: 'Amanda Askell' })];
    const pick = pickBestAuthor(candidates, 'Amanda Askell', 'Anthropic');
    expect(pick?.author.display_name).toBe('Amanda Askell');
    expect(pick?.disambiguation).toBe('unique');
  });

  // Regression: a single name match should be returned regardless of whether
  // the org matches, because org is a disambiguator, not a filter. The homonym
  // risk is handled downstream in `tryOpenAlexMatch` via the disambiguation flag.
  it('returns the unique name match even when the org does not match', () => {
    const candidates: OpenAlexAuthor[] = [
      makeAuthor({
        display_name: 'Jane Doe',
        affiliations: [
          { institution: { id: 'I1', display_name: 'MIT' }, years: [2020] },
        ],
      }),
    ];
    const pick = pickBestAuthor(candidates, 'Jane Doe', 'Anthropic');
    expect(pick?.author.display_name).toBe('Jane Doe');
    expect(pick?.disambiguation).toBe('unique');
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
    expect(pick?.author.id).toBe('https://openalex.org/A2');
    expect(pick?.disambiguation).toBe('disambiguated');
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
    expect(pick?.author.id).toBe('https://openalex.org/A2');
    expect(pick?.disambiguation).toBe('disambiguated');
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

  it('confirms within asymmetric slack window (-3 low / +2 high)', () => {
    const author = makeAuthor({
      affiliations: [
        { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2022, 2023] },
      ],
    });
    // Target 2019 — 3 years below min (inside low slack of -3)
    expect(checkAffiliation(author, 'Anthropic', 2019).matched).toBe(true);
    // Target 2025 — 2 years above max (inside high slack of +2)
    expect(checkAffiliation(author, 'Anthropic', 2025).matched).toBe(true);
    // Target 2018 — 4 years below min, outside the low slack
    expect(checkAffiliation(author, 'Anthropic', 2018).matched).toBe(false);
    // Target 2026 — 3 years above max, outside the high slack
    expect(checkAffiliation(author, 'Anthropic', 2026).matched).toBe(false);
  });

  it('flags wrongYear when the org matches but the year window is too far off', () => {
    const author = makeAuthor({
      affiliations: [
        { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2022, 2023] },
      ],
    });
    const result = checkAffiliation(author, 'Anthropic', 2010);
    expect(result.matched).toBe(false);
    expect(result.wrongYear).toBe(true);
    expect(result.wrongOrg).toBe(false);
    expect(result.matchedInstitution).toBe('Anthropic');
  });

  // Regression: the early-return bug (hostile review HIGH #1). OpenAlex
  // commonly emits multiple affiliation rows per institution across different
  // year clusters. The loop must consider all of them before deciding.
  it('considers ALL org-matching affiliations before flagging wrongYear', () => {
    const author = makeAuthor({
      affiliations: [
        // First entry's year window would reject target 2023 — if the loop
        // returns on the first match, we'd produce a false wrongYear verdict.
        { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2015, 2016] },
        // Second entry covers the target year.
        { institution: { id: 'I2', display_name: 'Anthropic' }, years: [2022, 2023, 2024] },
      ],
    });
    const result = checkAffiliation(author, 'Anthropic', 2023);
    expect(result.matched).toBe(true);
    expect(result.wrongYear).toBe(false);
  });

  it('flags wrongYear only when EVERY org match excludes the target year', () => {
    const author = makeAuthor({
      affiliations: [
        { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2015] },
        { institution: { id: 'I2', display_name: 'Anthropic' }, years: [2016] },
      ],
    });
    const result = checkAffiliation(author, 'Anthropic', 2023);
    expect(result.wrongYear).toBe(true);
    expect(result.matched).toBe(false);
  });

  it('does NOT flag wrongYear when one org match has empty years (no signal)', () => {
    const author = makeAuthor({
      affiliations: [
        // This row on its own would reject 2023.
        { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2015] },
        // This row has no year data — could be the actual current affiliation.
        { institution: { id: 'I2', display_name: 'Anthropic' }, years: [] },
      ],
    });
    // Safer to not contradict: the empty-years row could be the correct
    // current employment entry with year data not yet indexed.
    const result = checkAffiliation(author, 'Anthropic', 2023);
    expect(result.matched).toBe(true);
    expect(result.wrongYear).toBe(false);
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

  // Regression: before using isResolvableName, a sid_* stableId leaking
  // through name resolution would become a garbage OpenAlex query.
  it('returns null when the person name is a sid_ stableId', async () => {
    const item = makePersonnelItem({ person: 'sid_1LcLlMGLbw', org: 'Anthropic' });
    expect(await tryOpenAlexMatch(item)).toBeNull();
  });

  it('returns null when the org name is a sid_ stableId', async () => {
    const item = makePersonnelItem({ person: 'Amanda Askell', org: 'sid_1LcLlMGLbw' });
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

  // Regression: the works_count filter must run BEFORE pickBestAuthor so that
  // a legitimate researcher is picked over a same-named stub. Previously the
  // filter ran after, which could cause pickBestAuthor to pick the stub and
  // then reject it, missing the valid match.
  it('picks the legitimate researcher when a same-named stub author also exists', async () => {
    mockAuthorsByQuery['james chen'] = [
      // Stub — first in the list, zero works. Without pre-filter this was picked
      // because nameMatched.length === 1 after disambiguation, then rejected.
      makeAuthor({
        id: 'https://openalex.org/A1',
        display_name: 'James Chen',
        works_count: 0,
        affiliations: [],
      }),
      // The real researcher, with affiliations covering the target.
      makeAuthor({
        id: 'https://openalex.org/A2',
        display_name: 'James Chen',
        works_count: 50,
        affiliations: [
          { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2022, 2023] },
        ],
      }),
    ];

    const item = makePersonnelItem({
      person: 'James Chen',
      org: 'Anthropic',
      startDate: '2023',
    });

    const result = await tryOpenAlexMatch(item);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('confirmed');
    expect(result!.reasoning).toContain('A2');
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
    expect(result!.confidence).toBeCloseTo(0.9);
    expect(result!.checkerModel).toBe('openalex-api');
    // Preserves item.sourceUrl when set, otherwise uses the OpenAlex author URL.
    // makePersonnelItem() doesn't set sourceUrl, so we expect best.id here.
    expect(result!.sourceUrl).toBe('https://openalex.org/A5012345678');
    expect(result!.reasoning).toContain('Anthropic');
    expect(result!.reasoning).toContain('A5012345678');
  });

  // Homonym guard: a single-name-match contradicted verdict is NOT safe
  // (the personnel record could be a different person OpenAlex doesn't have).
  // The matcher falls through to LLM instead of storing a wrong contradicted.
  it('returns null on single-name-match wrongOrg (homonym risk)', async () => {
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

    expect(await tryOpenAlexMatch(item)).toBeNull();
  });

  it('returns null on single-name-match wrongYear (homonym risk)', async () => {
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
      startDate: '2010',
    });

    expect(await tryOpenAlexMatch(item)).toBeNull();
  });

  // Contradicted IS stored when the candidate was disambiguated by org context
  // (multiple name matches + unique org tiebreak) — no homonym risk in that case.
  it('returns contradicted with conservative confidence when disambiguated by org', async () => {
    mockAuthorsByQuery['james chen'] = [
      // Two name matches — second one is selected by org disambiguation.
      makeAuthor({
        id: 'https://openalex.org/A1',
        display_name: 'James Chen',
        works_count: 25,
        affiliations: [
          { institution: { id: 'I1', display_name: 'Stanford University' }, years: [2019, 2020] },
        ],
      }),
      makeAuthor({
        id: 'https://openalex.org/A2',
        display_name: 'James Chen',
        works_count: 40,
        // This person has affiliations that include Anthropic so org-disambiguation
        // picks this record. But his Anthropic years are 2015, well outside the
        // target-year slack window — so we know we have the right person AND the
        // year is wrong → safe to contradict.
        affiliations: [
          { institution: { id: 'I2', display_name: 'Anthropic' }, years: [2015] },
        ],
      }),
    ];

    const item = makePersonnelItem({
      person: 'James Chen',
      org: 'Anthropic',
      startDate: '2023',
    });

    const result = await tryOpenAlexMatch(item);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('contradicted');
    expect(result!.confidence).toBeCloseTo(0.65);
    expect(result!.reasoning).toContain('2023');
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

  // Regression: preserve the curated sourceUrl when set on the input item.
  // Previously the matcher unconditionally overwrote it with the OpenAlex URL.
  it('preserves a pre-set item.sourceUrl instead of overwriting with best.id', async () => {
    mockAuthorsByQuery['amanda askell'] = [
      makeAuthor({
        id: 'https://openalex.org/A5012345678',
        display_name: 'Amanda Askell',
        works_count: 30,
        affiliations: [
          { institution: { id: 'I1', display_name: 'Anthropic' }, years: [2022] },
        ],
      }),
    ];

    const item = makePersonnelItem({
      person: 'Amanda Askell',
      org: 'Anthropic',
      startDate: '2022',
    });
    item.sourceUrl = 'https://anthropic.com/team';

    const result = await tryOpenAlexMatch(item);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('confirmed');
    expect(result!.sourceUrl).toBe('https://anthropic.com/team');
    // The OpenAlex ID is still in reasoning so operators can find the author entry.
    expect(result!.reasoning).toContain('A5012345678');
  });
});
