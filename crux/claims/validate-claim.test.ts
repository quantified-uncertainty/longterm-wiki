/**
 * Claim Validation — Unit Tests
 *
 * Tests the post-extraction claim validation logic:
 *   - Entity name presence (reject if missing)
 *   - Relative phrase detection (warn)
 *   - Terminal punctuation (reject if missing)
 *   - Length bounds (reject if outside 20-500)
 *   - Unresolved MDX tags (warn)
 *   - Tautological definitions (warn)
 *   - Vague language (warn)
 *   - Batch validation with strict mode
 */

import { describe, it, expect } from 'vitest';
import {
  validateClaim,
  validateClaimBatch,
  type ClaimValidationResult,
} from './validate-claim.ts';

// ---------------------------------------------------------------------------
// validateClaim — entity name presence
// ---------------------------------------------------------------------------

describe('validateClaim: entity name presence', () => {
  it('passes when claim contains entity name', () => {
    const result = validateClaim(
      'Anthropic raised $7.3 billion in funding.',
      'anthropic',
      'Anthropic',
    );
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('finds entity ID (slug) in claim text', () => {
    const result = validateClaim(
      'Anthropic API supports function calling.',
      'anthropic',
      'Anthropic',
    );
    // Entity is found, so no missing-entity-name issue
    expect(result.issues.some(i => i.includes('missing-entity-name'))).toBe(false);
  });

  it('passes for hyphenated slugs with space-separated name', () => {
    const result = validateClaim(
      'Sam Altman became CEO of OpenAI in 2019.',
      'sam-altman',
      'Sam Altman',
    );
    expect(result.valid).toBe(true);
  });

  it('rejects when claim does not mention entity', () => {
    const result = validateClaim(
      'The company raised $7.3 billion in funding.',
      'anthropic',
      'Anthropic',
    );
    expect(result.valid).toBe(false);
    expect(result.severity).toBe('reject');
    expect(result.issues.some(i => i.includes('missing-entity-name'))).toBe(true);
  });

  it('rejects when claim uses generic pronoun', () => {
    const result = validateClaim(
      'The platform processes over 1 million predictions daily.',
      'kalshi',
      'Kalshi',
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.includes('missing-entity-name'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateClaim — relative phrase starts
// ---------------------------------------------------------------------------

describe('validateClaim: relative phrase starts', () => {
  it('warns on claims starting with "The "', () => {
    const result = validateClaim(
      'The Anthropic team published a new paper.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('relative-start'))).toBe(true);
  });

  it('warns on claims starting with "However"', () => {
    const result = validateClaim(
      'However, Anthropic has not released this model.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('relative-start'))).toBe(true);
  });

  it('warns on claims starting with "Additionally"', () => {
    const result = validateClaim(
      'Additionally, Anthropic offers an enterprise tier.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('relative-start'))).toBe(true);
  });

  it('warns on claims starting with "Furthermore"', () => {
    const result = validateClaim(
      'Furthermore, OpenAI expanded to London.',
      'openai',
      'OpenAI',
    );
    expect(result.issues.some(i => i.includes('relative-start'))).toBe(true);
  });

  it('warns on claims starting with "Moreover"', () => {
    const result = validateClaim(
      'Moreover, Anthropic plans to hire 500 more employees.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('relative-start'))).toBe(true);
  });

  it('warns on claims starting with "In contrast"', () => {
    const result = validateClaim(
      'In contrast, Anthropic focuses on safety research.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('relative-start'))).toBe(true);
  });

  it('warns on claims starting with "This "', () => {
    const result = validateClaim(
      'This approach by Anthropic reduces hallucination.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('relative-start'))).toBe(true);
  });

  it('does not warn on claims starting with entity name', () => {
    const result = validateClaim(
      'Anthropic raised $7.3 billion in funding.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('relative-start'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateClaim — terminal punctuation
// ---------------------------------------------------------------------------

describe('validateClaim: terminal punctuation', () => {
  it('rejects claims without terminal punctuation', () => {
    const result = validateClaim(
      'Anthropic raised $7.3 billion in funding',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('no-terminal-punctuation'))).toBe(true);
    expect(result.severity).toBe('reject');
  });

  it('accepts claims ending with period', () => {
    const result = validateClaim(
      'Anthropic raised $7.3 billion in funding.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('no-terminal-punctuation'))).toBe(false);
  });

  it('accepts claims ending with question mark', () => {
    const result = validateClaim(
      'Anthropic raised $7.3 billion?',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('no-terminal-punctuation'))).toBe(false);
  });

  it('accepts claims ending with exclamation mark', () => {
    const result = validateClaim(
      'Anthropic raised $7.3 billion in funding!',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('no-terminal-punctuation'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateClaim — length bounds
// ---------------------------------------------------------------------------

describe('validateClaim: length bounds', () => {
  it('rejects claims shorter than 20 chars', () => {
    const result = validateClaim(
      'Anthropic exists.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('too-short'))).toBe(true);
    expect(result.severity).toBe('reject');
  });

  it('rejects claims longer than 500 chars', () => {
    const longClaim = `Anthropic ${'is a company that does many things '.repeat(15)}and more.`;
    const result = validateClaim(longClaim, 'anthropic', 'Anthropic');
    expect(result.issues.some(i => i.includes('too-long'))).toBe(true);
    expect(result.severity).toBe('reject');
  });

  it('accepts claims within bounds', () => {
    const result = validateClaim(
      'Anthropic was founded in 2021 by former OpenAI members.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('too-short'))).toBe(false);
    expect(result.issues.some(i => i.includes('too-long'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateClaim — unresolved MDX tags
// ---------------------------------------------------------------------------

describe('validateClaim: unresolved MDX tags', () => {
  it('warns on unresolved <F> tags', () => {
    const result = validateClaim(
      'Anthropic has <F id="employee_count" /> employees.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('unresolved-mdx'))).toBe(true);
  });

  it('does not warn when no MDX tags present', () => {
    const result = validateClaim(
      'Anthropic has 1,500 employees.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('unresolved-mdx'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateClaim — tautological definitions
// ---------------------------------------------------------------------------

describe('validateClaim: tautological definitions', () => {
  it('warns on "X is a Y" pattern', () => {
    const result = validateClaim(
      'Kalshi is a prediction market platform.',
      'kalshi',
      'Kalshi',
    );
    expect(result.issues.some(i => i.includes('tautological-definition'))).toBe(true);
  });

  it('warns on "X is an Y" pattern', () => {
    const result = validateClaim(
      'Anthropic is an AI safety company.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('tautological-definition'))).toBe(true);
  });

  it('does not flag "X is a Y" with specific data', () => {
    const result = validateClaim(
      'Anthropic is a company founded in 2021.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('tautological-definition'))).toBe(false);
  });

  it('does not flag "X is headquartered in Y"', () => {
    const result = validateClaim(
      'Anthropic is a company headquartered in San Francisco.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('tautological-definition'))).toBe(false);
  });

  it('does not flag non-definition claims', () => {
    const result = validateClaim(
      'Anthropic raised $7.3 billion in total funding.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('tautological-definition'))).toBe(false);
  });

  it('does not flag claims that do not start with entity name', () => {
    const result = validateClaim(
      'A prediction market platform, Kalshi was founded in 2018.',
      'kalshi',
      'Kalshi',
    );
    expect(result.issues.some(i => i.includes('tautological-definition'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateClaim — vague language
// ---------------------------------------------------------------------------

describe('validateClaim: vague language', () => {
  it('warns on "significant" without numbers', () => {
    const result = validateClaim(
      'Anthropic has made significant progress in AI safety.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('vague-language'))).toBe(true);
  });

  it('warns on "various" without specifics', () => {
    const result = validateClaim(
      'Anthropic has launched various products and services.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('vague-language'))).toBe(true);
  });

  it('warns on "several" without specifics', () => {
    const result = validateClaim(
      'Anthropic has hired several new researchers.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('vague-language'))).toBe(true);
  });

  it('does not warn when claim has numbers', () => {
    const result = validateClaim(
      'Anthropic has made significant progress, publishing 47 papers.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('vague-language'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateClaim — generic references
// ---------------------------------------------------------------------------

describe('validateClaim: generic references', () => {
  it('warns on "the company" usage', () => {
    // Note: this claim also mentions Anthropic, so it won't be rejected for missing-entity-name
    const result = validateClaim(
      'Anthropic said the company plans to expand globally.',
      'anthropic',
      'Anthropic',
    );
    expect(result.issues.some(i => i.includes('generic-reference'))).toBe(true);
  });

  it('warns on "the platform" usage', () => {
    const result = validateClaim(
      'Kalshi announced the platform now supports crypto contracts.',
      'kalshi',
      'Kalshi',
    );
    expect(result.issues.some(i => i.includes('generic-reference'))).toBe(true);
  });

  it('warns on "the model" usage', () => {
    const result = validateClaim(
      'GPT-4 showed that the model outperforms GPT-3 on benchmarks.',
      'gpt-4',
      'GPT-4',
    );
    expect(result.issues.some(i => i.includes('generic-reference'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateClaim — multiple issues
// ---------------------------------------------------------------------------

describe('validateClaim: multiple issues', () => {
  it('reports multiple issues simultaneously', () => {
    const result = validateClaim(
      'The company has made various improvements',
      'anthropic',
      'Anthropic',
    );
    // Should have: missing-entity-name, relative-start, generic-reference, no-terminal-punctuation, vague-language
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
    expect(result.severity).toBe('reject'); // missing-entity-name and no-terminal-punctuation are reject-level
  });
});

// ---------------------------------------------------------------------------
// validateClaim — valid claims pass cleanly
// ---------------------------------------------------------------------------

describe('validateClaim: valid claims', () => {
  it('passes a well-formed factual claim', () => {
    const result = validateClaim(
      'Anthropic raised $7.3 billion in total funding as of March 2024.',
      'anthropic',
      'Anthropic',
    );
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('passes a well-formed relational claim', () => {
    const result = validateClaim(
      'Kalshi competes with Polymarket for prediction market volume.',
      'kalshi',
      'Kalshi',
    );
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('passes a well-formed historical claim', () => {
    const result = validateClaim(
      'OpenAI was founded in December 2015 by Sam Altman and Elon Musk.',
      'openai',
      'OpenAI',
    );
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateClaimBatch — batch validation
// ---------------------------------------------------------------------------

describe('validateClaimBatch', () => {
  const claims = [
    { claimText: 'Anthropic raised $7.3 billion in funding.', claimType: 'numeric' as const },
    { claimText: 'The company plans to expand.', claimType: 'factual' as const },
    { claimText: 'Anthropic was founded in 2021 by Dario and Daniela Amodei.', claimType: 'historical' as const },
    { claimText: 'Short.', claimType: 'factual' as const },
  ];

  it('separates valid and invalid claims in non-strict mode', () => {
    const { accepted, rejected, stats } = validateClaimBatch(
      claims,
      'anthropic',
      'Anthropic',
      false,
    );
    // In non-strict, all are accepted (warnings don't filter)
    expect(accepted.length).toBe(4);
    expect(rejected.length).toBe(0);
    expect(stats.total).toBe(4);
  });

  it('rejects claims in strict mode', () => {
    const { accepted, rejected, stats } = validateClaimBatch(
      claims,
      'anthropic',
      'Anthropic',
      true,
    );
    // "The company plans to expand." lacks entity name + no period (reject)
    // "Short." is too short (reject)
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    expect(accepted.length).toBeLessThanOrEqual(2);
    expect(stats.rejected).toBeGreaterThanOrEqual(2);
  });

  it('provides issue breakdown in stats', () => {
    const { stats } = validateClaimBatch(claims, 'anthropic', 'Anthropic');
    expect(stats.issueBreakdown).toBeDefined();
    expect(typeof stats.issueBreakdown).toBe('object');
    // Should have at least 'missing-entity-name' and 'too-short'
    expect(Object.keys(stats.issueBreakdown).length).toBeGreaterThan(0);
  });

  it('handles empty input', () => {
    const { accepted, rejected, stats } = validateClaimBatch([], 'anthropic', 'Anthropic');
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(0);
    expect(stats.total).toBe(0);
  });
});
