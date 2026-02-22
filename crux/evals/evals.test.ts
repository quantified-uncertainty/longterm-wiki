/**
 * Tests for the hallucination detection eval framework.
 *
 * Covers:
 * - Error injectors (wrong numbers, fabricated citations, exaggerations, missing nuance, fabricated claims)
 * - Scoring (matching findings to injected errors, precision/recall)
 * - Cross-reference checker (contradiction detection)
 * - Reference sniffer (claim extraction)
 * - Eval harness (inject → detect → score pipeline)
 *
 * All tests are deterministic — no LLM or network calls.
 */

import { describe, it, expect } from 'vitest';
import { injectWrongNumbers } from './injectors/wrong-numbers.ts';
import { injectFabricatedCitations } from './injectors/fabricated-citations.ts';
import { injectExaggerations } from './injectors/exaggerations.ts';
import { injectMissingNuance } from './injectors/missing-nuance.ts';
import { injectFabricatedClaims } from './injectors/fabricated-claims.ts';
import { matchFindings, computeScores, formatScoreReport } from './score.ts';
import { extractClaims } from './agents/reference-sniffer.ts';
import { extractFacts } from './agents/cross-reference-checker.ts';
import type { InjectedError, DetectorFinding } from './types.ts';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ORG_PAGE = `---
title: Example AI Lab
description: A fictional AI safety organization for testing.
entityId: example-ai-lab
---

## Overview

Example AI Lab was founded in 2021 by Dr. Alice Smith and Dr. Bob Jones in San Francisco. The organization focuses on alignment research and has grown to approximately 150 employees as of 2024.

## Funding

The lab raised \\$100 million in Series A funding in 2022, followed by a \\$500 million Series B in 2023. According to some estimates, total funding reached \\$650 million by early 2024.

Several researchers have suggested that the lab's approach to alignment may help address the core challenges of value alignment.[^1]

## Research Focus

The lab has been partially successful in developing interpretability tools. Their flagship project, launched in 2023, contributed to advances in mechanistic interpretability.

One of the leading organizations in the interpretability space, Example AI Lab publishes approximately 25 papers per year.[^2]

## Key People

- **Dr. Alice Smith** — Co-founder and CEO, previously at DeepMind
- **Dr. Bob Jones** — Co-founder and CTO, PhD from MIT (2018)

[^1]: [Alignment Research Overview](https://example.com/alignment-research)
[^2]: [Lab Publication Record](https://example.com/publications)
`;

const SAMPLE_PERSON_PAGE = `---
title: Dr. Alice Smith
description: Co-founder and CEO of Example AI Lab.
entityId: alice-smith
---

## Overview

Dr. Alice Smith is an AI safety researcher who co-founded Example AI Lab in 2021. She previously worked at DeepMind from 2017 to 2020.

## Career

Smith received her PhD from Stanford in 2015. She joined DeepMind in 2017, where she led a team of 12 researchers working on reward modeling.[^1]

In 2021, she left DeepMind to co-found Example AI Lab with Bob Jones, securing \\$100 million in initial funding.[^2]

[^1]: [Smith Bio](https://example.com/smith-bio)
[^2]: [Lab Founding](https://example.com/founding)
`;

// ---------------------------------------------------------------------------
// Wrong number injection tests
// ---------------------------------------------------------------------------

