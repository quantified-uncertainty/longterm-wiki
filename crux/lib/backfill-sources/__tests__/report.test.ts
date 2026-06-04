import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  splitProviders,
  openOutcomeJsonl,
  appendOutcomeJsonl,
  closeOutcomeJsonl,
} from '../report.ts';
import type { CostBreakdown, RecordOutcome } from '../types.ts';

const ZERO_COST: CostBreakdown = {
  searchCost: 0,
  factExtractionCost: 0,
  quoteExtractCost: 0,
  entailmentCost: 0,
  rankCost: 0,
};

function rec(id: string): RecordOutcome['record'] {
  return {
    record_id: id,
    record_table: 'facts',
    entity_id: 'sid_x',
    entity_name: 'Acme',
    description: `desc ${id}`,
  };
}

// A candidate carrying a chunky payload — the kind of thing that, accumulated
// across hundreds of records, OOM'd the old bulk-JSON writer.
function bigCandidate(url: string) {
  return {
    url,
    decision: 'rejected' as const,
    rejection_reason: 'no support',
    content_sha256: null,
    content_chars: 5000,
    quote_extraction: null,
    entailment: null,
  };
}

describe('splitProviders', () => {
  it('splits a multi-provider tag into a sorted array', () => {
    expect(splitProviders('exa+perplexity')).toEqual(['exa', 'perplexity']);
    expect(splitProviders('perplexity+exa+scry')).toEqual(['exa', 'perplexity', 'scry']);
  });

  it('wraps a single provider as a 1-element array', () => {
    expect(splitProviders('exa')).toEqual(['exa']);
    expect(splitProviders('self-sourced')).toEqual(['self-sourced']);
  });

  it('returns [] for null / undefined / empty', () => {
    expect(splitProviders(null)).toEqual([]);
    expect(splitProviders(undefined)).toEqual([]);
    expect(splitProviders('')).toEqual([]);
  });

  it('trims and dedupes entries', () => {
    expect(splitProviders(' exa + exa ')).toEqual(['exa']);
    expect(splitProviders('exa++perplexity')).toEqual(['exa', 'perplexity']);
  });
});

describe('streaming JSONL outcome file', () => {
  it('writes meta + one line per record + summary, preserving candidates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bf-jsonl-'));
    const path = join(dir, 'out.jsonl');
    try {
      expect(openOutcomeJsonl(path, 'apply')).toBe(true);

      appendOutcomeJsonl(path, {
        record: rec('1'),
        outcome: {
          kind: 'matched',
          url: 'https://example.com/a',
          provider: 'exa+perplexity',
          quotes: ['q1'],
          cost: ZERO_COST,
          candidates: [bigCandidate('https://example.com/a')],
        },
      });
      appendOutcomeJsonl(path, {
        record: rec('2'),
        outcome: {
          kind: 'no-match',
          reason: 'no support',
          cost: ZERO_COST,
          candidates: [bigCandidate('https://example.com/b')],
        },
      });
      appendOutcomeJsonl(path, {
        record: rec('3'),
        outcome: { kind: 'skipped', reason: 'no search terms' },
      });

      const status = closeOutcomeJsonl(path, {
        records: 3, searched: 2, matched: 1, unmatched: 1, skipped: 1,
      });
      expect(status).toContain('1 matched');
      expect(status).toContain('1 no-match');

      const lines = readFileSync(path, 'utf-8').trim().split('\n');
      const parsed = lines.map((l) => JSON.parse(l));

      // meta header, 3 record lines, summary trailer
      expect(parsed[0]).toMatchObject({ type: 'meta', mode: 'apply' });
      expect(parsed[1]).toMatchObject({ outcome: 'matched', record_id: '1', url: 'https://example.com/a' });
      expect(parsed[1].providers).toEqual(['exa', 'perplexity']);
      // the heavy candidate payload IS preserved in the file
      expect(parsed[1].candidates[0].url).toBe('https://example.com/a');
      expect(parsed[2]).toMatchObject({ outcome: 'no-match', record_id: '2', reason: 'no support' });
      expect(parsed[3]).toMatchObject({ outcome: 'skipped', record_id: '3' });
      expect(parsed[4]).toMatchObject({ type: 'summary', totals: { matched: 1, unmatched: 1, skipped: 1 } });
      expect(lines.length).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when the target dir is not writable (run still proceeds)', () => {
    // Put a regular file where a parent directory is expected: mkdir of a path
    // *under* a file fails fast with ENOTDIR, exercising the guard. (Don't use
    // /proc — Node's recursive mkdirSync blocks indefinitely there.)
    const dir = mkdtempSync(join(tmpdir(), 'bf-jsonl-'));
    try {
      const blocker = join(dir, 'not-a-dir');
      writeFileSync(blocker, 'x');
      expect(openOutcomeJsonl(join(blocker, 'out.jsonl'), 'dry-run')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
