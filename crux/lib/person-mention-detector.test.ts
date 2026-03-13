import { describe, it, expect } from 'vitest';
import {
  buildPersonLookup,
  detectPersonMentions,
  findExcludedZones,
  applyEntityLinks,
  buildPositionMap,
  type PersonEntity,
} from './person-mention-detector.ts';

const samplePeople: PersonEntity[] = [
  { id: 'dario-amodei', numericId: 'E91', title: 'Dario Amodei' },
  { id: 'geoffrey-hinton', numericId: 'E149', title: 'Geoffrey Hinton' },
  { id: 'nuno-sempere', numericId: 'E207', title: 'Nuño Sempere' },
  { id: 'sam-altman', numericId: 'E269', title: 'Sam Altman' },
  { id: 'eliezer-yudkowsky', numericId: 'E132', title: 'Eliezer Yudkowsky' },
];

describe('buildPersonLookup', () => {
  it('maps normalized names to person entities', () => {
    const lookup = buildPersonLookup(samplePeople);
    expect(lookup.get('dario amodei')?.id).toBe('dario-amodei');
    expect(lookup.get('geoffrey hinton')?.id).toBe('geoffrey-hinton');
  });

  it('strips parentheticals from titles', () => {
    const people: PersonEntity[] = [
      { id: 'sbf', numericId: 'E999', title: 'Sam Bankman-Fried (FTX)' },
    ];
    const lookup = buildPersonLookup(people);
    expect(lookup.get('sam bankman-fried')?.id).toBe('sbf');
    // Should NOT have the parenthetical version
    expect(lookup.get('sam bankman-fried (ftx)')).toBeUndefined();
  });

  it('includes manual aliases for known variations', () => {
    const lookup = buildPersonLookup(samplePeople);
    // "Nuno Sempere" (without tilde) should match "Nuño Sempere"
    expect(lookup.get('nuno sempere')?.id).toBe('nuno-sempere');
  });
});

describe('findExcludedZones', () => {
  it('excludes frontmatter', () => {
    const content = '---\ntitle: Test\n---\nSome content';
    const zones = findExcludedZones(content);
    // Frontmatter zone should cover "---\ntitle: Test\n---\n"
    expect(zones.some((z) => z.start === 0 && z.end > 0)).toBe(true);
  });

  it('excludes fenced code blocks', () => {
    const content = 'Before\n```\nDario Amodei in code\n```\nAfter';
    const zones = findExcludedZones(content);
    expect(zones.some((z) => content.substring(z.start, z.end).includes('Dario Amodei in code'))).toBe(true);
  });

  it('excludes inline code', () => {
    const content = 'See `Dario Amodei` for details';
    const zones = findExcludedZones(content);
    expect(zones.some((z) => content.substring(z.start, z.end).includes('Dario Amodei'))).toBe(true);
  });

  it('excludes headings', () => {
    const content = '## Dario Amodei\nSome content';
    const zones = findExcludedZones(content);
    expect(zones.some((z) => content.substring(z.start, z.end).includes('Dario Amodei'))).toBe(true);
  });

  it('excludes EntityLink tags and their contents', () => {
    const content = 'See <EntityLink id="E91" name="dario-amodei">Dario Amodei</EntityLink> here';
    const zones = findExcludedZones(content);
    expect(zones.some((z) => content.substring(z.start, z.end).includes('Dario Amodei'))).toBe(true);
  });

  it('excludes import/export statements', () => {
    const content = 'import { SomeComponent } from "./component"\nContent here';
    const zones = findExcludedZones(content);
    expect(zones.some((z) => content.substring(z.start, z.end).includes('import'))).toBe(true);
  });

  it('excludes MDX comments', () => {
    const content = 'Before {/* Dario Amodei comment */} After';
    const zones = findExcludedZones(content);
    expect(zones.some((z) => content.substring(z.start, z.end).includes('Dario Amodei'))).toBe(true);
  });
});

describe('buildPositionMap', () => {
  it('maps positions correctly for ASCII text', () => {
    const text = 'Hello World';
    const map = buildPositionMap(text);
    // Each character maps to itself since there are no diacritics
    expect(map[0]).toBe(0); // H
    expect(map[5]).toBe(5); // space
    expect(map[6]).toBe(6); // W
  });

  it('handles diacritics correctly', () => {
    const text = 'Nuño';
    const map = buildPositionMap(text);
    // "ñ" in NFD is "n" + combining tilde
    // After stripping, "Nuño" becomes "Nuno" (4 chars)
    // map[0] = 0 (N), map[1] = 1 (u), map[2] = 2 (ñ), map[3] = 3 (o)
    expect(map.length).toBeGreaterThanOrEqual(5); // 4 chars + sentinel
    expect(map[0]).toBe(0); // N
    expect(map[1]).toBe(1); // u
    // The ñ position should map back to position 2 in the original
    expect(map[2]).toBe(2); // ñ (stripped to n)
    expect(map[3]).toBe(3); // o
  });
});

