import { describe, it, expect } from 'vitest';
import { computeMetrics, computeQuality } from './steps.ts';
import type { Ratings, Metrics } from './types.ts';

// ---------------------------------------------------------------------------
// computeMetrics — citation counting
// ---------------------------------------------------------------------------

describe('computeMetrics', () => {
  it('counts named footnotes (e.g., [^mixtral])', () => {
    const content = `---
title: Test
---

Some claim about MoE[^mixtral] and another about GPT-4[^gpt4].

[^mixtral]: Jiang et al. (2024). Mixtral of Experts.
[^gpt4]: OpenAI (2023). GPT-4 Technical Report.
`;
    const metrics = computeMetrics(content);
    // Should count 2 named footnotes (+ 0 external links in definitions)
    expect(metrics.citations).toBeGreaterThanOrEqual(2);
  });

  it('counts numeric footnotes', () => {
    const content = `---
title: Test
---

A claim[^1] and another[^2].

[^1]: Source one.
[^2]: Source two.
`;
    const metrics = computeMetrics(content);
    expect(metrics.citations).toBeGreaterThanOrEqual(2);
  });

  it('counts R components as citations', () => {
    const content = `---
title: Test
---

Some text with <R id="ref-1" /> and <R id="ref-2" />.
`;
    const metrics = computeMetrics(content);
    expect(metrics.citations).toBeGreaterThanOrEqual(2);
  });

  it('counts external links as citations', () => {
    const content = `---
title: Test
---

See [this paper](https://arxiv.org/abs/2401.04088) and [that report](https://example.com/report).
`;
    const metrics = computeMetrics(content);
    expect(metrics.citations).toBeGreaterThanOrEqual(2);
  });

  it('handles mixed citation types', () => {
    const content = `---
title: Test
---

Named footnote[^mixtral], numeric footnote[^1], <R id="ref-1" />, and [external link](https://example.com).

[^mixtral]: Source.
[^1]: Source.
`;
    const metrics = computeMetrics(content);
    // 1 named footnote + 1 numeric footnote + 1 R component + 1 external link = 4
    expect(metrics.citations).toBeGreaterThanOrEqual(4);
  });

  it('counts Mermaid diagrams', () => {
    const content = `---
title: Test
---

<Mermaid chart={\`graph TD\`} />

<Mermaid chart={\`flowchart LR\`} />
`;
    const metrics = computeMetrics(content);
    expect(metrics.diagrams).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeQuality — formula tests
// ---------------------------------------------------------------------------

describe('computeQuality', () => {
  const midRatings: Ratings = {
    focus: 5, novelty: 5, rigor: 5,
    completeness: 5, concreteness: 5,
    actionability: 5, objectivity: 5,
  };

  const highRatings: Ratings = {
    focus: 7, novelty: 7, rigor: 7,
    completeness: 7, concreteness: 7,
    actionability: 7, objectivity: 7,
  };

  const lowRatings: Ratings = {
    focus: 3, novelty: 3, rigor: 3,
    completeness: 3, concreteness: 3,
    actionability: 3, objectivity: 3,
  };

  const richMetrics: Metrics = {
    wordCount: 3000,
    citations: 20,
    tables: 10,
    diagrams: 2,
  };

  const sparseMetrics: Metrics = {
    wordCount: 200,
    citations: 0,
    tables: 0,
    diagrams: 0,
  };

  it('mid-rated page with rich structure scores above 65', () => {
    // A page with all-5 ratings, 3000 words, 20 citations, 10 tables, 2 diagrams
    // should score well above the old ceiling of ~55
    const quality = computeQuality(midRatings, richMetrics);
    expect(quality).toBeGreaterThanOrEqual(65);
  });

  it('high-rated page with rich structure scores above 80', () => {
    const quality = computeQuality(highRatings, richMetrics);
    expect(quality).toBeGreaterThanOrEqual(80);
  });

  it('low-rated sparse page scores below 40', () => {
    const quality = computeQuality(lowRatings, sparseMetrics);
    expect(quality).toBeLessThanOrEqual(40);
  });

  it('stub pages are capped at 35', () => {
    const quality = computeQuality(highRatings, richMetrics, { pageType: 'stub' });
    expect(quality).toBeLessThanOrEqual(35);
  });

  it('very short pages are capped at 40', () => {
    const shortMetrics: Metrics = { wordCount: 50, citations: 5, tables: 2, diagrams: 1 };
    const quality = computeQuality(highRatings, shortMetrics);
    expect(quality).toBeLessThanOrEqual(40);
  });

  it('tables add up to 3 bonus points', () => {
    const noTables: Metrics = { wordCount: 3000, citations: 20, tables: 0, diagrams: 0 };
    const withTables: Metrics = { wordCount: 3000, citations: 20, tables: 10, diagrams: 0 };
    const qNoTables = computeQuality(midRatings, noTables);
    const qWithTables = computeQuality(midRatings, withTables);
    expect(qWithTables - qNoTables).toBe(3);
  });

  it('diagrams add up to 2 bonus points', () => {
    const noDiagrams: Metrics = { wordCount: 3000, citations: 20, tables: 0, diagrams: 0 };
    const withDiagrams: Metrics = { wordCount: 3000, citations: 20, tables: 0, diagrams: 2 };
    const qNoDiagrams = computeQuality(midRatings, noDiagrams);
    const qWithDiagrams = computeQuality(midRatings, withDiagrams);
    expect(qWithDiagrams - qNoDiagrams).toBe(2);
  });

  it('quality is clamped to 100', () => {
    const perfectRatings: Ratings = {
      focus: 10, novelty: 10, rigor: 10,
      completeness: 10, concreteness: 10,
      actionability: 10, objectivity: 10,
    };
    const quality = computeQuality(perfectRatings, richMetrics);
    expect(quality).toBeLessThanOrEqual(100);
  });

  it('analysis content type adjusts weights', () => {
    // Analysis weights novelty 1.5x vs reference 0.8x
    const highNovelty: Ratings = {
      focus: 5, novelty: 9, rigor: 5,
      completeness: 5, concreteness: 5,
      actionability: 5, objectivity: 5,
    };
    const analysisQ = computeQuality(highNovelty, richMetrics, { contentType: 'analysis' });
    const referenceQ = computeQuality(highNovelty, richMetrics);
    // Analysis should score higher because novelty is weighted 1.5x vs 0.8x
    expect(analysisQ).toBeGreaterThan(referenceQ);
  });
});