describe('injectWrongNumbers', () => {
  it('finds and corrupts numeric facts', async () => {
    const result = await injectWrongNumbers(SAMPLE_ORG_PAGE, 2, false);

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.length).toBeLessThanOrEqual(2);
    expect(result.content).not.toBe(SAMPLE_ORG_PAGE);

    for (const error of result.errors) {
      expect(error.category).toBe('wrong-number');
      expect(error.originalText).toBeTruthy();
      expect(error.corruptedText).toBeTruthy();
      expect(error.originalText).not.toBe(error.corruptedText);
    }
  });

  it('returns unchanged content when no numbers found', async () => {
    const noNumbers = `---
title: Test
---

This page has no numbers at all. Just text.
`;
    const result = await injectWrongNumbers(noNumbers, 2, false);
    expect(result.errors).toHaveLength(0);
    expect(result.content).toBe(noNumbers);
  });

  it('respects the count parameter', async () => {
    const result = await injectWrongNumbers(SAMPLE_ORG_PAGE, 1, false);
    expect(result.errors.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Fabricated citation injection tests
// ---------------------------------------------------------------------------

describe('injectFabricatedCitations', () => {
  it('replaces citation URLs with fake ones', async () => {
    const result = await injectFabricatedCitations(SAMPLE_ORG_PAGE, 1, false);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].category).toBe('fabricated-citation');
    expect(result.content).not.toBe(SAMPLE_ORG_PAGE);

    // The fake URL should be in the content
    expect(result.content).not.toContain(result.errors[0].originalText);
    expect(result.content).toContain(result.errors[0].corruptedText);
  });

  it('handles pages with no citations', async () => {
    const noCitations = `---
title: Test
---

No citations here.
`;
    const result = await injectFabricatedCitations(noCitations, 1, false);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Exaggeration injection tests
// ---------------------------------------------------------------------------

describe('injectExaggerations', () => {
  it('finds and exaggerates hedged claims', async () => {
    const result = await injectExaggerations(SAMPLE_ORG_PAGE, 2, false);

    // The sample page has several hedged phrases that should be matchable
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    for (const error of result.errors) {
      expect(error.category).toBe('exaggeration');
      expect(error.originalText).toBeTruthy();
      expect(error.corruptedText).toBeTruthy();
    }
  });

  it('returns unchanged content when no hedged claims found', async () => {
    const noHedging = `---
title: Test
---

The sky is blue. Water is wet.
`;
    const result = await injectExaggerations(noHedging, 2, false);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing nuance injection tests
// ---------------------------------------------------------------------------

describe('injectMissingNuance', () => {
  it('removes hedging language', async () => {
    const result = await injectMissingNuance(SAMPLE_ORG_PAGE, 2, false);

    // The sample has "According to some estimates" and "approximately"
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    for (const error of result.errors) {
      expect(error.category).toBe('missing-nuance');
    }
  });
});

// ---------------------------------------------------------------------------
// Fabricated claims injection tests
// ---------------------------------------------------------------------------

describe('injectFabricatedClaims', () => {
  it('inserts fabricated claims with existing footnote refs', async () => {
    const result = await injectFabricatedClaims(SAMPLE_ORG_PAGE, 1, false);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].category).toBe('fabricated-claim');
    // Corrupted content should be longer (we added text)
    expect(result.content.length).toBeGreaterThan(SAMPLE_ORG_PAGE.length);
    // The fabricated text should contain a footnote reference
    expect(result.errors[0].corruptedText).toMatch(/\[\^\d+\]/);
  });
});

// ---------------------------------------------------------------------------
// Scoring tests
// ---------------------------------------------------------------------------

describe('matchFindings', () => {
  it('matches findings to errors by paragraph proximity', () => {
    const errors: InjectedError[] = [
      {
        id: 'err-1',
        category: 'wrong-number',
        description: 'Changed year',
        originalText: 'founded in 2021',
        corruptedText: 'founded in 2019',
        paragraphIndex: 2,
        detectability: 'easy',
      },
    ];

    const findings: DetectorFinding[] = [
      {
        detector: 'content-integrity',
        description: 'Suspicious date near paragraph 2',
        paragraphIndex: 3, // Within proximity threshold
      },
    ];

    const result = matchFindings(errors, findings);
    expect(result.matches[0].caught).toBe(true);
    expect(result.matches[0].caughtBy).toContain('content-integrity');
  });

  it('matches findings by text overlap', () => {
    const errors: InjectedError[] = [
      {
        id: 'err-1',
        category: 'exaggeration',
        description: '"contributed to" → "led"',
        originalText: 'contributed to advances in mechanistic interpretability',
        corruptedText: 'led advances in mechanistic interpretability',
        paragraphIndex: 5,
        detectability: 'medium',
      },
    ];

    const findings: DetectorFinding[] = [
      {
        detector: 'adversarial-review',
        description: 'Claim about leading advances in mechanistic interpretability lacks citation',
        flaggedText: 'led advances in mechanistic interpretability',
        paragraphIndex: 10, // Far away in paragraph, but text matches
      },
    ];

    const result = matchFindings(errors, findings);
    expect(result.matches[0].caught).toBe(true);
  });

  it('does not match unrelated findings', () => {
    const errors: InjectedError[] = [
      {
        id: 'err-1',
        category: 'wrong-number',
        description: 'Changed year',
        originalText: 'founded in 2021',
        corruptedText: 'founded in 2019',
        paragraphIndex: 2,
        detectability: 'easy',
      },
    ];

    const findings: DetectorFinding[] = [
      {
        detector: 'content-integrity',
        description: 'Orphaned footnote [^5]',
        paragraphIndex: 20,
      },
    ];

    const result = matchFindings(errors, findings);
    expect(result.matches[0].caught).toBe(false);
  });
});

describe('computeScores', () => {
  it('computes perfect scores when all errors caught', () => {
    const errors: InjectedError[] = [
      { id: '1', category: 'wrong-number', description: '', originalText: '', corruptedText: '', paragraphIndex: 0, detectability: 'easy' },
      { id: '2', category: 'exaggeration', description: '', originalText: '', corruptedText: '', paragraphIndex: 1, detectability: 'easy' },
    ];

    const findings: DetectorFinding[] = [
      { detector: 'content-integrity', description: 'A', paragraphIndex: 0 },
      { detector: 'adversarial-review', description: 'B', paragraphIndex: 1 },
    ];

    const { matches, truePositiveFindings } = matchFindings(errors, findings);
    const scores = computeScores(matches, findings, truePositiveFindings.size);

    expect(scores.recall).toBe(1);
    expect(scores.precision).toBe(1);
    expect(scores.f1).toBe(1);
  });

  it('computes zero recall when no errors caught', () => {
    const errors: InjectedError[] = [
      { id: '1', category: 'wrong-number', description: '', originalText: '', corruptedText: '', paragraphIndex: 0, detectability: 'easy' },
    ];

    const findings: DetectorFinding[] = [
      { detector: 'content-integrity', description: 'Unrelated', paragraphIndex: 50 },
    ];

    const { matches, truePositiveFindings } = matchFindings(errors, findings);
    const scores = computeScores(matches, findings, truePositiveFindings.size);

    expect(scores.recall).toBe(0);
    expect(scores.precision).toBe(0);
    expect(scores.falsePositives).toBe(1);
  });

  it('computes category breakdown', () => {
    const errors: InjectedError[] = [
      { id: '1', category: 'wrong-number', description: '', originalText: '', corruptedText: '', paragraphIndex: 0, detectability: 'easy' },
      { id: '2', category: 'wrong-number', description: '', originalText: '', corruptedText: '', paragraphIndex: 1, detectability: 'easy' },
      { id: '3', category: 'exaggeration', description: '', originalText: '', corruptedText: '', paragraphIndex: 20, detectability: 'easy' },
    ];

    const findings: DetectorFinding[] = [
      { detector: 'content-integrity', description: 'A', paragraphIndex: 0 },
      { detector: 'content-integrity', description: 'B', paragraphIndex: 1 },
    ];

    const { matches, truePositiveFindings } = matchFindings(errors, findings);
    const scores = computeScores(matches, findings, truePositiveFindings.size);

    expect(scores.byCategory['wrong-number'].recall).toBe(1); // 2/2
    expect(scores.byCategory['exaggeration'].recall).toBe(0); // 0/1
  });
});

describe('formatScoreReport', () => {
  it('produces readable markdown', () => {
    const scores = computeScores(
      [{ error: { id: '1', category: 'wrong-number', description: '', originalText: '', corruptedText: '', paragraphIndex: 0, detectability: 'easy' as const }, caught: true, caughtBy: ['content-integrity'], matchingFindings: [] }],
      [{ detector: 'content-integrity' as const, description: 'A' }],
      1,
    );

    const report = formatScoreReport(scores, 'test-page');
    expect(report).toContain('test-page');
    expect(report).toContain('Recall');
    expect(report).toContain('Precision');
    expect(report).toContain('wrong-number');
  });
});

// ---------------------------------------------------------------------------
// Claim extraction tests (reference sniffer)
// ---------------------------------------------------------------------------

describe('extractClaims', () => {
  it('extracts factual claims from wiki content', () => {
    const claims = extractClaims(SAMPLE_ORG_PAGE);

    expect(claims.length).toBeGreaterThan(0);

    // Should find claims with years and dollar amounts
    const yearClaims = claims.filter(c => /\b20\d{2}\b/.test(c.claim));
    expect(yearClaims.length).toBeGreaterThan(0);

    const dollarClaims = claims.filter(c => /\$/.test(c.claim));
    expect(dollarClaims.length).toBeGreaterThan(0);
  });

  it('identifies uncited factual claims', () => {
    const claims = extractClaims(SAMPLE_ORG_PAGE);
    const uncited = claims.filter(c => !c.hasAnyCitation);

    // Some claims should be uncited (overview section has no footnotes)
    expect(uncited.length).toBeGreaterThan(0);
  });

  it('tracks which footnotes are cited', () => {
    const claims = extractClaims(SAMPLE_ORG_PAGE);
    const cited = claims.filter(c => c.hasAnyCitation);

    // Claims near footnote references should have citations
    for (const claim of cited) {
      expect(claim.citedFootnotes.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-reference checker tests
// ---------------------------------------------------------------------------

describe('extractFacts', () => {
  it('extracts founding year facts', () => {
    const facts = extractFacts('example-ai-lab', SAMPLE_ORG_PAGE);

    const foundingFacts = facts.filter(f => f.factType === 'founding-year');
    expect(foundingFacts.length).toBeGreaterThan(0);
    expect(foundingFacts[0].value).toBe('2021');
  });

  it('extracts funding facts', () => {
    const facts = extractFacts('example-ai-lab', SAMPLE_ORG_PAGE);

    const fundingFacts = facts.filter(f => f.factType === 'funding');
    expect(fundingFacts.length).toBeGreaterThan(0);
  });

  it('extracts employee count facts', () => {
    const facts = extractFacts('example-ai-lab', SAMPLE_ORG_PAGE);

    const headcountFacts = facts.filter(f => f.factType === 'employee-count');
    // "approximately 150 employees" should be found
    expect(headcountFacts.length).toBeGreaterThan(0);
  });

  it('detects cross-page contradictions', async () => {
    // Create two pages with contradictory founding dates
    const pageA = `---
title: Example Lab
---

Example AI Lab was founded in 2021 by Dr. Smith.
`;
    const pageB = `---
title: Dr. Smith
---

Smith co-founded Example AI Lab established in 2020.
`;

    const factsA = extractFacts('page-a', pageA);
    const factsB = extractFacts('page-b', pageB);

    // Both should find founding year facts for Example AI Lab
    const allFacts = [...factsA, ...factsB];
    const labFacts = allFacts.filter(
      f => f.factType === 'founding-year' && f.entityMention.toLowerCase().includes('example')
    );

    expect(labFacts.length).toBe(2);
    // Values should differ (2021 vs 2020) — this is a contradiction
    const values = new Set(labFacts.map(f => f.value));
    expect(values.size).toBe(2);
  });
});