describe('detectPersonMentions', () => {
  const lookup = buildPersonLookup(samplePeople);

  it('finds plain-text person mentions', () => {
    const content = 'Dario Amodei founded Anthropic.';
    const mentions = detectPersonMentions(content, lookup);
    expect(mentions.length).toBe(1);
    expect(mentions[0].personId).toBe('dario-amodei');
    expect(mentions[0].matchedText).toBe('Dario Amodei');
    expect(mentions[0].alreadyLinked).toBe(false);
  });

  it('detects multiple different people', () => {
    const content = 'Dario Amodei and Geoffrey Hinton discussed AI safety.';
    const mentions = detectPersonMentions(content, lookup);
    const ids = mentions.map((m) => m.personId).sort();
    expect(ids).toEqual(['dario-amodei', 'geoffrey-hinton']);
  });

  it('marks EntityLink-wrapped mentions as already linked', () => {
    const content =
      '<EntityLink id="E91" name="dario-amodei">Dario Amodei</EntityLink> said something.';
    const mentions = detectPersonMentions(content, lookup);
    expect(mentions.length).toBe(1);
    expect(mentions[0].alreadyLinked).toBe(true);
  });

  it('skips mentions in frontmatter', () => {
    const content = '---\ntitle: Dario Amodei Profile\n---\nContent here.';
    const mentions = detectPersonMentions(content, lookup);
    const unlinked = mentions.filter((m) => !m.alreadyLinked);
    // "Dario Amodei" in frontmatter should be marked as already linked (excluded)
    expect(unlinked.length).toBe(0);
  });

  it('skips mentions in code blocks', () => {
    const content = '```\nDario Amodei in code\n```\nDario Amodei in text.';
    const mentions = detectPersonMentions(content, lookup);
    const unlinked = mentions.filter((m) => !m.alreadyLinked);
    expect(unlinked.length).toBe(1);
    expect(unlinked[0].matchedText).toBe('Dario Amodei');
  });

  it('skips mentions in headings', () => {
    const content = '## Dario Amodei\nDario Amodei is a CEO.';
    const mentions = detectPersonMentions(content, lookup);
    const unlinked = mentions.filter((m) => !m.alreadyLinked);
    expect(unlinked.length).toBe(1);
  });

  it('handles diacritics: matches "Nuno Sempere" to "Nuño Sempere"', () => {
    const content = 'Nuno Sempere wrote about forecasting.';
    const mentions = detectPersonMentions(content, lookup);
    expect(mentions.length).toBe(1);
    expect(mentions[0].personId).toBe('nuno-sempere');
    expect(mentions[0].matchedText).toBe('Nuno Sempere');
    expect(mentions[0].alreadyLinked).toBe(false);
  });

  it('is case-insensitive', () => {
    const content = 'DARIO AMODEI gave a talk.';
    const mentions = detectPersonMentions(content, lookup);
    expect(mentions.length).toBe(1);
    expect(mentions[0].personId).toBe('dario-amodei');
  });

  it('does not match partial names', () => {
    const content = 'Dario went to the store. Amodei is a surname.';
    const mentions = detectPersonMentions(content, lookup);
    // Should not match "Dario" or "Amodei" alone
    expect(mentions.length).toBe(0);
  });

  it('reports correct line numbers', () => {
    const content = 'Line 1\nLine 2\nDario Amodei on line 3\nLine 4';
    const mentions = detectPersonMentions(content, lookup);
    expect(mentions.length).toBe(1);
    expect(mentions[0].line).toBe(3);
  });

  it('handles multiple mentions of the same person', () => {
    const content = 'Dario Amodei said X. Later, Dario Amodei said Y.';
    const mentions = detectPersonMentions(content, lookup);
    const unlinked = mentions.filter((m) => !m.alreadyLinked);
    expect(unlinked.length).toBe(2);
  });
});

describe('applyEntityLinks', () => {
  const lookup = buildPersonLookup(samplePeople);

  it('wraps the first occurrence of each person in EntityLink', () => {
    const content = 'Dario Amodei founded Anthropic. Dario Amodei is CEO.';
    const mentions = detectPersonMentions(content, lookup);
    const result = applyEntityLinks(content, mentions);

    expect(result.appliedCount).toBe(1);
    expect(result.linkedPersons).toEqual(['dario-amodei']);
    expect(result.content).toContain(
      '<EntityLink id="E91" name="dario-amodei">Dario Amodei</EntityLink>',
    );
    // Second occurrence should remain plain text
    expect(result.content).toMatch(
      /EntityLink.*Dario Amodei.*EntityLink.*Dario Amodei/,
    );
  });

  it('does not double-wrap already linked mentions', () => {
    const content =
      '<EntityLink id="E91" name="dario-amodei">Dario Amodei</EntityLink> said something.';
    const mentions = detectPersonMentions(content, lookup);
    const result = applyEntityLinks(content, mentions);
    expect(result.appliedCount).toBe(0);
    expect(result.content).toBe(content);
  });

  it('wraps multiple different people', () => {
    const content = 'Dario Amodei and Geoffrey Hinton discussed AI.';
    const mentions = detectPersonMentions(content, lookup);
    const result = applyEntityLinks(content, mentions);
    expect(result.appliedCount).toBe(2);
    expect(result.content).toContain('<EntityLink id="E91"');
    expect(result.content).toContain('<EntityLink id="E149"');
  });

  it('preserves original casing in the display text', () => {
    const content = 'DARIO AMODEI gave a talk.';
    const mentions = detectPersonMentions(content, lookup);
    const result = applyEntityLinks(content, mentions);
    expect(result.content).toContain('>DARIO AMODEI</EntityLink>');
  });

  it('handles content with emojis correctly', () => {
    const content = 'Some text with emojis: \u{1F7E0} \u{1F535} and Dario Amodei is here.';
    const mentions = detectPersonMentions(content, lookup);
    const result = applyEntityLinks(content, mentions);
    expect(result.appliedCount).toBe(1);
    expect(result.content).toContain(
      '<EntityLink id="E91" name="dario-amodei">Dario Amodei</EntityLink>',
    );
  });

  it('does not modify content when no unlinked mentions exist', () => {
    const content = 'No person names here.';
    const mentions = detectPersonMentions(content, lookup);
    const result = applyEntityLinks(content, mentions);
    expect(result.appliedCount).toBe(0);
    expect(result.content).toBe(content);
  });
});
