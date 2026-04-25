import { describe, it, expect } from 'vitest';
import { parseDenominatorDoc } from '../parse-denominators.ts';

describe('parseDenominatorDoc', () => {
  it('parses a ranked denominator table', () => {
    const doc = `
| Rank | Slug      | Record type  | Estimated total | Confidence | Basis                 |
|------|-----------|--------------|-----------------|------------|-----------------------|
| 1    | anthropic | personnel    | 1000            | high       | Public statements 2025 |
| 1    | anthropic | publications | 200             | medium     | Research page + blog  |
| 1    | anthropic | divisions    | 15              | medium     | 6 known clusters      |
`;
    const out = parseDenominatorDoc(doc);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      entityId: 'anthropic',
      recordType: 'personnel',
      estimatedTotal: 1000,
      confidence: 'high',
      basis: 'Public statements 2025',
    });
    expect(out[2].recordType).toBe('divisions');
    expect(out[2].estimatedTotal).toBe(15);
  });

  it('skips header + separator rows', () => {
    const doc = `
| Rank | Slug | Record type | Estimated total |
|------|------|-------------|-----------------|
| 1    | acme | personnel   | 50              |
`;
    const out = parseDenominatorDoc(doc);
    expect(out).toEqual([
      { entityId: 'acme', recordType: 'personnel', estimatedTotal: 50 },
    ]);
  });

  it('ignores prose lines and non-pipe content', () => {
    const doc = `
This is not a table row and should be ignored.

Some markdown text with | pipes | but no leading |.

| 1 | acme | personnel | 50 | high | why |
`;
    const out = parseDenominatorDoc(doc);
    expect(out).toHaveLength(1);
    expect(out[0].entityId).toBe('acme');
  });

  it('canonicalizes "publication" (singular) to "publications"', () => {
    const doc = `| 1 | acme | publication | 10 |`;
    const out = parseDenominatorDoc(doc);
    expect(out[0].recordType).toBe('publications');
  });

  it('rejects unknown record types', () => {
    const doc = `| 1 | acme | widgets | 10 |`;
    expect(parseDenominatorDoc(doc)).toEqual([]);
  });

  it('rejects non-integer estimates', () => {
    const doc = `| 1 | acme | personnel | n/a |`;
    expect(parseDenominatorDoc(doc)).toEqual([]);
  });

  it('strips commas from large numbers', () => {
    const doc = `| 1 | acme | personnel | 1,250 |`;
    const out = parseDenominatorDoc(doc);
    expect(out[0].estimatedTotal).toBe(1250);
  });

  it('deduplicates repeated (slug, record_type) pairs', () => {
    const doc = `
| 1 | acme | personnel | 100 |
| 1 | acme | personnel | 200 |
`;
    const out = parseDenominatorDoc(doc);
    expect(out).toHaveLength(1);
    expect(out[0].estimatedTotal).toBe(100); // first wins
  });

  it('accepts tables without a rank column', () => {
    const doc = `
| Slug | Record type | Estimated total |
|------|-------------|-----------------|
| acme | personnel   | 50              |
`;
    const out = parseDenominatorDoc(doc);
    expect(out).toEqual([
      { entityId: 'acme', recordType: 'personnel', estimatedTotal: 50 },
    ]);
  });

  it('only accepts kebab-case slugs', () => {
    const doc = `| 1 | UPPERCASE | personnel | 50 |`;
    expect(parseDenominatorDoc(doc)).toEqual([]);
  });

  it('preserves multi-hyphen slugs like open-philanthropy', () => {
    const doc = `| 1 | open-philanthropy | personnel | 120 | high | team page |`;
    const out = parseDenominatorDoc(doc);
    expect(out[0].entityId).toBe('open-philanthropy');
  });

  it('omits confidence when not one of {high, medium, low}', () => {
    const doc = `| 1 | acme | personnel | 50 | guesswork | notes |`;
    const out = parseDenominatorDoc(doc);
    expect(out[0]).toEqual({
      entityId: 'acme',
      recordType: 'personnel',
      estimatedTotal: 50,
      basis: 'notes',
    });
    expect(out[0].confidence).toBeUndefined();
  });
});
