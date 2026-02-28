import { describe, it, expect } from 'vitest';
import {
  stripMarkup,
  containsEntityReference,
  fixSelfContainment,
  isNonAtomic,
  isTautologicalDefinition,
  runExtractionQualityGate,
  type GateInput,
} from './extraction-quality-gate.ts';

// ---------------------------------------------------------------------------
// stripMarkup
// ---------------------------------------------------------------------------

describe('stripMarkup', () => {
  it('strips EntityLink tags, keeping text content', () => {
    const { cleaned, labels } = stripMarkup(
      'Founded by <EntityLink id="dario-amodei">Dario Amodei</EntityLink>.',
    );
    expect(cleaned).toBe('Founded by Dario Amodei.');
    expect(labels).toContain('EntityLink');
  });

  it('strips F tags entirely', () => {
    const { cleaned } = stripMarkup('Revenue was <F id="revenue" />.');
    expect(cleaned).toBe('Revenue was .');
  });

  it('strips MDX comments', () => {
    const { cleaned, labels } = stripMarkup('Some text {/* NEEDS CITATION */} more.');
    expect(cleaned).toBe('Some text more.');
    expect(labels).toContain('MDX-comment');
  });

  it('strips bold markdown', () => {
    const { cleaned } = stripMarkup('This is **very important** text.');
    expect(cleaned).toBe('This is very important text.');
  });

  it('strips markdown links', () => {
    const { cleaned } = stripMarkup('See [this article](https://example.com) for details.');
    expect(cleaned).toBe('See this article for details.');
  });

  it('unescapes dollar signs', () => {
    const { cleaned } = stripMarkup('The company raised \\$2 billion.');
    expect(cleaned).toBe('The company raised $2 billion.');
  });

  it('returns original text if no markup', () => {
    const { cleaned, labels } = stripMarkup('Anthropic was founded in 2021.');
    expect(cleaned).toBe('Anthropic was founded in 2021.');
    expect(labels).toHaveLength(0);
  });

  it('collapses multiple spaces after stripping', () => {
    const { cleaned } = stripMarkup('Text <F id="x" /> with  gaps.');
    expect(cleaned).toBe('Text with gaps.');
    expect(cleaned).not.toContain('  ');
  });
});

// ---------------------------------------------------------------------------
// containsEntityReference
// ---------------------------------------------------------------------------

