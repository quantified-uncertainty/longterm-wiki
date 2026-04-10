import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tryWikidataMatch, extractQid, clearEntityCache, fetchEntities } from './wikidata-matcher.ts';
import type { VerifyItem, FactItemData } from './orchestrator-types.ts';

// ── Mock Wikidata API at HTTP level ─────────────────────────────────

/**
 * Registry of mock Wikidata entities. Tests populate this before each test,
 * and the mocked fetch returns the appropriate entity data.
 */
const mockEntities: Record<string, unknown> = {};

function setMockEntity(qid: string, data: unknown): void {
  mockEntities[qid] = data;
}

function clearMocks(): void {
  for (const key of Object.keys(mockEntities)) delete mockEntities[key];
}

// Mock global fetch
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  // Parse QIDs from the URL
  const idsParam = new URL(url).searchParams.get('ids');
  if (!idsParam) return { ok: false, status: 400 };

  const qids = idsParam.split('|');
  const entities: Record<string, unknown> = {};
  for (const qid of qids) {
    if (mockEntities[qid]) {
      entities[qid] = mockEntities[qid];
    } else {
      entities[qid] = { id: qid, missing: '' };
    }
  }

  return {
    ok: true,
    status: 200,
    json: async () => ({ entities }),
  };
}));

// ── Test helpers ────────────────────────────────────────────────────

function makeFactItem(overrides: {
  propertyName: string;
  formattedValue: string;
  source: string;
  entityName?: string;
}): VerifyItem {
  const data: FactItemData = {
    kind: 'fact',
    entity: {
      id: 'test-entity',
      name: overrides.entityName ?? 'Test Entity',
      type: 'organization',
      stableId: 'test-entity',
    },
    fact: {
      id: 'test-fact-1',
      subjectId: 'test-entity',
      propertyId: overrides.propertyName,
      value: { type: 'text', value: overrides.formattedValue },
      source: overrides.source,
    },
    propertyName: overrides.propertyName,
    formattedValue: overrides.formattedValue,
  };

  return {
    kind: 'fact',
    id: `fact:test-entity:${overrides.propertyName}`,
    description: `${overrides.entityName ?? 'Test Entity'} ${overrides.propertyName} = ${overrides.formattedValue}`,
    entityType: 'organization',
    entityName: overrides.entityName ?? 'Test Entity',
    priority: 50,
    sourceUrl: overrides.source,
    neverVerified: true,
    data,
  };
}

function makeWikidataEntity(qid: string, opts: {
  labels?: Record<string, { language: string; value: string }>;
  claims?: Record<string, unknown[]>;
  sitelinks?: Record<string, { site: string; title: string }>;
}) {
  return {
    id: qid,
    labels: opts.labels ?? { en: { language: 'en', value: 'Test Entity' } },
    claims: opts.claims ?? {},
    sitelinks: opts.sitelinks ?? {},
  };
}

function makeStringClaim(pid: string, value: string, rank: string = 'normal') {
  return {
    mainsnak: {
      snaktype: 'value',
      property: pid,
      datavalue: { type: 'string', value },
    },
    rank,
  };
}

function makeTimeClaim(pid: string, time: string, rank: string = 'normal') {
  return {
    mainsnak: {
      snaktype: 'value',
      property: pid,
      datavalue: { type: 'time', value: { time, precision: 11 } },
    },
    rank,
  };
}

function makeEntityRefClaim(pid: string, refQid: string, rank: string = 'normal') {
  return {
    mainsnak: {
      snaktype: 'value',
      property: pid,
      datavalue: { type: 'wikibase-entityid', value: { id: refQid, 'entity-type': 'item' } },
    },
    rank,
  };
}

