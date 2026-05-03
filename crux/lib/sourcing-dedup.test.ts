import { describe, it, expect } from 'vitest';
import {
  CURRENT_CHECKER_MODEL,
  isStaleModel,
} from '@wiki-server/checker-model';

/**
 * Tests for sourcing evidence deduplication and stale model detection.
 *
 * QUA-991: previously this file inlined a copy of `isStaleModel` and
 * `CURRENT_CHECKER_MODEL`. Both are now exported from
 * `apps/wiki-server/src/routes/sourcing/checker-model.ts` and consumed
 * directly here so the constant cannot drift.
 */

describe('isStaleModel', () => {
  it('returns true for null checker model', () => {
    expect(isStaleModel(null)).toBe(true);
  });

  it('returns true for empty string', () => {
    expect(isStaleModel('')).toBe(true);
  });

  it('returns true for old model (claude-3-haiku)', () => {
    expect(isStaleModel('claude-3-haiku')).toBe(true);
  });

  it('returns true for old model (claude-3-5-haiku-20241022)', () => {
    expect(isStaleModel('claude-3-5-haiku-20241022')).toBe(true);
  });

  it('returns false for current model', () => {
    expect(isStaleModel(CURRENT_CHECKER_MODEL)).toBe(false);
  });

  it('returns true for unknown/future model', () => {
    expect(isStaleModel('some-future-model-2027')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mapEvidenceRow (isStale computation)
// ---------------------------------------------------------------------------

function mapEvidenceRow(e: {
  id: number;
  recordType: string;
  recordId: string;
  checkerModel: string | null;
  sourceUrl: string | null;
  confidence: number | null;
  verdict: string;
}) {
  return {
    ...e,
    isStale: isStaleModel(e.checkerModel),
  };
}

describe('mapEvidenceRow', () => {
  const base = {
    id: 1,
    recordType: 'fact',
    recordId: 'f_abc123',
    sourceUrl: 'https://example.com',
    confidence: 0.95,
    verdict: 'confirmed',
  };

  it('marks current model evidence as not stale', () => {
    const row = mapEvidenceRow({ ...base, checkerModel: CURRENT_CHECKER_MODEL });
    expect(row.isStale).toBe(false);
  });

  it('marks old model evidence as stale', () => {
    const row = mapEvidenceRow({ ...base, checkerModel: 'claude-3-haiku' });
    expect(row.isStale).toBe(true);
  });

  it('marks null model evidence as stale', () => {
    const row = mapEvidenceRow({ ...base, checkerModel: null });
    expect(row.isStale).toBe(true);
  });

  it('preserves all fields from the input row', () => {
    const row = mapEvidenceRow({ ...base, checkerModel: CURRENT_CHECKER_MODEL });
    expect(row.id).toBe(1);
    expect(row.recordType).toBe('fact');
    expect(row.recordId).toBe('f_abc123');
    expect(row.verdict).toBe('confirmed');
    expect(row.confidence).toBe(0.95);
    expect(row.sourceUrl).toBe('https://example.com');
  });

  it('handles evidence with null confidence', () => {
    const row = mapEvidenceRow({ ...base, confidence: null, checkerModel: CURRENT_CHECKER_MODEL });
    expect(row.confidence).toBeNull();
    expect(row.isStale).toBe(false);
  });

  it('handles evidence with null sourceUrl', () => {
    const row = mapEvidenceRow({ ...base, sourceUrl: null, checkerModel: CURRENT_CHECKER_MODEL });
    expect(row.sourceUrl).toBeNull();
    expect(row.isStale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dedup key uniqueness
// ---------------------------------------------------------------------------

/**
 * The dedup key for source_check_evidence is:
 *   (record_type, record_id, COALESCE(source_url, ''), COALESCE(checker_model, ''))
 *
 * This mirrors the unique index idx_sce_dedup defined in migration 0135.
 */
function dedupKey(row: {
  recordType: string;
  recordId: string;
  sourceUrl: string | null;
  checkerModel: string | null;
}): string {
  return `${row.recordType}|${row.recordId}|${row.sourceUrl ?? ''}|${row.checkerModel ?? ''}`;
}

describe('dedup key uniqueness', () => {
  it('same record+url+model gives same key', () => {
    const key1 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: 'https://a.com', checkerModel: 'haiku' });
    const key2 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: 'https://a.com', checkerModel: 'haiku' });
    expect(key1).toBe(key2);
  });

  it('different sourceUrl gives different key', () => {
    const key1 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: 'https://a.com', checkerModel: 'haiku' });
    const key2 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: 'https://b.com', checkerModel: 'haiku' });
    expect(key1).not.toBe(key2);
  });

  it('different checkerModel gives different key', () => {
    const key1 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: 'https://a.com', checkerModel: 'haiku' });
    const key2 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: 'https://a.com', checkerModel: 'sonnet' });
    expect(key1).not.toBe(key2);
  });

  it('null sourceUrl produces consistent key', () => {
    const key1 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: null, checkerModel: 'haiku' });
    const key2 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: null, checkerModel: 'haiku' });
    expect(key1).toBe(key2);
  });

  it('null checkerModel produces consistent key', () => {
    const key1 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: 'https://a.com', checkerModel: null });
    const key2 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: 'https://a.com', checkerModel: null });
    expect(key1).toBe(key2);
  });

  it('different recordType gives different key', () => {
    const key1 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: 'https://a.com', checkerModel: 'haiku' });
    const key2 = dedupKey({ recordType: 'personnel', recordId: 'f1', sourceUrl: 'https://a.com', checkerModel: 'haiku' });
    expect(key1).not.toBe(key2);
  });

  it('different recordId gives different key', () => {
    const key1 = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: 'https://a.com', checkerModel: 'haiku' });
    const key2 = dedupKey({ recordType: 'fact', recordId: 'f2', sourceUrl: 'https://a.com', checkerModel: 'haiku' });
    expect(key1).not.toBe(key2);
  });

  it('handles very long URLs', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2000);
    const key = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: longUrl, checkerModel: 'haiku' });
    expect(key.length).toBeGreaterThan(2000);
  });

  it('handles all-null optional fields', () => {
    const key = dedupKey({ recordType: 'fact', recordId: 'f1', sourceUrl: null, checkerModel: null });
    expect(key).toBe('fact|f1||');
  });
});

