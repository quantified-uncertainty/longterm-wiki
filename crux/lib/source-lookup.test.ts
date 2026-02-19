import { describe, it, expect } from 'vitest';
import { parseBookReference } from './source-lookup.ts';

describe('parseBookReference', () => {
  it('parses "Author (Year). Title." format', () => {
    const ref = parseBookReference(
      'Bostrom (2014). Superintelligence: Paths, Dangers, Strategies. Oxford University Press.',
    );
    expect(ref).not.toBeNull();
    expect(ref!.author).toBe('Bostrom');
    expect(ref!.year).toBe('2014');
    expect(ref!.title).toBe('Superintelligence: Paths, Dangers, Strategies');
  });

  it('parses Author, "Title", Year format with straight quotes', () => {
    const ref = parseBookReference(
      'Russell, "Human Compatible", 2019',
    );
    expect(ref).not.toBeNull();
    expect(ref!.author).toBe('Russell');
    expect(ref!.title).toBe('Human Compatible');
    expect(ref!.year).toBe('2019');
  });

  it('extracts year from parenthetical', () => {
    const ref = parseBookReference(
      'Some Reference Title (2022)',
    );
    expect(ref).not.toBeNull();
    expect(ref!.year).toBe('2022');
    expect(ref!.title).toContain('Reference Title');
  });

  it('handles text without year', () => {
    const ref = parseBookReference(
      'A Long Title About Something Important',
    );
    expect(ref).not.toBeNull();
    expect(ref!.title).toBe('A Long Title About Something Important');
    expect(ref!.year).toBeUndefined();
  });

  it('returns null for empty/short input', () => {
    expect(parseBookReference('')).toBeNull();
    expect(parseBookReference('ab')).toBeNull();
  });

  it('handles multiple authors', () => {
    const ref = parseBookReference(
      'Amodei, Olah, et al. (2016). Concrete Problems in AI Safety.',
    );
    expect(ref).not.toBeNull();
    expect(ref!.author).toContain('Amodei');
    expect(ref!.year).toBe('2016');
    expect(ref!.title).toBe('Concrete Problems in AI Safety');
  });
});