function makeQuantityClaim(pid: string, amount: number, unit?: string, rank: string = 'normal') {
  return {
    mainsnak: {
      snaktype: 'value',
      property: pid,
      datavalue: {
        type: 'quantity',
        value: {
          amount: amount >= 0 ? `+${amount}` : `${amount}`,
          unit: unit ?? '1',
        },
      },
    },
    rank,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('extractQid', () => {
  it('extracts QID from standard Wikidata URL', () => {
    expect(extractQid('https://www.wikidata.org/wiki/Q123456')).toBe('Q123456');
  });

  it('extracts QID from URL with trailing comma', () => {
    expect(extractQid('https://www.wikidata.org/wiki/Q123456,')).toBe('Q123456');
  });

  it('extracts QID from entity URL', () => {
    expect(extractQid('https://www.wikidata.org/entity/Q42')).toBe('Q42');
  });

  it('returns null for non-Wikidata URLs', () => {
    expect(extractQid('https://en.wikipedia.org/wiki/Anthropic')).toBeNull();
  });

  it('returns null for URL without QID', () => {
    expect(extractQid('https://www.wikidata.org/wiki/Property:P856')).toBeNull();
  });
});

describe('tryWikidataMatch', () => {
  beforeEach(() => {
    clearMocks();
    clearEntityCache();
  });

  it('returns null for non-fact items', async () => {
    const item = makeFactItem({ propertyName: 'website', formattedValue: 'https://example.com', source: 'https://example.com' });
    // Override to record kind
    (item.data as unknown as { kind: string }).kind = 'record';
    expect(await tryWikidataMatch(item)).toBeNull();
  });

  it('returns null for non-Wikidata source URLs', async () => {
    const item = makeFactItem({
      propertyName: 'website',
      formattedValue: 'https://anthropic.com',
      source: 'https://en.wikipedia.org/wiki/Anthropic',
    });
    expect(await tryWikidataMatch(item)).toBeNull();
  });

  it('returns null for unmapped properties (description)', async () => {
    setMockEntity('Q123', makeWikidataEntity('Q123', {}));
    const item = makeFactItem({
      propertyName: 'description',
      formattedValue: 'An AI safety company',
      source: 'https://www.wikidata.org/wiki/Q123',
    });
    expect(await tryWikidataMatch(item)).toBeNull();
  });

  // ── URL matching (P856 website) ──

  describe('website (P856 url)', () => {
    it('confirms matching URL', async () => {
      setMockEntity('Q100', makeWikidataEntity('Q100', {
        claims: { P856: [makeStringClaim('P856', 'https://anthropic.com')] },
      }));
      const item = makeFactItem({
        propertyName: 'website',
        formattedValue: 'https://anthropic.com',
        source: 'https://www.wikidata.org/wiki/Q100',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
      expect(result!.confidence).toBe(0.95);
      expect(result!.checkerModel).toBe('wikidata-api');
    });

    it('confirms URL with www/https normalization', async () => {
      setMockEntity('Q100', makeWikidataEntity('Q100', {
        claims: { P856: [makeStringClaim('P856', 'https://www.anthropic.com/')] },
      }));
      const item = makeFactItem({
        propertyName: 'website',
        formattedValue: 'http://anthropic.com',
        source: 'https://www.wikidata.org/wiki/Q100',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });

    it('contradicts mismatched URL', async () => {
      setMockEntity('Q100', makeWikidataEntity('Q100', {
        claims: { P856: [makeStringClaim('P856', 'https://openai.com')] },
      }));
      const item = makeFactItem({
        propertyName: 'website',
        formattedValue: 'https://anthropic.com',
        source: 'https://www.wikidata.org/wiki/Q100',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('contradicted');
      expect(result!.confidence).toBe(0.90);
    });

    it('returns unverifiable when P856 missing', async () => {
      setMockEntity('Q100', makeWikidataEntity('Q100', { claims: {} }));
      const item = makeFactItem({
        propertyName: 'website',
        formattedValue: 'https://anthropic.com',
        source: 'https://www.wikidata.org/wiki/Q100',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('unverifiable');
      expect(result!.confidence).toBe(0.80);
    });
  });

  // ── Sitelink matching (wikipedia-url) ──

  describe('wikipedia-url (sitelink)', () => {
    it('confirms matching Wikipedia URL', async () => {
      setMockEntity('Q200', makeWikidataEntity('Q200', {
        sitelinks: { enwiki: { site: 'enwiki', title: 'Anthropic' } },
      }));
      const item = makeFactItem({
        propertyName: 'wikipedia-url',
        formattedValue: 'https://en.wikipedia.org/wiki/Anthropic',
        source: 'https://www.wikidata.org/wiki/Q200',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });

    it('handles sitelink title with spaces and parentheses', async () => {
      setMockEntity('Q201', makeWikidataEntity('Q201', {
        sitelinks: { enwiki: { site: 'enwiki', title: 'Asana (software)' } },
      }));
      const item = makeFactItem({
        propertyName: 'wikipedia-url',
        formattedValue: 'https://en.wikipedia.org/wiki/Asana_(software)',
        source: 'https://www.wikidata.org/wiki/Q201',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });

    it('returns unverifiable when no enwiki sitelink', async () => {
      setMockEntity('Q202', makeWikidataEntity('Q202', { sitelinks: {} }));
      const item = makeFactItem({
        propertyName: 'wikipedia-url',
        formattedValue: 'https://en.wikipedia.org/wiki/Something',
        source: 'https://www.wikidata.org/wiki/Q202',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('unverifiable');
    });
  });

  // ── Date matching (P571 founded-date) ──

  describe('founded-date (P571 date)', () => {
    it('confirms matching date', async () => {
      setMockEntity('Q300', makeWikidataEntity('Q300', {
        claims: { P571: [makeTimeClaim('P571', '+2021-01-01T00:00:00Z')] },
      }));
      const item = makeFactItem({
        propertyName: 'founded-date',
        formattedValue: '2021-01',
        source: 'https://www.wikidata.org/wiki/Q300',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });

    it('confirms year-only match against full date', async () => {
      setMockEntity('Q301', makeWikidataEntity('Q301', {
        claims: { P571: [makeTimeClaim('P571', '+2015-12-11T00:00:00Z')] },
      }));
      const item = makeFactItem({
        propertyName: 'founded-date',
        formattedValue: '2015',
        source: 'https://www.wikidata.org/wiki/Q301',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });

    it('contradicts different date', async () => {
      setMockEntity('Q302', makeWikidataEntity('Q302', {
        claims: { P571: [makeTimeClaim('P571', '+2020-06-15T00:00:00Z')] },
      }));
      const item = makeFactItem({
        propertyName: 'founded-date',
        formattedValue: '2019-03',
        source: 'https://www.wikidata.org/wiki/Q302',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('contradicted');
    });
  });

  // ── Year matching (P569 born-year) ──

  describe('born-year (P569 year)', () => {
    it('confirms matching year', async () => {
      setMockEntity('Q400', makeWikidataEntity('Q400', {
        claims: { P569: [makeTimeClaim('P569', '+1985-05-20T00:00:00Z')] },
      }));
      const item = makeFactItem({
        propertyName: 'born-year',
        formattedValue: '1985',
        source: 'https://www.wikidata.org/wiki/Q400',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });

    it('contradicts wrong year', async () => {
      setMockEntity('Q401', makeWikidataEntity('Q401', {
        claims: { P569: [makeTimeClaim('P569', '+1990-01-01T00:00:00Z')] },
      }));
      const item = makeFactItem({
        propertyName: 'born-year',
        formattedValue: '1985',
        source: 'https://www.wikidata.org/wiki/Q401',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('contradicted');
    });
  });

  // ── Entity reference matching (country, headquarters, ceo, etc.) ──

  describe('country (P17 entityRef)', () => {
    it('confirms matching country', async () => {
      setMockEntity('Q500', makeWikidataEntity('Q500', {
        claims: { P17: [makeEntityRefClaim('P17', 'Q30')] },
      }));
      // Q30 = United States
      setMockEntity('Q30', makeWikidataEntity('Q30', {
        labels: { en: { language: 'en', value: 'United States' } },
      }));
      const item = makeFactItem({
        propertyName: 'country',
        formattedValue: 'United States',
        source: 'https://www.wikidata.org/wiki/Q500',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });
  });

  describe('headquarters (P159 entityRef)', () => {
    it('confirms matching headquarters city', async () => {
      setMockEntity('Q600', makeWikidataEntity('Q600', {
        claims: { P159: [makeEntityRefClaim('P159', 'Q62')] },
      }));
      setMockEntity('Q62', makeWikidataEntity('Q62', {
        labels: { en: { language: 'en', value: 'San Francisco' } },
      }));
      const item = makeFactItem({
        propertyName: 'headquarters',
        formattedValue: 'San Francisco',
        source: 'https://www.wikidata.org/wiki/Q600',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
      expect(result!.extractedValue).toContain('Q62');
      expect(result!.extractedValue).toContain('San Francisco');
    });
  });

  describe('ceo (P169 entityRef)', () => {
    it('confirms matching CEO', async () => {
      setMockEntity('Q700', makeWikidataEntity('Q700', {
        claims: { P169: [makeEntityRefClaim('P169', 'Q70')] },
      }));
      setMockEntity('Q70', makeWikidataEntity('Q70', {
        labels: { en: { language: 'en', value: 'Dario Amodei' } },
      }));
      const item = makeFactItem({
        propertyName: 'ceo',
        formattedValue: 'Dario Amodei',
        source: 'https://www.wikidata.org/wiki/Q700',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });

    it('returns unverifiable when P169 missing', async () => {
      setMockEntity('Q701', makeWikidataEntity('Q701', { claims: {} }));
      const item = makeFactItem({
        propertyName: 'ceo',
        formattedValue: 'Dario Amodei',
        source: 'https://www.wikidata.org/wiki/Q701',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('unverifiable');
    });
  });

  describe('parent-organization (P749 entityRef)', () => {
    it('confirms matching parent org', async () => {
      setMockEntity('Q800', makeWikidataEntity('Q800', {
        claims: { P749: [makeEntityRefClaim('P749', 'Q81')] },
      }));
      setMockEntity('Q81', makeWikidataEntity('Q81', {
        labels: { en: { language: 'en', value: 'Alphabet Inc.' } },
      }));
      const item = makeFactItem({
        propertyName: 'parent-organization',
        formattedValue: 'Alphabet',
        source: 'https://www.wikidata.org/wiki/Q800',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });
  });

  describe('legal-structure (P1454 entityRef)', () => {
    it('confirms matching legal form', async () => {
      setMockEntity('Q850', makeWikidataEntity('Q850', {
        claims: { P1454: [makeEntityRefClaim('P1454', 'Q85')] },
      }));
      setMockEntity('Q85', makeWikidataEntity('Q85', {
        labels: { en: { language: 'en', value: 'public benefit corporation' } },
      }));
      const item = makeFactItem({
        propertyName: 'legal-structure',
        formattedValue: 'Public Benefit Corporation',
        source: 'https://www.wikidata.org/wiki/Q850',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });
  });

  describe('education (P69 entityRef, multi-valued)', () => {
    it('confirms when fact value matches one of multiple values', async () => {
      setMockEntity('Q860', makeWikidataEntity('Q860', {
        claims: { P69: [
          makeEntityRefClaim('P69', 'Q86'),
          makeEntityRefClaim('P69', 'Q87'),
        ]},
      }));
      setMockEntity('Q86', makeWikidataEntity('Q86', {
        labels: { en: { language: 'en', value: 'Stanford University' } },
      }));
      setMockEntity('Q87', makeWikidataEntity('Q87', {
        labels: { en: { language: 'en', value: 'MIT' } },
      }));
      const item = makeFactItem({
        propertyName: 'education',
        formattedValue: 'MIT',
        source: 'https://www.wikidata.org/wiki/Q860',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });
  });

  // ── Multi-valued entity ref (P112 founded-by-name, 4 founders) ──

  describe('founded-by-name (P112 entityRef, multi-valued)', () => {
    it('confirms when fact value matches one of four founders', async () => {
      setMockEntity('Q900', makeWikidataEntity('Q900', {
        claims: { P112: [
          makeEntityRefClaim('P112', 'Q91'),
          makeEntityRefClaim('P112', 'Q92'),
          makeEntityRefClaim('P112', 'Q93'),
          makeEntityRefClaim('P112', 'Q94'),
        ]},
      }));
      setMockEntity('Q91', makeWikidataEntity('Q91', {
        labels: { en: { language: 'en', value: 'Dario Amodei' } },
      }));
      setMockEntity('Q92', makeWikidataEntity('Q92', {
        labels: { en: { language: 'en', value: 'Daniela Amodei' } },
      }));
      setMockEntity('Q93', makeWikidataEntity('Q93', {
        labels: { en: { language: 'en', value: 'Tom Brown' } },
      }));
      setMockEntity('Q94', makeWikidataEntity('Q94', {
        labels: { en: { language: 'en', value: 'Chris Olah' } },
      }));
      const item = makeFactItem({
        propertyName: 'founded-by-name',
        formattedValue: 'Daniela Amodei',
        source: 'https://www.wikidata.org/wiki/Q900',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });

    it('contradicts when fact value not among founders', async () => {
      setMockEntity('Q901', makeWikidataEntity('Q901', {
        claims: { P112: [
          makeEntityRefClaim('P112', 'Q91'),
          makeEntityRefClaim('P112', 'Q92'),
        ]},
      }));
      setMockEntity('Q91', makeWikidataEntity('Q91', {
        labels: { en: { language: 'en', value: 'Alice Smith' } },
      }));
      setMockEntity('Q92', makeWikidataEntity('Q92', {
        labels: { en: { language: 'en', value: 'Bob Jones' } },
      }));
      const item = makeFactItem({
        propertyName: 'founded-by-name',
        formattedValue: 'Charlie Brown',
        source: 'https://www.wikidata.org/wiki/Q901',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('contradicted');
    });
  });

  // ── Claim rank filtering ──

  describe('claim rank filtering', () => {
    it('uses preferred claim over normal', async () => {
      setMockEntity('Q950', makeWikidataEntity('Q950', {
        claims: { P856: [
          makeStringClaim('P856', 'https://old-site.com', 'normal'),
          makeStringClaim('P856', 'https://new-site.com', 'preferred'),
        ]},
      }));
      const item = makeFactItem({
        propertyName: 'website',
        formattedValue: 'https://new-site.com',
        source: 'https://www.wikidata.org/wiki/Q950',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });

    it('ignores deprecated claims', async () => {
      setMockEntity('Q951', makeWikidataEntity('Q951', {
        claims: { P856: [
          makeStringClaim('P856', 'https://deprecated-site.com', 'deprecated'),
        ]},
      }));
      const item = makeFactItem({
        propertyName: 'website',
        formattedValue: 'https://anything.com',
        source: 'https://www.wikidata.org/wiki/Q951',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      // No active claims -> unverifiable
      expect(result!.verdict).toBe('unverifiable');
    });
  });

  // ── Trailing comma in URL ──

  describe('trailing comma URL handling', () => {
    it('extracts QID from URL with trailing comma', async () => {
      setMockEntity('Q136', makeWikidataEntity('Q136', {
        claims: { P856: [makeStringClaim('P856', 'https://example.com')] },
      }));
      const item = makeFactItem({
        propertyName: 'website',
        formattedValue: 'https://example.com',
        source: 'https://www.wikidata.org/wiki/Q136,',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });
  });

  // ── Entity with no English label ──

  describe('entity with no English label', () => {
    it('returns null (falls through to LLM) when referenced entity has no en label', async () => {
      setMockEntity('Q960', makeWikidataEntity('Q960', {
        claims: { P17: [makeEntityRefClaim('P17', 'Q961')] },
      }));
      // Q961 exists but has no English label
      setMockEntity('Q961', makeWikidataEntity('Q961', {
        labels: { de: { language: 'de', value: 'Deutschland' } },
      }));
      const item = makeFactItem({
        propertyName: 'country',
        formattedValue: 'Germany',
        source: 'https://www.wikidata.org/wiki/Q960',
      });
      const result = await tryWikidataMatch(item);
      // No English label -> can't compare -> return null -> LLM fallback
      expect(result).toBeNull();
    });
  });

  // ── Quantity matching (P1128 headcount, P2139 revenue) ──

  describe('headcount (P1128 quantity)', () => {
    it('confirms matching headcount within tolerance', async () => {
      setMockEntity('Q1000', makeWikidataEntity('Q1000', {
        claims: { P1128: [makeQuantityClaim('P1128', 3200)] },
      }));
      const item = makeFactItem({
        propertyName: 'headcount',
        formattedValue: '3100',
        source: 'https://www.wikidata.org/wiki/Q1000',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
      expect(result!.confidence).toBe(0.95);
    });

    it('contradicts headcount outside tolerance', async () => {
      setMockEntity('Q1001', makeWikidataEntity('Q1001', {
        claims: { P1128: [makeQuantityClaim('P1128', 5000)] },
      }));
      const item = makeFactItem({
        propertyName: 'headcount',
        formattedValue: '2000',
        source: 'https://www.wikidata.org/wiki/Q1001',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('contradicted');
    });

    it('returns unverifiable when P1128 missing', async () => {
      setMockEntity('Q1002', makeWikidataEntity('Q1002', { claims: {} }));
      const item = makeFactItem({
        propertyName: 'headcount',
        formattedValue: '1000',
        source: 'https://www.wikidata.org/wiki/Q1002',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('unverifiable');
    });
  });

  describe('revenue (P2139 quantity)', () => {
    const USD_UNIT = 'http://www.wikidata.org/entity/Q4917';
    const EUR_UNIT = 'http://www.wikidata.org/entity/Q4916';

    it('confirms matching USD revenue within 10% tolerance', async () => {
      setMockEntity('Q1100', makeWikidataEntity('Q1100', {
        claims: { P2139: [makeQuantityClaim('P2139', 6000000000, USD_UNIT)] },
      }));
      const item = makeFactItem({
        propertyName: 'revenue',
        formattedValue: '$5,800,000,000',
        source: 'https://www.wikidata.org/wiki/Q1100',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });

    it('contradicts USD revenue far outside tolerance', async () => {
      setMockEntity('Q1101', makeWikidataEntity('Q1101', {
        claims: { P2139: [makeQuantityClaim('P2139', 10000000000, USD_UNIT)] },
      }));
      const item = makeFactItem({
        propertyName: 'revenue',
        formattedValue: '$1000000000',
        source: 'https://www.wikidata.org/wiki/Q1101',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('contradicted');
    });

    it('returns null for unparseable fact value', async () => {
      setMockEntity('Q1102', makeWikidataEntity('Q1102', {
        claims: { P2139: [makeQuantityClaim('P2139', 5000000, USD_UNIT)] },
      }));
      const item = makeFactItem({
        propertyName: 'revenue',
        formattedValue: 'approximately five billion',
        source: 'https://www.wikidata.org/wiki/Q1102',
      });
      const result = await tryWikidataMatch(item);
      // Can't parse "approximately five billion" as a number -> fall through to LLM
      expect(result).toBeNull();
    });

    it('rejects mixed-text numeric values like "$5.8 billion" (strict parse)', async () => {
      setMockEntity('Q1103', makeWikidataEntity('Q1103', {
        claims: { P2139: [makeQuantityClaim('P2139', 5800000000, USD_UNIT)] },
      }));
      const item = makeFactItem({
        propertyName: 'revenue',
        formattedValue: '$5.8 billion',
        source: 'https://www.wikidata.org/wiki/Q1103',
      });
      const result = await tryWikidataMatch(item);
      // "$5.8 billion" after stripping -> "5.8billion", strict numeric regex rejects.
      // Must fall through to LLM instead of partial-parsing as 5.8.
      expect(result).toBeNull();
    });

    it('falls through to LLM when fact currency mismatches Wikidata unit', async () => {
      // Wikidata claim is in EUR; fact is in USD. Same magnitude but different currency
      // must NOT be confirmed — a cross-currency confirmation would be a false positive.
      setMockEntity('Q1104', makeWikidataEntity('Q1104', {
        claims: { P2139: [makeQuantityClaim('P2139', 6000000000, EUR_UNIT)] },
      }));
      const item = makeFactItem({
        propertyName: 'revenue',
        formattedValue: '$6,000,000,000',
        source: 'https://www.wikidata.org/wiki/Q1104',
      });
      const result = await tryWikidataMatch(item);
      expect(result).toBeNull();
    });

    it('confirms matching EUR revenue when both sides are EUR', async () => {
      setMockEntity('Q1105', makeWikidataEntity('Q1105', {
        claims: { P2139: [makeQuantityClaim('P2139', 6000000000, EUR_UNIT)] },
      }));
      const item = makeFactItem({
        propertyName: 'revenue',
        formattedValue: '€5,800,000,000',
        source: 'https://www.wikidata.org/wiki/Q1105',
      });
      const result = await tryWikidataMatch(item);
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe('confirmed');
    });
  });

  // ── Missing entity in Wikidata ──

  describe('missing Wikidata entity', () => {
    it('returns null when entity not found in Wikidata', async () => {
      // Don't set any mock entity for Q999
      const item = makeFactItem({
        propertyName: 'website',
        formattedValue: 'https://example.com',
        source: 'https://www.wikidata.org/wiki/Q999',
      });
      const result = await tryWikidataMatch(item);
      expect(result).toBeNull();
    });
  });
});
