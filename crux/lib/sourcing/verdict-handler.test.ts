/**
 * Tests for verdict-handler.ts
 *
 * verdict-handler wraps the wiki-server RPC calls for storing evidence and
 * aggregate verdicts. Tests verify:
 * 1. Successful evidence storage — correct body construction, field truncation
 * 2. Successful verdict storage — correct body construction
 * 3. Resource ID resolution — looked up from URL when not supplied
 * 4. Error handling — warnings logged AND errors thrown on API failure
 *    (changed from silent .resolves in #4017 to surface lost primary-data writes)
 * 5. Edge cases — null/empty fields, optional fields, custom logPrefix
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock wiki-server dependencies before importing the module under test
vi.mock('../wiki-server/sourcing-client.ts', () => ({
  storeEvidence: vi.fn(),
  storeVerdict: vi.fn(),
}));

vi.mock('../wiki-server/resources.ts', () => ({
  lookupResourceByUrl: vi.fn(),
}));

vi.mock('../llm.ts', () => ({
  MODELS: { haiku: 'claude-haiku-test' },
}));

import { storeSourcingEvidence, storeAggregateVerdict } from './verdict-handler.ts';
import { storeEvidence, storeVerdict } from '../wiki-server/sourcing-client.ts';
import { lookupResourceByUrl } from '../wiki-server/resources.ts';

const mockStoreEvidence = vi.mocked(storeEvidence);
const mockStoreVerdict = vi.mocked(storeVerdict);
const mockLookupResourceByUrl = vi.mocked(lookupResourceByUrl);

beforeEach(() => {
  vi.clearAllMocks();
  mockStoreEvidence.mockResolvedValue({ ok: true, data: { id: 'ev-1' } as any });
  mockStoreVerdict.mockResolvedValue({ ok: true, data: { id: 'v-1' } as any });
  mockLookupResourceByUrl.mockResolvedValue({ ok: true, data: { id: 'res-42' } as any });
});

// ---------------------------------------------------------------------------
// storeSourcingEvidence
// ---------------------------------------------------------------------------

describe('storeSourcingEvidence', () => {
  it('calls storeEvidence with the correct body shape', async () => {
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-123',
      sourceUrl: 'https://example.com/source',
      verdict: 'supported',
      confidence: 0.9,
      extractedValue: '$500,000',
      reasoning: 'Found exact match in table.',
    });

    expect(mockStoreEvidence).toHaveBeenCalledOnce();
    const body = mockStoreEvidence.mock.calls[0][0];
    expect(body.recordType).toBe('grant');
    expect(body.recordId).toBe('grant-123');
    expect(body.sourceUrl).toBe('https://example.com/source');
    expect(body.verdict).toBe('supported');
    expect(body.confidence).toBe(0.9);
    expect(body.extractedValue).toBe('$500,000');
    expect(body.notes).toBe('Found exact match in table.');
  });

  it('uses the default haiku model when checkerModel is not supplied', async () => {
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-1',
      sourceUrl: 'https://example.com',
      verdict: 'supported',
      confidence: 0.8,
      extractedValue: '',
      reasoning: '',
    });

    const body = mockStoreEvidence.mock.calls[0][0];
    expect(body.checkerModel).toBe('claude-haiku-test');
  });

  it('uses a custom checkerModel when supplied', async () => {
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-1',
      sourceUrl: 'https://example.com',
      verdict: 'supported',
      confidence: 0.9,
      extractedValue: '',
      reasoning: '',
      checkerModel: 'deterministic-row-match',
    });

    const body = mockStoreEvidence.mock.calls[0][0];
    expect(body.checkerModel).toBe('deterministic-row-match');
  });

  it('resolves resourceId from URL when not supplied', async () => {
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-1',
      sourceUrl: 'https://example.com/resource',
      verdict: 'supported',
      confidence: 0.9,
      extractedValue: '',
      reasoning: '',
    });

    expect(mockLookupResourceByUrl).toHaveBeenCalledWith('https://example.com/resource');
    const body = mockStoreEvidence.mock.calls[0][0];
    expect(body.resourceId).toBe('res-42');
  });

  it('uses supplied resourceId without calling lookupResourceByUrl', async () => {
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-1',
      sourceUrl: 'https://example.com/resource',
      verdict: 'supported',
      confidence: 0.9,
      extractedValue: '',
      reasoning: '',
      resourceId: 'preresolved-id',
    });

    expect(mockLookupResourceByUrl).not.toHaveBeenCalled();
    const body = mockStoreEvidence.mock.calls[0][0];
    expect(body.resourceId).toBe('preresolved-id');
  });

  it('sets resourceId to null AND logs warning when lookup fails (issue #4017)', async () => {
    mockLookupResourceByUrl.mockRejectedValueOnce(new Error('network error'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-1',
      sourceUrl: 'https://example.com',
      verdict: 'supported',
      confidence: 0.8,
      extractedValue: '',
      reasoning: '',
    });

    const body = mockStoreEvidence.mock.calls[0][0];
    expect(body.resourceId).toBeNull();

    // The lookup failure used to be a silent `catch {}` — now it warns so the
    // operator can see why evidence rows have NULL resourceId.
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('Resource lookup failed');
    expect(warnSpy.mock.calls[0][0]).toContain('NULL resourceId');
    warnSpy.mockRestore();
  });

  it('truncates extractedValue to 2000 chars', async () => {
    const longValue = 'x'.repeat(3000);
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-1',
      sourceUrl: 'https://example.com',
      verdict: 'supported',
      confidence: 0.9,
      extractedValue: longValue,
      reasoning: '',
    });

    const body = mockStoreEvidence.mock.calls[0][0];
    expect((body.extractedValue as string).length).toBe(2000);
  });

  it('truncates reasoning (notes) to 5000 chars', async () => {
    const longReasoning = 'y'.repeat(6000);
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-1',
      sourceUrl: 'https://example.com',
      verdict: 'supported',
      confidence: 0.9,
      extractedValue: '',
      reasoning: longReasoning,
    });

    const body = mockStoreEvidence.mock.calls[0][0];
    expect((body.notes as string).length).toBe(5000);
  });

  it('truncates recordId to 500 chars', async () => {
    const longId = 'z'.repeat(600);
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: longId,
      sourceUrl: 'https://example.com',
      verdict: 'supported',
      confidence: 0.9,
      extractedValue: '',
      reasoning: '',
    });

    const body = mockStoreEvidence.mock.calls[0][0];
    expect((body.recordId as string).length).toBe(500);
  });

  // Issue #4017 — primary-data writes must surface failures.
  it('throws AND warns when storeEvidence returns not-ok (issue #4017)', async () => {
    mockStoreEvidence.mockResolvedValueOnce({ ok: false, error: 'server_error', message: 'server error' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      storeSourcingEvidence({
        recordType: 'grant',
        recordId: 'grant-1',
        sourceUrl: 'https://example.com',
        verdict: 'supported',
        confidence: 0.9,
        extractedValue: '',
        reasoning: '',
      }),
    ).rejects.toThrow(/grant\/grant-1/);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('grant/grant-1');
    warnSpy.mockRestore();
  });

  it('uses custom logPrefix in warning messages', async () => {
    mockStoreEvidence.mockResolvedValueOnce({ ok: false, error: 'server_error', message: 'oops' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Catches the throw to keep the test focused on the warning text.
    await expect(
      storeSourcingEvidence(
        {
          recordType: 'personnel',
          recordId: 'p-1',
          sourceUrl: '',
          verdict: 'inconclusive',
          confidence: 0.4,
          extractedValue: '',
          reasoning: '',
        },
        '[custom-prefix]',
      ),
    ).rejects.toThrow();

    expect(warnSpy.mock.calls[0][0]).toContain('[custom-prefix]');
    warnSpy.mockRestore();
  });

  it('includes entityId in body when supplied', async () => {
    await storeSourcingEvidence({
      recordType: 'personnel',
      recordId: 'p-1',
      sourceUrl: 'https://example.com',
      verdict: 'supported',
      confidence: 0.9,
      extractedValue: '',
      reasoning: '',
      entityId: 'org-entity-sid',
    });

    const body = mockStoreEvidence.mock.calls[0][0];
    expect(body.entityId).toBe('org-entity-sid');
  });

  it('omits entityId from body when not supplied', async () => {
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-1',
      sourceUrl: 'https://example.com',
      verdict: 'supported',
      confidence: 0.9,
      extractedValue: '',
      reasoning: '',
    });

    const body = mockStoreEvidence.mock.calls[0][0];
    expect(body).not.toHaveProperty('entityId');
  });

  it('sets sourceUrl to null when empty string supplied', async () => {
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-1',
      sourceUrl: '',
      verdict: 'supported',
      confidence: 0.8,
      extractedValue: '',
      reasoning: '',
    });

    const body = mockStoreEvidence.mock.calls[0][0];
    expect(body.sourceUrl).toBeNull();
  });

  it('includes isPrimarySource when supplied', async () => {
    await storeSourcingEvidence({
      recordType: 'grant',
      recordId: 'grant-1',
      sourceUrl: 'https://example.com',
      verdict: 'supported',
      confidence: 0.9,
      extractedValue: '',
      reasoning: '',
      isPrimarySource: true,
    });

    const body = mockStoreEvidence.mock.calls[0][0];
    expect(body.isPrimarySource).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// storeAggregateVerdict
// ---------------------------------------------------------------------------

describe('storeAggregateVerdict', () => {
  it('calls storeVerdict with the correct body shape', async () => {
    await storeAggregateVerdict({
      recordType: 'grant',
      recordId: 'grant-123',
      verdict: 'supported',
      confidence: 0.9,
      reasoning: 'Two sources confirm.',
      sourcesChecked: 3,
    });

    expect(mockStoreVerdict).toHaveBeenCalledOnce();
    const body = mockStoreVerdict.mock.calls[0][0];
    expect(body.recordType).toBe('grant');
    expect(body.recordId).toBe('grant-123');
    expect(body.verdict).toBe('supported');
    expect(body.confidence).toBe(0.9);
    expect(body.reasoning).toBe('Two sources confirm.');
    expect(body.sourcesChecked).toBe(3);
  });

  it('includes entityId when supplied', async () => {
    await storeAggregateVerdict({
      recordType: 'personnel',
      recordId: 'p-1',
      verdict: 'inconclusive',
      confidence: 0.5,
      reasoning: 'No source found.',
      sourcesChecked: 1,
      entityId: 'sid_orgabc',
    });

    const body = mockStoreVerdict.mock.calls[0][0];
    expect(body.entityId).toBe('sid_orgabc');
  });

  it('omits entityId from body when not supplied', async () => {
    await storeAggregateVerdict({
      recordType: 'grant',
      recordId: 'grant-1',
      verdict: 'supported',
      confidence: 0.9,
      reasoning: '',
      sourcesChecked: 2,
    });

    const body = mockStoreVerdict.mock.calls[0][0];
    expect(body).not.toHaveProperty('entityId');
  });

  it('includes displayName and entityDisplayName when supplied', async () => {
    await storeAggregateVerdict({
      recordType: 'grant',
      recordId: 'grant-1',
      verdict: 'supported',
      confidence: 0.9,
      reasoning: '',
      sourcesChecked: 1,
      displayName: 'AI Safety Grant 2024',
      entityDisplayName: 'Open Philanthropy',
    });

    const body = mockStoreVerdict.mock.calls[0][0];
    expect(body.displayName).toBe('AI Safety Grant 2024');
    expect(body.entityDisplayName).toBe('Open Philanthropy');
  });

  it('omits displayName/entityDisplayName when not supplied', async () => {
    await storeAggregateVerdict({
      recordType: 'grant',
      recordId: 'grant-1',
      verdict: 'supported',
      confidence: 0.9,
      reasoning: '',
      sourcesChecked: 1,
    });

    const body = mockStoreVerdict.mock.calls[0][0];
    expect(body).not.toHaveProperty('displayName');
    expect(body).not.toHaveProperty('entityDisplayName');
  });

  // Issue #4017 — primary-data writes must surface failures.
  it('throws AND warns when storeVerdict returns not-ok (issue #4017)', async () => {
    mockStoreVerdict.mockResolvedValueOnce({ ok: false, error: 'server_error', message: 'server error' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      storeAggregateVerdict({
        recordType: 'grant',
        recordId: 'grant-1',
        verdict: 'supported',
        confidence: 0.9,
        reasoning: '',
        sourcesChecked: 1,
      }),
    ).rejects.toThrow(/grant\/grant-1/);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('grant/grant-1');
    warnSpy.mockRestore();
  });

  it('uses custom logPrefix in warning messages', async () => {
    mockStoreVerdict.mockResolvedValueOnce({ ok: false, error: 'server_error', message: 'oops' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      storeAggregateVerdict(
        {
          recordType: 'personnel',
          recordId: 'p-1',
          verdict: 'contradicted',
          confidence: 0.2,
          reasoning: '',
          sourcesChecked: 1,
        },
        '[factbase-check]',
      ),
    ).rejects.toThrow();

    expect(warnSpy.mock.calls[0][0]).toContain('[factbase-check]');
    warnSpy.mockRestore();
  });
});