// ---------------------------------------------------------------------------
// groupBySourceUrl
// ---------------------------------------------------------------------------

interface EvidenceRow {
  id: number;
  sourceUrl: string | null;
  verdict: string;
  checkerModel: string | null;
  isStale: boolean;
}

function groupBySourceUrl(evidence: EvidenceRow[]): Map<string, EvidenceRow[]> {
  const groups = new Map<string, EvidenceRow[]>();
  for (const e of evidence) {
    const key = e.sourceUrl || '(no source URL)';
    const existing = groups.get(key);
    if (existing) {
      existing.push(e);
    } else {
      groups.set(key, [e]);
    }
  }
  return groups;
}

function makeEvidence(overrides: Partial<EvidenceRow> & { id: number }): EvidenceRow {
  return {
    sourceUrl: null,
    verdict: 'confirmed',
    checkerModel: CURRENT_CHECKER_MODEL,
    isStale: false,
    ...overrides,
  };
}

describe('groupBySourceUrl', () => {
  it('groups evidence by source URL', () => {
    const evidence = [
      makeEvidence({ id: 1, sourceUrl: 'https://a.com' }),
      makeEvidence({ id: 2, sourceUrl: 'https://b.com' }),
      makeEvidence({ id: 3, sourceUrl: 'https://a.com' }),
    ];

    const groups = groupBySourceUrl(evidence);
    expect(groups.size).toBe(2);
    expect(groups.get('https://a.com')!.length).toBe(2);
    expect(groups.get('https://b.com')!.length).toBe(1);
  });

  it('groups null sourceUrl under "(no source URL)"', () => {
    const evidence = [
      makeEvidence({ id: 1, sourceUrl: null }),
      makeEvidence({ id: 2, sourceUrl: null }),
    ];

    const groups = groupBySourceUrl(evidence);
    expect(groups.size).toBe(1);
    expect(groups.has('(no source URL)')).toBe(true);
    expect(groups.get('(no source URL)')!.length).toBe(2);
  });

  it('handles empty evidence array', () => {
    const groups = groupBySourceUrl([]);
    expect(groups.size).toBe(0);
  });

  it('handles single evidence row', () => {
    const evidence = [makeEvidence({ id: 1, sourceUrl: 'https://x.com' })];
    const groups = groupBySourceUrl(evidence);
    expect(groups.size).toBe(1);
    expect(groups.get('https://x.com')!.length).toBe(1);
  });

  it('handles mix of null and non-null URLs', () => {
    const evidence = [
      makeEvidence({ id: 1, sourceUrl: 'https://a.com' }),
      makeEvidence({ id: 2, sourceUrl: null }),
      makeEvidence({ id: 3, sourceUrl: 'https://a.com' }),
      makeEvidence({ id: 4, sourceUrl: null }),
      makeEvidence({ id: 5, sourceUrl: 'https://b.com' }),
    ];

    const groups = groupBySourceUrl(evidence);
    expect(groups.size).toBe(3);
    expect(groups.get('https://a.com')!.length).toBe(2);
    expect(groups.get('(no source URL)')!.length).toBe(2);
    expect(groups.get('https://b.com')!.length).toBe(1);
  });

  it('preserves order within groups', () => {
    const evidence = [
      makeEvidence({ id: 1, sourceUrl: 'https://a.com', verdict: 'confirmed' }),
      makeEvidence({ id: 2, sourceUrl: 'https://a.com', verdict: 'contradicted' }),
      makeEvidence({ id: 3, sourceUrl: 'https://a.com', verdict: 'outdated' }),
    ];

    const groups = groupBySourceUrl(evidence);
    const items = groups.get('https://a.com')!;
    expect(items[0].id).toBe(1);
    expect(items[1].id).toBe(2);
    expect(items[2].id).toBe(3);
  });

  it('treats different URL paths as different groups', () => {
    const evidence = [
      makeEvidence({ id: 1, sourceUrl: 'https://example.com/page1' }),
      makeEvidence({ id: 2, sourceUrl: 'https://example.com/page2' }),
    ];

    const groups = groupBySourceUrl(evidence);
    expect(groups.size).toBe(2);
  });

  it('handles empty string sourceUrl as "(no source URL)"', () => {
    const evidence = [makeEvidence({ id: 1, sourceUrl: '' })];
    const groups = groupBySourceUrl(evidence);
    expect(groups.has('(no source URL)')).toBe(true);
  });
});
