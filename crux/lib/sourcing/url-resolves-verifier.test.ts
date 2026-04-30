/**
 * Tests for the url-resolves verifier (QUA-927).
 *
 * The verifier consumes the Resource pipeline (`lookupResourceByUrl`,
 * `getCitationContentByUrl`, `suggestResourcesApi`) — it does not fetch URLs.
 * Tests mock those three modules and exercise the decision tree:
 *   - cached citation_content with 2xx httpStatus     → confirmed
 *   - Wikipedia + 2xx + matching pageTitle            → confirmed
 *   - Wikipedia + 2xx + non-matching pageTitle        → contradicted
 *   - cached citation_content with 4xx/5xx            → contradicted
 *   - resources.fetchStatus is dead/soft_404/etc.     → contradicted
 *   - resources.fetchStatus is paywall                → confirmed (URL alive)
 *   - no cached state                                  → unverifiable, ingest enqueued
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  tryUrlResolvesVerify,
  resolveFromResourcePipeline,
  titleContainsEntityName,
} from './url-resolves-verifier.ts';
import type { VerifyItem, FactItemData } from './orchestrator-types.ts';

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('../wiki-server/citations.ts', () => ({
  getCitationContentByUrl: vi.fn(async () => ({ ok: false, status: 404, message: 'not found' })),
}));

vi.mock('../wiki-server/resources.ts', () => ({
  lookupResourceByUrl: vi.fn(async () => ({ ok: false, status: 404, message: 'not found' })),
  suggestResourcesApi: vi.fn(async () => ({ ok: true, data: { suggested: [], skipped: [] } })),
}));

import { getCitationContentByUrl } from '../wiki-server/citations.ts';
import { lookupResourceByUrl, suggestResourcesApi } from '../wiki-server/resources.ts';

const getCitationContentByUrlMock = vi.mocked(getCitationContentByUrl);
const lookupResourceByUrlMock = vi.mocked(lookupResourceByUrl);
const suggestResourcesApiMock = vi.mocked(suggestResourcesApi);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing cached anywhere.
  getCitationContentByUrlMock.mockResolvedValue({ ok: false, status: 404, message: 'not found' } as never);
  lookupResourceByUrlMock.mockResolvedValue({ ok: false, status: 404, message: 'not found' } as never);
  suggestResourcesApiMock.mockResolvedValue({ ok: true, data: { suggested: [], skipped: [] } } as never);
});

// ── Helpers to construct mock responses ────────────────────────────

function citationContent(overrides: {
  httpStatus?: number | null;
  pageTitle?: string | null;
  fetchedAt?: string;
  fullText?: string | null;
}): { ok: true; data: unknown } {
  return {
    ok: true,
    data: {
      url: 'https://example.com',
      resourceId: null,
      fetchedAt: overrides.fetchedAt ?? '2026-04-30T00:00:00.000Z',
      httpStatus: overrides.httpStatus ?? null,
      contentType: 'text/html',
      pageTitle: overrides.pageTitle ?? null,
      fullTextPreview: null,
      fullText: overrides.fullText ?? null,
      contentLength: null,
      contentHash: null,
      fetchMethod: 'firecrawl',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    },
  };
}

function resourceRow(overrides: {
  fetchStatus?: 'ok' | 'dead' | 'soft_404' | 'not_found' | 'timeout' | 'unreachable' | 'paywall' | 'error' | null;
  archiveUrl?: string;
}): { ok: true; data: unknown } {
  return {
    ok: true,
    data: {
      id: 'r_test_001',
      url: 'https://example.com',
      title: 'Test',
      type: 'webpage',
      fetchStatus: overrides.fetchStatus ?? null,
      archiveUrl: overrides.archiveUrl,
      contentHash: null,
      lastFetchedAt: '2026-04-30T00:00:00.000Z',
    },
  };
}

// ── Test fixtures ───────────────────────────────────────────────────

function makeFactItem(overrides: Partial<FactItemData> = {}): VerifyItem {
  const data: FactItemData = {
    kind: 'fact',
    entity: { id: 'sid_test_anth', name: 'Anthropic', type: 'organization' } as FactItemData['entity'],
    fact: {
      id: 'f_url_001',
      propertyId: 'wikipedia-url',
      value: { type: 'text', value: 'https://en.wikipedia.org/wiki/Anthropic' },
      source: 'https://en.wikipedia.org/wiki/Anthropic',
    } as FactItemData['fact'],
    propertyName: 'Wikipedia',
    propertyId: 'wikipedia-url',
    formattedValue: 'https://en.wikipedia.org/wiki/Anthropic',
    rawValue: 'https://en.wikipedia.org/wiki/Anthropic',
    verifierKind: 'url-resolves',
    ...overrides,
  };
  return {
    kind: 'fact',
    id: `fact:${data.fact.id}`,
    description: `${data.entity.name} / ${data.propertyName} = ${data.formattedValue}`,
    entityType: data.entity.type ?? 'unknown',
    entityName: data.entity.name,
    priority: 1,
    sourceUrl: data.fact.source,
    neverVerified: true,
    data,
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────

describe('tryUrlResolvesVerify dispatch', () => {
  it('returns null when fact has no verifierKind', async () => {
    const item = makeFactItem({ verifierKind: undefined });
    const result = await tryUrlResolvesVerify(item);
    expect(result).toBeNull();
  });

  it('returns null for non-fact items', async () => {
    const item: VerifyItem = {
      kind: 'entity',
      id: 'entity:foo',
      description: 'foo',
      entityType: 'organization',
      entityName: 'Foo',
      priority: 1,
      neverVerified: true,
      data: { kind: 'entity', entity: { id: 'sid_foo', title: 'Foo', sources: [] } as never },
    };
    const result = await tryUrlResolvesVerify(item);
    expect(result).toBeNull();
  });

  it('does not call the Resource pipeline when verifierKind is unset', async () => {
    const item = makeFactItem({ verifierKind: undefined });
    await tryUrlResolvesVerify(item);
    expect(lookupResourceByUrlMock).not.toHaveBeenCalled();
    expect(getCitationContentByUrlMock).not.toHaveBeenCalled();
    expect(suggestResourcesApiMock).not.toHaveBeenCalled();
  });
});

describe('URL pre-validation', () => {
  it('returns unverifiable when fact value is not a URL', async () => {
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'just-a-username',
      formattedValue: 'just-a-username',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('unverifiable');
    expect(result?.checkerModel).toBe('url-resolves');
    expect(result?.reasoning).toContain('not an http(s) URL');
  });

  it('rejects ftp:// scheme without enqueueing', async () => {
    const item = makeFactItem({ rawValue: 'ftp://example.com/file' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('unverifiable');
    expect(suggestResourcesApiMock).not.toHaveBeenCalled();
  });

  it('rejects URLs with embedded credentials without enqueueing', async () => {
    const item = makeFactItem({ rawValue: 'https://user:pass@example.com' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('unverifiable');
    expect(result?.reasoning).toContain('not an http(s) URL');
    expect(suggestResourcesApiMock).not.toHaveBeenCalled();
  });

  it('returns unverifiable on empty rawValue', async () => {
    const item = makeFactItem({ rawValue: '' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('unverifiable');
  });
});

// ── Cached citation_content path (the happy path) ──────────────────

describe('cached citation_content', () => {
  it('confirmed when httpStatus is 200 (non-Wikipedia property)', async () => {
    getCitationContentByUrlMock.mockResolvedValueOnce(citationContent({ httpStatus: 200 }) as never);
    const item = makeFactItem({
      propertyId: 'github-profile',
      rawValue: 'https://github.com/anthropics',
    });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('confirmed');
    expect(result?.confidence).toBe(0.95);
    expect(result?.reasoning).toMatch(/HTTP 200/);
    expect(suggestResourcesApiMock).not.toHaveBeenCalled();
  });

  it.each([200, 201, 204, 299])('confirmed for any 2xx status (%i)', async (status) => {
    getCitationContentByUrlMock.mockResolvedValueOnce(citationContent({ httpStatus: status }) as never);
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://github.com/x' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('confirmed');
  });

  it.each([400, 403, 404, 410, 500, 503])('contradicted on %i (link rot)', async (status) => {
    getCitationContentByUrlMock.mockResolvedValueOnce(citationContent({ httpStatus: status }) as never);
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://github.com/x' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('contradicted');
    expect(result?.reasoning).toMatch(new RegExp(`HTTP ${status}`));
  });

  it('contradicted does NOT enqueue a fresh ingest job', async () => {
    getCitationContentByUrlMock.mockResolvedValueOnce(citationContent({ httpStatus: 404 }) as never);
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://github.com/x' });
    await tryUrlResolvesVerify(item);
    expect(suggestResourcesApiMock).not.toHaveBeenCalled();
  });

  it('falls through to fetchStatus when httpStatus is null but content row exists', async () => {
    getCitationContentByUrlMock.mockResolvedValueOnce(citationContent({ httpStatus: null }) as never);
    lookupResourceByUrlMock.mockResolvedValueOnce(resourceRow({ fetchStatus: 'ok' }) as never);
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://github.com/x' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('confirmed');
    expect(result?.reasoning).toContain('citation content pending');
  });
});

// ── Wikipedia title-match path ──────────────────────────────────────

describe('Wikipedia title check', () => {
  it('confirmed when cached pageTitle contains entity name', async () => {
    getCitationContentByUrlMock.mockResolvedValueOnce(
      citationContent({ httpStatus: 200, pageTitle: 'Anthropic - Wikipedia' }) as never,
    );
    const item = makeFactItem(); // entity: Anthropic, propertyId: wikipedia-url
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('confirmed');
    expect(result?.extractedValue).toBe('Anthropic');
    expect(result?.reasoning).toContain('cached title');
    expect(result?.reasoning).toContain('Anthropic');
  });

  it('contradicted when cached pageTitle does not contain entity name', async () => {
    getCitationContentByUrlMock.mockResolvedValueOnce(
      citationContent({ httpStatus: 200, pageTitle: 'Disambiguation - Wikipedia' }) as never,
    );
    const item = makeFactItem();
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('contradicted');
    expect(result?.confidence).toBe(0.85);
    expect(result?.reasoning).toMatch(/does not contain/);
  });

  it('handles em-dash separator in pageTitle', async () => {
    getCitationContentByUrlMock.mockResolvedValueOnce(
      citationContent({ httpStatus: 200, pageTitle: 'Anthropic – Wikipedia' }) as never,
    );
    const item = makeFactItem();
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('confirmed');
    expect(result?.extractedValue).toBe('Anthropic');
  });

  it('confirmed at lower confidence when pageTitle is null but httpStatus is 200', async () => {
    getCitationContentByUrlMock.mockResolvedValueOnce(
      citationContent({ httpStatus: 200, pageTitle: null }) as never,
    );
    const item = makeFactItem();
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('confirmed');
    expect(result?.confidence).toBe(0.7);
    expect(result?.reasoning).toContain('no cached pageTitle');
  });

  it('contradicted on Wikipedia 4xx', async () => {
    getCitationContentByUrlMock.mockResolvedValueOnce(citationContent({ httpStatus: 404 }) as never);
    const item = makeFactItem();
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('contradicted');
  });
});

// ── Resource fetchStatus path ───────────────────────────────────────

describe('Resource fetchStatus (no cached citation_content)', () => {
  it.each(['dead', 'soft_404', 'not_found', 'timeout', 'unreachable'] as const)(
    'contradicted on dead-variant fetchStatus: %s',
    async (status) => {
      lookupResourceByUrlMock.mockResolvedValueOnce(resourceRow({ fetchStatus: status }) as never);
      const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://github.com/x' });
      const result = await tryUrlResolvesVerify(item);
      expect(result?.verdict).toBe('contradicted');
      expect(result?.reasoning).toContain(`fetch_status: ${status}`);
    },
  );

  it('confirmed (high confidence) on paywall — URL is alive', async () => {
    lookupResourceByUrlMock.mockResolvedValueOnce(resourceRow({ fetchStatus: 'paywall' }) as never);
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://nyt.com/article' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('confirmed');
    expect(result?.confidence).toBe(0.85);
    expect(result?.reasoning).toContain('paywall');
  });

  it('confirmed (high confidence) on fetchStatus=ok with no cached content yet', async () => {
    lookupResourceByUrlMock.mockResolvedValueOnce(resourceRow({ fetchStatus: 'ok' }) as never);
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://github.com/x' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('confirmed');
    expect(result?.confidence).toBe(0.85);
    expect(result?.reasoning).toContain('citation content pending');
  });

  it('falls through to enqueue when fetchStatus=error', async () => {
    lookupResourceByUrlMock.mockResolvedValueOnce(resourceRow({ fetchStatus: 'error' }) as never);
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://github.com/x' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('unverifiable');
    expect(suggestResourcesApiMock).toHaveBeenCalledWith({ urls: ['https://github.com/x'] });
  });
});

// ── Self-healing: unknown URL enqueues ingest ──────────────────────

describe('no cached state — enqueue ingest', () => {
  it('returns unverifiable and enqueues a resource-ingest job', async () => {
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://github.com/anthropics' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('unverifiable');
    expect(result?.confidence).toBe(0.7);
    expect(result?.reasoning).toContain('resource-ingest job enqueued');
    expect(suggestResourcesApiMock).toHaveBeenCalledTimes(1);
    expect(suggestResourcesApiMock).toHaveBeenCalledWith({ urls: ['https://github.com/anthropics'] });
  });

  it('reports enqueue failure in reasoning', async () => {
    suggestResourcesApiMock.mockResolvedValueOnce({ ok: false, status: 500, message: 'wiki-server down' } as never);
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://github.com/x' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('unverifiable');
    expect(result?.reasoning).toContain('failed to enqueue ingest');
    expect(result?.reasoning).toContain('wiki-server down');
  });

  it('handles thrown errors from suggestResourcesApi', async () => {
    suggestResourcesApiMock.mockRejectedValueOnce(new Error('network exploded'));
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://github.com/x' });
    const result = await tryUrlResolvesVerify(item);
    expect(result?.verdict).toBe('unverifiable');
    expect(result?.reasoning).toContain('failed to enqueue ingest');
    expect(result?.reasoning).toContain('network exploded');
  });
});

// ── End-to-end VerifyResult shape ───────────────────────────────────

describe('VerifyResult shape', () => {
  it('populates all required fields on confirmed', async () => {
    getCitationContentByUrlMock.mockResolvedValueOnce(
      citationContent({ httpStatus: 200, pageTitle: 'Anthropic - Wikipedia' }) as never,
    );
    const item = makeFactItem();
    const result = await tryUrlResolvesVerify(item);
    expect(result).toMatchObject({
      itemId: 'fact:f_url_001',
      kind: 'fact',
      verdict: 'confirmed',
      checkerModel: 'url-resolves',
      sourceUrl: 'https://en.wikipedia.org/wiki/Anthropic',
    });
    expect(result?.confidence).toBeGreaterThan(0);
  });

  it('falls back to checked URL when sourceUrl is unset on the item', async () => {
    lookupResourceByUrlMock.mockResolvedValueOnce(resourceRow({ fetchStatus: 'dead' }) as never);
    const item = makeFactItem({ propertyId: 'github-profile', rawValue: 'https://example.com' });
    item.sourceUrl = undefined;
    const result = await tryUrlResolvesVerify(item);
    expect(result?.sourceUrl).toBe('https://example.com');
  });
});

// ── titleContainsEntityName helper ──────────────────────────────────

describe('titleContainsEntityName', () => {
  it('matches a plain whole-word containment, case insensitive', () => {
    expect(titleContainsEntityName('Anthropic', 'Anthropic')).toBe(true);
    expect(titleContainsEntityName('anthropic', 'ANTHROPIC')).toBe(true);
  });

  it('does NOT match a substring across word boundary (Foo vs Foobar)', () => {
    expect(titleContainsEntityName('Foobar Inc', 'Foo')).toBe(false);
  });

  it('handles minor punctuation differences via permissive normalization', () => {
    expect(titleContainsEntityName('U.S. Department of State', 'U S Department')).toBe(true);
  });

  it('handles diacritics and special characters', () => {
    expect(titleContainsEntityName('Citroën S.A.', 'Citroën')).toBe(true);
    expect(titleContainsEntityName('São Paulo', 'São Paulo')).toBe(true);
  });

  it('returns false when entity name is empty after normalization', () => {
    expect(titleContainsEntityName('Anything', '!!!')).toBe(false);
  });

  it('returns false on empty title', () => {
    expect(titleContainsEntityName('', 'Anthropic')).toBe(false);
  });
});

// ── resolveFromResourcePipeline directly ──────────────────────────

describe('resolveFromResourcePipeline (direct)', () => {
  it('queries both endpoints in parallel', async () => {
    getCitationContentByUrlMock.mockResolvedValueOnce(citationContent({ httpStatus: 200 }) as never);
    await resolveFromResourcePipeline('https://example.com', false, 'X');
    expect(getCitationContentByUrlMock).toHaveBeenCalledWith('https://example.com');
    expect(lookupResourceByUrlMock).toHaveBeenCalledWith('https://example.com');
  });

  it('citation_content takes precedence over resource fetchStatus', async () => {
    // citation says ok, resource says dead — citation wins (newer info).
    getCitationContentByUrlMock.mockResolvedValueOnce(citationContent({ httpStatus: 200 }) as never);
    lookupResourceByUrlMock.mockResolvedValueOnce(resourceRow({ fetchStatus: 'dead' }) as never);
    const result = await resolveFromResourcePipeline('https://example.com', false, 'X');
    expect(result.verdict).toBe('confirmed');
  });
});
