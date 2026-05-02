import { describe, it, expect } from 'vitest';
import {
  buildScorecardGradeExcerpt,
  findDimensionSection,
} from './scorecard-grade-excerpt.ts';

// ── findDimensionSection ──────────────────────────────────────────────

describe('findDimensionSection', () => {
  it('matches "X This domain" (FLI Index format)', () => {
    const text =
      'header padding '.repeat(1000) +
      'Existential Safety This domain examines companies preparedness';
    const idx = findDimensionSection(text, 'Existential Safety', 8000);
    expect(idx).toBeGreaterThan(0);
    expect(text.slice(idx, idx + 30)).toBe('Existential Safety This domain');
  });

  it('matches "X This area" / "X This category" defensive variants', () => {
    const baseHeader = 'header '.repeat(2000);
    const a = baseHeader + 'Risk Mgmt This area covers exposures';
    expect(findDimensionSection(a, 'Risk Mgmt', 8000)).toBeGreaterThan(0);
    const b = baseHeader + 'Privacy This category measures controls';
    expect(findDimensionSection(b, 'Privacy', 8000)).toBeGreaterThan(0);
  });

  it('matches "X evaluates|covers|assesses|measures|examines" phrasings', () => {
    const baseHeader = 'header '.repeat(2000);
    for (const verb of ['evaluates', 'covers', 'assesses', 'measures', 'examines']) {
      const text = baseHeader + `Governance ${verb} how the org`;
      expect(findDimensionSection(text, 'Governance', 8000)).toBeGreaterThan(0);
    }
  });

  it('ignores matches before the header threshold (early labels list)', () => {
    // Many scorecard pages list dimension labels in a TOC near the top —
    // those are not the deep section we want.
    const text =
      'Domains Breakdown Risk Assessment This domain ' + // early — should NOT match
      'padding '.repeat(2000) +
      'Risk Assessment This domain evaluates the rigor'; // deep — SHOULD match
    const idx = findDimensionSection(text, 'Risk Assessment', 8000);
    expect(idx).toBeGreaterThanOrEqual(8000);
  });

  it('returns -1 when dimension label is empty', () => {
    expect(findDimensionSection('any text', '', 0)).toBe(-1);
  });

  it('returns -1 when dimension is not present', () => {
    expect(findDimensionSection('only the header', 'Missing Dim', 0)).toBe(-1);
  });

  it('escapes regex metacharacters in dimension labels', () => {
    // FMTI uses dimensions like "Indicator 4.3 (regulatory)" — the dot and
    // parens are regex metacharacters that must be escaped.
    const baseHeader = 'header '.repeat(2000);
    const text = baseHeader + 'Indicator 4.3 (regulatory) This domain evaluates';
    expect(
      findDimensionSection(text, 'Indicator 4.3 (regulatory)', 8000),
    ).toBeGreaterThan(0);
  });

  it('match is case-insensitive', () => {
    const baseHeader = 'header '.repeat(2000);
    const text = baseHeader + 'governance evaluates how the org';
    expect(findDimensionSection(text, 'GOVERNANCE', 8000)).toBeGreaterThan(0);
  });

  it('requires word boundary before dimension (no substring-of-larger-word matches)', () => {
    // dimension="Risk" must NOT match inside "lowRisk evaluates the
    // exposure" — that's a different concept appearing as a suffix of a
    // compound word. A lookbehind-less regex matches because "Risk
    // evaluates" is a literal substring; the lookbehind blocks it because
    // the char before "Risk" ("w") is a word char.
    const baseHeader = 'header '.repeat(2000);
    const wrongAnchor = baseHeader + 'lowRisk evaluates the exposure';
    expect(findDimensionSection(wrongAnchor, 'Risk', 8000)).toBe(-1);

    // Confirm the right anchor still matches (dimension preceded by
    // non-word char).
    const rightAnchor = baseHeader + 'Risk evaluates the exposure';
    expect(findDimensionSection(rightAnchor, 'Risk', 8000)).toBeGreaterThan(0);
  });

  it('returns the earliest deep-section anchor across all phrasings (not pattern-priority)', () => {
    // Two phrasings present, with the 'evaluates' anchor EARLIER in the
    // text than the 'This domain' anchor. We want the earliest one — not
    // the first match of the most-specific pattern.
    const baseHeader = 'header '.repeat(2000);
    const evaluatesPos = baseHeader.length;
    const text =
      baseHeader +
      'Privacy evaluates the controls' +
      'filler '.repeat(500) +
      'Privacy This domain summarizes ...';
    const found = findDimensionSection(text, 'Privacy', 8000);
    // Should land at the EARLIER anchor (the 'evaluates' phrasing),
    // not the later 'This domain' one. Order in source text wins.
    expect(found).toBe(evaluatesPos);
  });

  it('returns -1 for oversized dimension labels (ReDoS guard)', () => {
    const huge = 'X'.repeat(500);
    const text = 'padding '.repeat(2000) + huge + ' This domain evaluates';
    expect(findDimensionSection(text, huge, 8000)).toBe(-1);
  });
});

// ── buildScorecardGradeExcerpt ────────────────────────────────────────