describe('containsEntityReference', () => {
  it('detects entity name', () => {
    expect(containsEntityReference('Anthropic raised $2B.', 'anthropic', 'Anthropic')).toBe(true);
  });

  it('detects entity slug', () => {
    expect(containsEntityReference('anthropic raised $2B.', 'anthropic', 'Anthropic')).toBe(true);
  });

  it('detects hyphenated slug as space-separated words', () => {
    expect(containsEntityReference('Sam Altman joined OpenAI.', 'sam-altman', 'Sam Altman')).toBe(true);
  });

  it('returns false when entity not mentioned', () => {
    expect(containsEntityReference('The company raised $2B.', 'anthropic', 'Anthropic')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(containsEntityReference('ANTHROPIC raised money.', 'anthropic', 'Anthropic')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fixSelfContainment
// ---------------------------------------------------------------------------

describe('fixSelfContainment', () => {
  it('replaces "the company" with entity name', () => {
    const result = fixSelfContainment('The company raised $2 billion.', 'Anthropic');
    expect(result).not.toBeNull();
    expect(result!.fixed).toBe('Anthropic raised $2 billion.');
    expect(result!.method).toBe('replace-the-company');
  });

  it('replaces "the platform" with entity name', () => {
    const result = fixSelfContainment('The platform launched in 2020.', 'Kalshi');
    expect(result).not.toBeNull();
    expect(result!.fixed).toBe('Kalshi launched in 2020.');
  });

  it('replaces "It" pronoun with entity name', () => {
    const result = fixSelfContainment('It was founded in 2021.', 'Anthropic');
    expect(result).not.toBeNull();
    expect(result!.fixed).toBe('Anthropic was founded in 2021.');
    expect(result!.method).toBe('replace-it-pronoun');
  });

  it('replaces "They" pronoun with entity name', () => {
    const result = fixSelfContainment('They raised $7 billion total.', 'Anthropic');
    expect(result).not.toBeNull();
    expect(result!.fixed).toBe('Anthropic raised $7 billion total.');
    expect(result!.method).toBe('replace-they-pronoun');
  });

  it('returns null when no auto-fix strategy works', () => {
    const result = fixSelfContainment('A major funding round occurred in 2023.', 'Anthropic');
    expect(result).toBeNull();
  });

  it('strips relative starts like "However" when entity is present after', () => {
    const result = fixSelfContainment('However, Anthropic grew rapidly.', 'Anthropic');
    expect(result).not.toBeNull();
    expect(result!.fixed).toBe('Anthropic grew rapidly.');
    expect(result!.method).toBe('strip-relative-start');
  });
});

// ---------------------------------------------------------------------------
// isNonAtomic
// ---------------------------------------------------------------------------

describe('isNonAtomic', () => {
  it('detects semicolon-split independent clauses', () => {
    expect(isNonAtomic('Anthropic raised $2B; Google invested separately.')).toBe('semicolon-split');
  });

  it('detects compound-and pattern', () => {
    expect(isNonAtomic('Anthropic was founded in 2021, and OpenAI launched GPT-4.')).toBe('compound-and');
  });

  it('detects connective multi-sentence claims', () => {
    expect(isNonAtomic('Anthropic raised $2B. Additionally, they hired 500 people.')).toBe('connective-multi-sentence');
  });

  it('returns null for atomic claims', () => {
    expect(isNonAtomic('Anthropic raised $2 billion in 2023.')).toBeNull();
  });

  it('allows "and" within a single assertion', () => {
    expect(isNonAtomic('Anthropic was founded by Dario and Daniela Amodei.')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isTautologicalDefinition
// ---------------------------------------------------------------------------

describe('isTautologicalDefinition', () => {
  it('detects basic tautology', () => {
    expect(isTautologicalDefinition('Kalshi is a prediction market platform.', 'kalshi', 'Kalshi')).toBe(true);
  });

  it('detects tautology with "was"', () => {
    expect(isTautologicalDefinition('Anthropic was an AI safety company.', 'anthropic', 'Anthropic')).toBe(true);
  });

  it('does not flag claims with specifics', () => {
    expect(isTautologicalDefinition('Kalshi is a prediction market founded in 2018.', 'kalshi', 'Kalshi')).toBe(false);
  });

  it('does not flag claims with location info', () => {
    expect(isTautologicalDefinition('Anthropic is an AI company headquartered in San Francisco.', 'anthropic', 'Anthropic')).toBe(false);
  });

  it('does not flag non-definition claims', () => {
    expect(isTautologicalDefinition('Anthropic raised $2 billion.', 'anthropic', 'Anthropic')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runExtractionQualityGate — full pipeline
// ---------------------------------------------------------------------------

describe('runExtractionQualityGate', () => {
  const opts = { entityId: 'anthropic', entityName: 'Anthropic' };

  function makeClaim(text: string, overrides: Partial<GateInput> = {}): GateInput {
    return { claimText: text, claimType: 'factual', ...overrides };
  }

  it('accepts clean, self-contained claims', () => {
    const result = runExtractionQualityGate(
      [makeClaim('Anthropic raised $2 billion in October 2023.')],
      opts,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.stats.autoFixedCount).toBe(0);
  });

  it('auto-fixes markup in claims', () => {
    const result = runExtractionQualityGate(
      [makeClaim('Anthropic was founded by <EntityLink id="dario-amodei">Dario Amodei</EntityLink>.')],
      opts,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].claimText).toBe('Anthropic was founded by Dario Amodei.');
    expect(result.stats.autoFixedCount).toBe(1);
    expect(result.stats.fixBreakdown['strip-markup']).toBe(1);
  });

  it('auto-fixes self-containment by replacing generic references', () => {
    const result = runExtractionQualityGate(
      [makeClaim('The company raised $2 billion in 2023.')],
      opts,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].claimText).toBe('Anthropic raised $2 billion in 2023.');
    expect(result.stats.fixBreakdown['self-contain']).toBe(1);
  });

  it('auto-fixes missing terminal punctuation', () => {
    const result = runExtractionQualityGate(
      [makeClaim('Anthropic raised $2 billion in 2023')],
      opts,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].claimText).toBe('Anthropic raised $2 billion in 2023.');
    expect(result.stats.fixBreakdown['add-period']).toBe(1);
  });

  it('rejects non-atomic claims', () => {
    const result = runExtractionQualityGate(
      [makeClaim('Anthropic raised $2B; Google invested $300M separately.')],
      opts,
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectReasons).toContain('non-atomic(semicolon-split)');
    expect(result.accepted).toHaveLength(0);
  });

  it('rejects tautological definitions', () => {
    const result = runExtractionQualityGate(
      [makeClaim('Anthropic is an AI safety company.')],
      opts,
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectReasons).toContain('tautological');
  });

  it('rejects too-short claims', () => {
    const result = runExtractionQualityGate(
      [makeClaim('Anthropic exists.')],
      opts,
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectReasons).toContain('too-short');
  });

  it('rejects claims that cannot be made self-contained', () => {
    const result = runExtractionQualityGate(
      [makeClaim('A major funding round occurred in late October 2023.')],
      opts,
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectReasons).toContain('not-self-contained');
  });

  it('deduplicates near-identical claims within a batch', () => {
    const result = runExtractionQualityGate(
      [
        makeClaim('Anthropic raised $2 billion in October 2023.'),
        makeClaim('Anthropic raised $2 billion in October of 2023.'),
      ],
      opts,
    );
    // Second claim should be rejected as duplicate
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectReasons).toContain('duplicate');
  });

  it('applies multiple fixes to a single claim', () => {
    const result = runExtractionQualityGate(
      [makeClaim('The company raised <F id="funding" /> in **October** 2023')],
      opts,
    );
    expect(result.accepted).toHaveLength(1);
    // Should strip markup, fix self-containment, and add period
    expect(result.accepted[0].claimText).toContain('Anthropic');
    expect(result.accepted[0].claimText).not.toContain('<F');
    expect(result.accepted[0].claimText).not.toContain('**');
    expect(result.accepted[0].claimText).toMatch(/\.$/);
  });

  it('passes everything through when disabled', () => {
    const badClaims = [
      makeClaim('Bad.'),
      makeClaim('The company is great.'),
    ];
    const result = runExtractionQualityGate(badClaims, { ...opts, disabled: true });
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
    expect(result.stats.autoFixedCount).toBe(0);
  });

  it('handles empty claim list', () => {
    const result = runExtractionQualityGate([], opts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.stats.total).toBe(0);
  });

  it('preserves extra fields on accepted claims', () => {
    const claim = makeClaim('Anthropic raised $2 billion in 2023.') as GateInput & { section: string };
    claim.section = 'Funding';
    const result = runExtractionQualityGate([claim], opts);
    expect(result.accepted[0]).toHaveProperty('section', 'Funding');
  });

  it('counts fix and reject breakdowns correctly', () => {
    const result = runExtractionQualityGate(
      [
        makeClaim('Anthropic raised $2B.'),                                    // clean accept
        makeClaim('The company launched Claude.'),                              // auto-fix self-contain
        makeClaim('Anthropic is an AI company.'),                               // reject tautological
        makeClaim('Anthropic grew; OpenAI also grew significantly in 2023.'),   // reject non-atomic
      ],
      opts,
    );
    expect(result.stats.accepted).toBe(2);
    expect(result.stats.rejected).toBe(2);
    expect(result.stats.autoFixedCount).toBe(1);
    expect(result.stats.fixBreakdown['self-contain']).toBe(1);
    expect(result.stats.rejectBreakdown['tautological']).toBe(1);
    expect(result.stats.rejectBreakdown['non-atomic']).toBe(1);
  });
});
