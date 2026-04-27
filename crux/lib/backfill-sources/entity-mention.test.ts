import { describe, it, expect } from 'vitest';
import {
  contentMentionsEntity,
  isSelfDomain,
  orgNameVariants,
  personNameVariants,
} from './entity-mention.ts';

describe('isSelfDomain', () => {
  it.each([
    'https://longtermwiki.com/x',
    'https://www.longtermwiki.com/x',
    'https://staging.longtermwiki.com/x',
    'https://longtermwiki.org/x',
    'https://www.longtermwiki.org/x',
    'https://staging.longtermwiki.org/x',
    'https://longterm.wiki/x',
    'https://sub.longterm.wiki/x',
  ])('flags self domain %s', (url) => {
    expect(isSelfDomain(url)).toBe(true);
  });

  it.each([
    'https://wikipedia.org/wiki/X',
    'https://anthropic.com/news',
    'https://www.nytimes.com/article',
    // Lookalike hostnames — must not match
    'https://notlongtermwiki.com/evil',
    'https://longtermwiki.com.evil.example/x',
  ])('does not flag non-self domain %s', (url) => {
    expect(isSelfDomain(url)).toBe(false);
  });

  it('returns false for unparseable urls', () => {
    expect(isSelfDomain('not a url')).toBe(false);
    expect(isSelfDomain('')).toBe(false);
  });
});

describe('contentMentionsEntity', () => {
  it('matches a literal substring (case-insensitive)', () => {
    expect(contentMentionsEntity('Andy Zou is a researcher.', 'Andy Zou')).toBe(true);
    expect(contentMentionsEntity('andy zou is a researcher.', 'Andy Zou')).toBe(true);
  });

  it('matches a slug-as-words variant', () => {
    expect(contentMentionsEntity(
      'A page from the Center for AI Safety website.',
      'center-for-ai-safety',
    )).toBe(true);
  });

  it('matches when source uses accents and entity is unaccented', () => {
    expect(contentMentionsEntity('Profile of Pérez García', 'Perez Garcia')).toBe(true);
  });

  it('matches when source is unaccented and entity has accents', () => {
    expect(contentMentionsEntity('Profile of Perez Garcia', 'Pérez García')).toBe(true);
  });

  it('matches via URL host when body does not name the entity', () => {
    // Pages on the org's own domain are obviously about the org even when
    // body uses "we" / "our program" instead of the name
    expect(contentMentionsEntity(
      'We have completed our medium-depth investigation.',
      'Coefficient Giving',
      'https://coefficientgiving.org/research/criminal-justice-reform',
    )).toBe(true);
  });

  it('rejects when entity is genuinely absent (no body, no slug, no URL)', () => {
    expect(contentMentionsEntity(
      'OpenAI announced a new model.',
      'Anthropic',
      'https://openai.com/news',
    )).toBe(false);
  });

  it('passes through (returns true) for entity name shorter than 3 chars', () => {
    // Defensive: don't gate on 1-2 char fragments — defer to LLM
    expect(contentMentionsEntity('something', 'AI')).toBe(true);
  });

  it('handles bad URL gracefully', () => {
    expect(contentMentionsEntity('Body without entity', 'Anthropic', 'not a url')).toBe(false);
  });
});

describe('personNameVariants', () => {
  it('returns a single variant for one-word names', () => {
    expect(personNameVariants('Madonna')).toEqual(['Madonna']);
  });

  it('returns full + surname for two-word names with long surname', () => {
    expect(personNameVariants('Andy Zou')).toEqual(['Andy Zou']); // 'Zou' < 5 chars, dropped
    expect(personNameVariants('Chris Olah')).toEqual(['Chris Olah']); // 'Olah' < 5 chars, dropped
    expect(personNameVariants('Dario Amodei')).toEqual(['Dario Amodei', 'Amodei']);
  });

  it('returns full + first-last + surname for 3+-word names', () => {
    expect(personNameVariants('Natalia Perez-Campanero Antolin')).toEqual([
      'Natalia Perez-Campanero Antolin',
      'Natalia Antolin',
      'Antolin',
    ]);
  });

  it('drops surname-only when surname is too short', () => {
    expect(personNameVariants('First Middle Foo')).toEqual([
      'First Middle Foo',
      'First Foo',
      // 'Foo' < 5 chars, not included
    ]);
  });

  it('returns empty for empty input', () => {
    expect(personNameVariants('')).toEqual([]);
    expect(personNameVariants('   ')).toEqual([]);
  });
});

describe('orgNameVariants', () => {
  it('returns a single variant when no parens', () => {
    expect(orgNameVariants('Anthropic')).toEqual(['Anthropic']);
  });

  it('pulls out parenthetical alias as separate variants', () => {
    expect(orgNameVariants('Andreessen Horowitz (a16z)')).toEqual([
      'Andreessen Horowitz (a16z)',
      'Andreessen Horowitz',
      'a16z',
    ]);
  });

  it('drops empty input', () => {
    expect(orgNameVariants('')).toEqual([]);
  });

  it('drops variants under 2 chars but keeps the full original', () => {
    // 'X' and 'Y' are too short, but the full 'X (Y)' (5 chars) survives
    expect(orgNameVariants('X (Y)')).toEqual(['X (Y)']);
  });
});