describe('buildScorecardGradeExcerpt', () => {
  it('returns full text when shorter than maxLength', () => {
    const text = 'short content';
    const out = buildScorecardGradeExcerpt({ dimension: 'Anything' }, text, 30000);
    expect(out).toBe(text);
  });

  it('returns first maxLength chars for "Overall" rows', () => {
    const text = 'x'.repeat(50000);
    const out = buildScorecardGradeExcerpt({ dimension: 'Overall' }, text, 30000);
    expect(out).toBe(text.slice(0, 30000));
  });

  it('returns first maxLength chars when dimension is null/empty', () => {
    const text = 'x'.repeat(50000);
    expect(
      buildScorecardGradeExcerpt({ dimension: null }, text, 30000),
    ).toBe(text.slice(0, 30000));
    expect(
      buildScorecardGradeExcerpt({}, text, 30000),
    ).toBe(text.slice(0, 30000));
  });

  it('returns first maxLength chars when deep section is not found', () => {
    const text = 'x'.repeat(50000);
    const out = buildScorecardGradeExcerpt(
      { dimension: 'NotPresent' },
      text,
      30000,
    );
    expect(out).toBe(text.slice(0, 30000));
  });

  it('returns header + deep section when dimension is found past header', () => {
    // Build a synthetic source mimicking the FLI page:
    //   chars 0..7999     — main scorecard with overall grades (header)
    //   chars 8000..49999 — padding ("Risk Assessment domain evaluates" buried inside)
    //   chars 50000+      — the dimension's own deep section
    const header = 'MAIN_SCORECARD '.padEnd(8_000, '.');
    const padding = 'noise '.repeat(7_000); // ~42K chars
    const deepSection =
      'Existential Safety This domain examines preparedness for managing extreme risks ' +
      'Scorecard Anthropic D 1.21 OpenAI D 1 Google DeepMind D 1.15';
    const text = header + padding + deepSection;

    expect(text.length).toBeGreaterThan(50_000);

    const out = buildScorecardGradeExcerpt(
      { dimension: 'Existential Safety' },
      text,
      30_000,
    );

    expect(out.length).toBeLessThanOrEqual(30_000);
    expect(out).toContain('MAIN_SCORECARD');
    expect(out).toContain('Existential Safety This domain');
    expect(out).toContain('OpenAI D 1');
    expect(out).toContain('omitted');
  });

  it('matches dimension label across multiple recognized verbs', () => {
    const header = 'HEADER '.padEnd(8_000, '.');
    const padding = 'noise '.repeat(7_000);
    const deepSection = 'Risk Assessment evaluates the rigor of risk processes';
    const text = header + padding + deepSection;
    const out = buildScorecardGradeExcerpt(
      { dimension: 'Risk Assessment' },
      text,
      30_000,
    );
    expect(out).toContain('Risk Assessment evaluates');
  });

  it('falls back to first maxLength chars when maxLength is too small for header', () => {
    const text = 'x'.repeat(50_000);
    // maxLength smaller than HEADER_BUDGET_CHARS
    const out = buildScorecardGradeExcerpt(
      { dimension: 'Anything' },
      text,
      1_000,
    );
    expect(out).toBe(text.slice(0, 1_000));
  });

  it('does not duplicate content when deep section overlaps with header window', () => {
    // If the dimension section is already in the early header (shouldn't
    // happen often, but defensive), findDimensionSection requires position
    // >= header budget, so it returns -1 and we fall back to first slice.
    const text =
      'Risk Assessment evaluates ... ' +
      'x'.repeat(45_000);
    const out = buildScorecardGradeExcerpt(
      { dimension: 'Risk Assessment' },
      text,
      30_000,
    );
    expect(out).toBe(text.slice(0, 30_000));
    // No "omitted" separator since we used the simple path.
    expect(out).not.toContain('[... omitted: middle of source document ...]');
  });

  it('treats "Overall Grade" and other "Overall *" variants as overall', () => {
    const text = 'x'.repeat(50_000);
    for (const variant of ['Overall', 'Overall Grade', 'Overall Score', 'OVERALL ']) {
      const out = buildScorecardGradeExcerpt({ dimension: variant }, text, 30_000);
      expect(out).toBe(text.slice(0, 30_000));
    }
  });

  it('coerces numeric dimension labels (e.g., FMTI 4.3 indicators)', () => {
    const header = 'HEADER '.padEnd(8_000, '.');
    const padding = 'noise '.repeat(7_000);
    // FMTI-style: dimension key is numeric, deep section opens with "4.3 evaluates ..."
    const deep = '4.3 evaluates the regulatory framework';
    const text = header + padding + deep;
    const out = buildScorecardGradeExcerpt({ dimension: 4.3 }, text, 30_000);
    expect(out).toContain('4.3 evaluates');
    expect(out).toContain('[... omitted: middle of source document ...]');
  });

  it('header budget scales down with maxLength so it never exceeds 25% of the prompt', () => {
    // If maxLength shrinks (say, to 20K), the 8K header would consume 40%
    // of the window. The chooser caps header to maxLength/4 so the deep
    // section still gets a usable window.
    const header = 'HEADER '.padEnd(8_000, '.');
    const padding = 'noise '.repeat(2_000);
    const deep = 'Risk Assessment This domain evaluates';
    const text = header + padding + deep;

    // maxLength=20K. Header budget should be min(8000, 5000) = 5000, so
    // the function looks for the deep section starting at offset 5000+,
    // which is past the padded header — the deep section sits at ~20K.
    const out = buildScorecardGradeExcerpt(
      { dimension: 'Risk Assessment' },
      text,
      20_000,
    );
    expect(out).toContain('Risk Assessment This domain');
    expect(out.length).toBeLessThanOrEqual(20_000);
  });
});
