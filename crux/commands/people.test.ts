import { describe, it, expect } from 'vitest';
import { normalizeName, buildAuthorLookup, matchAuthor } from './people.ts';

describe('normalizeName', () => {
  it('lowercases and trims', () => {
    expect(normalizeName('  Geoffrey Hinton  ')).toBe('geoffrey hinton');
  });

  it('strips diacritics', () => {
    expect(normalizeName('José García')).toBe('jose garcia');
    expect(normalizeName('François Chollet')).toBe('francois chollet');
    expect(normalizeName('Jürgen Schmidhuber')).toBe('jurgen schmidhuber');
  });

  it('handles empty string', () => {
    expect(normalizeName('')).toBe('');
  });

  it('handles names with hyphens', () => {
    expect(normalizeName('Sam Bankman-Fried')).toBe('sam bankman-fried');
  });
});

describe('buildAuthorLookup', () => {
  it('indexes clean names without parentheticals', () => {
    const people = [
      { id: 'sbf', title: 'Sam Bankman-Fried (FTX)' },
      { id: 'hinton', title: 'Geoffrey Hinton' },
    ];
    const lookup = buildAuthorLookup(people);

    expect(lookup.get('sam bankman-fried')).toBe('sbf');
    expect(lookup.get('geoffrey hinton')).toBe('hinton');
  });

  it('does not index the noisy title with parenthetical', () => {
    const people = [{ id: 'sbf', title: 'Sam Bankman-Fried (FTX)' }];
    const lookup = buildAuthorLookup(people);

    // The noisy form should NOT be indexed
    expect(lookup.get('sam bankman-fried (ftx)')).toBeUndefined();
  });

  it('includes manual aliases', () => {
    const people = [{ id: 'gwern', title: 'Gwern Branwen' }];
    const lookup = buildAuthorLookup(people);

    expect(lookup.get('gwern branwen')).toBe('gwern');
    expect(lookup.get('gwern')).toBe('gwern');
  });
});

describe('matchAuthor', () => {
  const people = [
    { id: 'hinton', title: 'Geoffrey Hinton' },
    { id: 'bengio', title: 'Yoshua Bengio' },
    { id: 'nuno-sempere', title: 'Nuño Sempere' },
  ];
  const lookup = buildAuthorLookup(people);

  it('matches exact names', () => {
    expect(matchAuthor('Geoffrey Hinton', lookup)).toBe('hinton');
    expect(matchAuthor('Yoshua Bengio', lookup)).toBe('bengio');
  });

  it('matches despite diacritics in entity title', () => {
    // "Nuño Sempere" in entities should match "Nuno Sempere" in literature
    expect(matchAuthor('Nuno Sempere', lookup)).toBe('nuno-sempere');
  });

  it('filters out "et al." authors', () => {
    expect(matchAuthor('et al.', lookup)).toBeNull();
    expect(matchAuthor('Hinton et al.', lookup)).toBeNull();
  });

  it('filters out team authors', () => {
    expect(matchAuthor('DeepMind Team', lookup)).toBeNull();
    expect(matchAuthor('OpenAI Safety Team', lookup)).toBeNull();
  });

  it('returns null for unknown authors', () => {
    expect(matchAuthor('Unknown Person', lookup)).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(matchAuthor('geoffrey hinton', lookup)).toBe('hinton');
    expect(matchAuthor('GEOFFREY HINTON', lookup)).toBe('hinton');
  });
});
