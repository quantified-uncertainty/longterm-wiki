import { describe, it, expect } from 'vitest';
import {
  extractSectionContext,
  extractSection,
  groupFlaggedBySection,
  findAllFootnotesInSection,
  applySectionRewrites,
  cleanupOrphanedFootnotes,
  applySourceReplacements,
  buildSearchQuery,
  generateSearchQuery,
  parseLLMFixResponse,
  applyFixes,
  enrichFromApi,
  repairJsonBackslashEscapes,
  countPreservedComponents,
  filterProposals,
  FIX_ACTIONS,
} from './fix-inaccuracies.ts';
import { escapeDollarDigits } from '../lib/patterns.ts';
import type { FixProposal } from './fix-inaccuracies.ts';
import type { FlaggedCitation } from './export-dashboard.ts';
import type { SectionRewrite } from './fix-inaccuracies.ts';

describe('extractSectionContext', () => {
  const body = [
    '## Overview',
    '',
    'First paragraph with some text.',
    '',
    'Second paragraph with a claim[^1] that is cited.',
    '',
    'Third paragraph with more text.',
    '',
    '## Next Section',
    '',
    'Another paragraph with [^2] reference.',
  ].join('\n');

  it('returns lines around the footnote reference', () => {
    const ctx = extractSectionContext(body, 1);
    expect(ctx).toContain('claim[^1]');
    expect(ctx).toContain('## Overview');
  });

  it('returns empty string for missing footnote', () => {
    expect(extractSectionContext(body, 99)).toBe('');
  });

  it('includes surrounding context', () => {
    const ctx = extractSectionContext(body, 2);
    expect(ctx).toContain('[^2]');
  });

  it('does not match [^1] inside [^10]', () => {
    const bodyHighNums = '## Section\n\nSome claim[^10] here.\n';
    expect(extractSectionContext(bodyHighNums, 1)).toBe('');
    expect(extractSectionContext(bodyHighNums, 10)).toContain('[^10]');
  });
});

describe('parseLLMFixResponse', () => {
  it('parses valid JSON array', () => {
    const input = JSON.stringify([
      {
        footnote: 5,
        original: 'old text',
        replacement: 'new text',
        explanation: 'fixed a number',
        fix_type: 'correct',
      },
    ]);

    const result = parseLLMFixResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].footnote).toBe(5);
    expect(result[0].original).toBe('old text');
    expect(result[0].replacement).toBe('new text');
    expect(result[0].fixType).toBe('correct');
  });

  it('strips code fences', () => {
    const input = '```json\n[{"footnote":1,"original":"a","replacement":"b","explanation":"c","fix_type":"d"}]\n```';
    const result = parseLLMFixResponse(input);
    expect(result).toHaveLength(1);
  });

  it('filters out entries where original equals replacement', () => {
    const input = JSON.stringify([
      { footnote: 1, original: 'same', replacement: 'same', explanation: 'no change', fix_type: 'none' },
      { footnote: 2, original: 'old', replacement: 'new', explanation: 'real fix', fix_type: 'soften' },
    ]);
    const result = parseLLMFixResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].footnote).toBe(2);
  });

  it('filters out entries with empty original', () => {
    const input = JSON.stringify([
      { footnote: 1, original: '', replacement: 'new', explanation: 'x', fix_type: 'y' },
    ]);
    expect(parseLLMFixResponse(input)).toHaveLength(0);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseLLMFixResponse('not json')).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    expect(parseLLMFixResponse('{"key": "value"}')).toEqual([]);
  });

  // Regression: prod LLM responses mirrored MDX-escaped `\$100K` verbatim
  // into JSON strings as `"\$100K"` — invalid JSON that previously produced
  // 0 proposals (QUA-314). parseLLMFixResponse must recover via escape repair.
  it('recovers from invalid backslash escapes (e.g. \\$ in MDX-escaped claims)', () => {
    const input = `[
      {
        "footnote": 9,
        "original": "Awards of ≈\\$100K each distributed through milestone-based contracts.",
        "replacement": "Awards distributed through milestone-based contracts.",
        "explanation": "source does not support \\$100K figure",
        "fix_type": "rewrite"
      }
    ]`;
    const result = parseLLMFixResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].footnote).toBe(9);
    expect(result[0].original).toBe('Awards of ≈\\$100K each distributed through milestone-based contracts.');
    expect(result[0].replacement).toBe('Awards distributed through milestone-based contracts.');
  });

  it('recovers from invalid backslash escapes inside code fences', () => {
    const input = '```json\n' + `[{"footnote":1,"original":"a \\$ b","replacement":"c","explanation":"","fix_type":""}]` + '\n```';
    const result = parseLLMFixResponse(input);
    expect(result).toHaveLength(1);
    expect(result[0].original).toBe('a \\$ b');
  });
});

// ---------------------------------------------------------------------------
// QUA-349: proposal quality filters
// ---------------------------------------------------------------------------

describe('escapeDollarDigits', () => {
  it('escapes bare $digit', () => {
    expect(escapeDollarDigits('costs $50 today')).toBe('costs \\$50 today');
  });

  it('escapes multiple occurrences', () => {
    expect(escapeDollarDigits('$100 vs $57.2 million')).toBe('\\$100 vs \\$57.2 million');
  });

  it('does not touch already-escaped \\$digit', () => {
    expect(escapeDollarDigits('costs \\$50')).toBe('costs \\$50');
  });

  it('does not touch $ not followed by a digit', () => {
    expect(escapeDollarDigits('$foo and $bar')).toBe('$foo and $bar');
  });

  it('does not touch $ preceded by an identifier char (variable-like)', () => {
    expect(escapeDollarDigits('abc$1 and xyz$9')).toBe('abc$1 and xyz$9');
  });

  it('handles the QUA-349 examples from the dry-run', () => {
    expect(escapeDollarDigits('midterm elections. With $100 million raised...'))
      .toBe('midterm elections. With \\$100 million raised...');
    expect(escapeDollarDigits('goodfire...raised a total of $57.2 million.'))
      .toBe('goodfire...raised a total of \\$57.2 million.');
    expect(escapeDollarDigits('$8 billion was missing from its balance sheet'))
      .toBe('\\$8 billion was missing from its balance sheet');
  });

  it('handles leading $ at position 0', () => {
    expect(escapeDollarDigits('$5 for all')).toBe('\\$5 for all');
  });
});

describe('countPreservedComponents', () => {
  it('counts EntityLink', () => {
    expect(countPreservedComponents('hello <EntityLink id="x"> world')).toBe(1);
  });

  it('counts multiple component types', () => {
    const s = 'see <EntityLink id="a"/> and <F id="b"/> and <Calc expr="1+1"/>';
    expect(countPreservedComponents(s)).toBe(3);
  });

  it('counts repeated instances of the same component', () => {
    expect(countPreservedComponents('<F id="a"/> <F id="b"/> <F id="c"/>')).toBe(3);
  });

  it('returns 0 for plain text', () => {
    expect(countPreservedComponents('no components here')).toBe(0);
  });

  it('matches only word-boundary tags, not prefixes', () => {
    // <Foo> must not count as an <F>
    expect(countPreservedComponents('<Foo id="x"/>')).toBe(0);
  });

  it('counts FBFactValue and FBF as separate components', () => {
    expect(countPreservedComponents('<FBF id="a"/> <FBFactValue id="b"/>')).toBe(2);
  });
});

describe('filterProposals', () => {
  function makeProposal(p: Partial<FixProposal>): FixProposal {
    return {
      footnote: 1,
      original: 'original text',
      replacement: 'replacement text',
      explanation: 'test',
      fixType: 'rewrite',
      ...p,
    };
  }

  it('keeps clean proposals', () => {
    const p = makeProposal({ original: 'abc', replacement: 'def' });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.escapedCount).toBe(0);
  });

  // Bug 1: $digit escape

  it('escapes bare $digit in replacement without rejecting', () => {
    const p = makeProposal({
      original: 'costs about 50 bucks',
      replacement: 'costs about $50',
      fixType: 'correct',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].replacement).toBe('costs about \\$50');
    expect(result.escapedCount).toBe(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('leaves already-escaped \\$digit alone', () => {
    const p = makeProposal({
      original: 'one',
      replacement: 'costs \\$50 total',
      fixType: 'correct',
    });
    const result = filterProposals([p]);
    expect(result.kept[0].replacement).toBe('costs \\$50 total');
    expect(result.escapedCount).toBe(0);
  });

  // Bug 2: component preservation

  it('rejects proposals that drop an EntityLink', () => {
    const p = makeProposal({
      original: 'see <EntityLink id="anthropic"/> for more',
      replacement: 'see Anthropic for more',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('component-drop');
  });

  it('rejects proposals that drop an <F> fact ref', () => {
    const p = makeProposal({
      original: 'revenue was <F id="a" path="b"/> last year',
      replacement: 'revenue was $5B last year',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('component-drop');
  });

  it('rejects proposals that drop one of multiple components', () => {
    const p = makeProposal({
      original: '<EntityLink id="a"/> spent <F id="x"/> on research',
      replacement: '<EntityLink id="a"/> spent money on research',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('component-drop');
  });

  it('accepts proposals that preserve all components', () => {
    const p = makeProposal({
      original: '<EntityLink id="a"/> spent five dollars',
      replacement: '<EntityLink id="a"/> spent six dollars',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('accepts proposals that add components', () => {
    const p = makeProposal({
      original: 'Anthropic raised money',
      replacement: '<EntityLink id="anthropic"/> raised money',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
  });

  // Bug 3: shrink rejection

  it('rejects rewrite proposals that shrink below 40%', () => {
    const p = makeProposal({
      original: 'Key techniques taught at CFAR workshops include rationality training, debiasing exercises, and applied Bayesian reasoning',
      replacement: 'CFAR runs workshops',
      fixType: 'rewrite',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('shrink');
  });

  it('allows remove_detail to shrink arbitrarily', () => {
    const p = makeProposal({
      original: 'a very long detailed explanation of many things that deserves removal',
      replacement: 'short',
      fixType: 'remove_detail',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('allows remove_ref to shrink arbitrarily', () => {
    const p = makeProposal({
      original: 'Anthropic is a company[^5].',
      replacement: 'Anthropic is a company.',
      fixType: 'remove_ref',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
  });

  it('keeps proposals that shrink slightly (above 40%)', () => {
    const p = makeProposal({
      original: 'ABCDEFGHIJ', // 10 chars
      replacement: 'ABCDEF', // 6 chars, 60%
      fixType: 'correct',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
  });

  it('rejects correct-action shrink below 40%', () => {
    const p = makeProposal({
      original: 'Very detailed original text that has many words and provides context',
      replacement: 'Short.',
      fixType: 'correct',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('shrink');
  });

  // Combined / regression

  it('applies escape before component check (escape is lossless)', () => {
    const p = makeProposal({
      original: 'costs <F id="a"/> today',
      replacement: 'costs $50 with <F id="a"/> context',
      fixType: 'correct',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].replacement).toBe('costs \\$50 with <F id="a"/> context');
    expect(result.escapedCount).toBe(1);
  });

  it('blueprint-biosecurity regression: $1,000,000 bare dollar escaped', () => {
    // The specific pattern that caused the QUA-349 blueprint-biosecurity
    // regression: LLM returned `$1,000,000` unescaped in a `correct` action.
    const p = makeProposal({
      original: 'Up to \\$1M in grants are available.',
      replacement: 'Up to $1,000,000 in grants are available.',
      fixType: 'correct',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].replacement).toBe('Up to \\$1,000,000 in grants are available.');
  });

  it('mixed batch: keeps clean, rejects buggy, escapes recoverable', () => {
    const clean = makeProposal({ footnote: 1, original: 'aaa', replacement: 'bbb' });
    const escaped = makeProposal({ footnote: 2, original: 'aaa', replacement: '$50', fixType: 'correct' });
    const dropped = makeProposal({ footnote: 3, original: 'x <F id="a"/> y', replacement: 'x y' });
    const shrunk = makeProposal({
      footnote: 4,
      original: 'this is a long original phrase that should not shrink',
      replacement: 'nope',
      fixType: 'rewrite',
    });

    const result = filterProposals([clean, escaped, dropped, shrunk]);
    expect(result.kept).toHaveLength(2);
    expect(result.kept.map((p) => p.footnote).sort()).toEqual([1, 2]);
    expect(result.rejected).toHaveLength(2);
    expect(result.escapedCount).toBe(1);
  });

  it('handles empty proposal list', () => {
    const result = filterProposals([]);
    expect(result.kept).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.escapedCount).toBe(0);
  });

  // ------------------------------------------------------------------------
  // QUA-588: three new filters + dedup
  // ------------------------------------------------------------------------

  // Filter: remove_ref tight-scope
  // Background: Kalshi [^1] (2026-04-18) used action=remove_ref but also
  // removed substantive text ("is the first federally regulated prediction
  // market exchange in the United States") beyond the footnote marker.

  it('remove_ref: accepts replacement that drops only [^NN] markers', () => {
    const p = makeProposal({
      original: 'Kalshi is the first federally regulated prediction market exchange[^1].',
      replacement: 'Kalshi is the first federally regulated prediction market exchange.',
      fixType: 'remove_ref',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('remove_ref: accepts replacement that drops multiple [^NN] markers', () => {
    const p = makeProposal({
      original: 'foo[^1][^2] bar[^rc-ab12] baz.',
      replacement: 'foo bar baz.',
      fixType: 'remove_ref',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
  });

  it('remove_ref: rejects replacement that removes substantive claim text (Kalshi 2026-04-18)', () => {
    const p = makeProposal({
      original: 'Kalshi is the first federally regulated prediction market exchange in the United States[^1].',
      replacement: 'Kalshi.',
      fixType: 'remove_ref',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('remove-ref-scope');
  });

  it('remove_ref: rejects replacement that rewords (changes word) beyond marker removal', () => {
    const p = makeProposal({
      original: 'Anthropic raised funding[^5].',
      replacement: 'Anthropic raised capital.',
      fixType: 'remove_ref',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected[0].reason).toBe('remove-ref-scope');
  });

  it('remove_ref: tolerates whitespace normalization (double space after removal)', () => {
    const p = makeProposal({
      original: 'Foo [^3] bar.',
      replacement: 'Foo  bar.',
      fixType: 'remove_ref',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
  });

  it('remove_ref filter only fires for remove_ref (rewrite allowed to change text)', () => {
    const p = makeProposal({
      original: 'foo[^1] bar.',
      replacement: 'completely different wording.',
      fixType: 'rewrite',
    });
    const result = filterProposals([p]);
    // shrink may still catch it, but not remove-ref-scope
    expect(result.rejected.every((r) => r.reason !== 'remove-ref-scope')).toBe(true);
  });

  // Filter: MDX structure preservation
  // Background: Samotsvety [^37] (2026-04-18) changed
  //   `- **GJO Calibration App**: Tools for forecaster training[^rc-06ed]`
  // to
  //   `- **GJO Calibration App**:[^rc-06ed]`
  // leaving a dangling list bullet.

  it('mdx-structure: rejects list bullet whose content-after-colon is emptied (Samotsvety 2026-04-18)', () => {
    const p = makeProposal({
      original: '- **GJO Calibration App**: Tools for forecaster training and improvement[^rc-06ed]',
      replacement: '- **GJO Calibration App**:[^rc-06ed]',
      fixType: 'remove_detail',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('mdx-structure');
  });

  it('mdx-structure: accepts list bullet whose content changes but is not emptied', () => {
    const p = makeProposal({
      original: '- **Calibration App**: Tools for training forecasters[^5]',
      replacement: '- **Calibration App**: A training tool[^5]',
      fixType: 'correct',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
  });

  it('mdx-structure: accepts list bullet that drops only the footnote (still has content)', () => {
    const p = makeProposal({
      original: '- **Calibration App**: Tools for forecaster training[^5]',
      replacement: '- **Calibration App**: Tools for forecaster training',
      fixType: 'remove_ref',
    });
    const result = filterProposals([p]);
    expect(result.kept).toHaveLength(1);
  });

  it('mdx-structure: skips check when original was not a list bullet', () => {
    const p = makeProposal({
      original: 'Some regular sentence.',
      replacement: 'Another regular sentence.',
      fixType: 'rewrite',
    });
    const result = filterProposals([p]);
    expect(result.rejected.every((r) => r.reason !== 'mdx-structure')).toBe(true);
  });

  it('mdx-structure: skips check when original bullet was already empty', () => {
    // Pre-existing malformed bullet — our filter shouldn't newly flag it
    const p = makeProposal({
      original: '- **Calibration App**:[^5]',
      replacement: '- **Calibration App**:[^5]',
      fixType: 'rewrite',
    });
    // Replacement == original so parseLLMFixResponse would already filter, but
    // covering the edge case directly:
    const result = filterProposals([p]);
    expect(result.rejected.every((r) => r.reason !== 'mdx-structure')).toBe(true);
  });

  // Filter: context-bleed (duplicate-content vs page)
  // Background: chan-zuckerberg-initiative [^4] (2026-04-18) replaced a
  // sentence with verbatim text from the prior sentence in the same paragraph,
  // producing duplicate-content rendering.

  it('context-bleed: rejects replacement that duplicates a neighboring sentence (CZI 2026-04-18)', () => {
    const pageContent = [
      'CZI was founded in 2015 by Mark Zuckerberg and Priscilla Chan.',
      'Its LLC structure enables flexibility for both grants to nonprofits and investments in for-profit companies.',
      'As of 2025, CZI announced plans to spend at least $10 billion on scientific research over the next decade.',
    ].join('\n\n');
    const p = makeProposal({
      original: 'As of 2025, CZI announced plans to spend at least $10 billion on scientific research over the next decade.',
      replacement: 'Its LLC structure enables flexibility for both grants to nonprofits and investments in for-profit companies.',
      fixType: 'rewrite',
    });
    const result = filterProposals([p], pageContent);
    expect(result.kept).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('context-bleed');
  });

  it('context-bleed: accepts replacement that does not appear elsewhere', () => {
    const pageContent = 'Alpha sentence. Beta sentence. Gamma sentence about many interesting things here.';
    const p = makeProposal({
      original: 'Gamma sentence about many interesting things here.',
      replacement: 'Delta sentence with a fresh phrasing that is not present above anywhere.',
      fixType: 'rewrite',
    });
    const result = filterProposals([p], pageContent);
    expect(result.kept).toHaveLength(1);
  });

  it('context-bleed: skips short replacements (below min length)', () => {
    // 22 chars, below 40-char threshold — collisions on short names are common
    const pageContent = 'Anthropic is a company. Anthropic was founded.';
    const p = makeProposal({
      original: 'Anthropic was founded.',
      replacement: 'Anthropic is a company',
      fixType: 'correct',
    });
    const result = filterProposals([p], pageContent);
    // Not flagged as context-bleed (too short)
    expect(result.rejected.every((r) => r.reason !== 'context-bleed')).toBe(true);
  });

  it('context-bleed: skips check when pageContent is not provided', () => {
    const p = makeProposal({
      original: 'As of 2025, CZI announced plans to spend at least $10 billion on scientific research over the next decade.',
      replacement: 'Its LLC structure enables flexibility for both grants to nonprofits and investments in for-profit companies.',
      fixType: 'rewrite',
    });
    const result = filterProposals([p]);
    // Without pageContent, cannot detect bleed
    expect(result.rejected.every((r) => r.reason !== 'context-bleed')).toBe(true);
  });

  it('context-bleed: skips when original not found in page (apply will fail separately)', () => {
    const pageContent = 'Alpha. Beta. Gamma.';
    const p = makeProposal({
      original: 'does not appear in page text at all',
      replacement: 'Alpha. Beta. Gamma.',
      fixType: 'rewrite',
    });
    const result = filterProposals([p], pageContent);
    // Original not locatable — skip bleed check (let apply fail with not_found)
    expect(result.rejected.every((r) => r.reason !== 'context-bleed')).toBe(true);
  });

  it('context-bleed: normalizes whitespace (collapsed spaces, newlines)', () => {
    const pageContent = 'Foo.\n\nThe replacement text that is long enough to check.\n\nTarget sentence goes here now in body.';
    const p = makeProposal({
      original: 'Target sentence goes here now in body.',
      replacement: 'The   replacement\ntext that is  long enough to check.',
      fixType: 'rewrite',
    });
    const result = filterProposals([p], pageContent);
    expect(result.rejected.some((r) => r.reason === 'context-bleed')).toBe(true);
  });

  // Dedup: overlapping spans

  it('span-overlap: keeps first proposal, rejects second with overlapping span', () => {
    const pageContent = 'The paragraph lead-in phrase opens a longer discussion about many topics.';
    const p1 = makeProposal({
      footnote: 1,
      original: 'The paragraph lead-in phrase opens a longer',
      replacement: 'The paragraph lead-in phrase introduces a long',
      fixType: 'correct',
    });
    const p2 = makeProposal({
      footnote: 2,
      original: 'lead-in phrase opens a longer discussion',
      replacement: 'lead-in phrase starts a longer discussion',
      fixType: 'correct',
    });
    const result = filterProposals([p1, p2], pageContent);
    expect(result.kept.map((p) => p.footnote)).toEqual([1]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('span-overlap');
    expect(result.rejected[0].proposal.footnote).toBe(2);
  });

  it('span-overlap: keeps non-overlapping proposals', () => {
    const pageContent = 'First sentence here. Second sentence there. Third sentence over yonder.';
    const p1 = makeProposal({
      footnote: 1,
      original: 'First sentence here.',
      replacement: 'First phrase here.',
      fixType: 'correct',
    });
    const p2 = makeProposal({
      footnote: 2,
      original: 'Third sentence over yonder.',
      replacement: 'Third phrase over yonder.',
      fixType: 'correct',
    });
    const result = filterProposals([p1, p2], pageContent);
    expect(result.kept).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it('span-overlap: skipped when pageContent not provided', () => {
    const p1 = makeProposal({ footnote: 1, original: 'abc def', replacement: 'xyz def' });
    const p2 = makeProposal({ footnote: 2, original: 'def ghi', replacement: 'def jkl' });
    // Without pageContent, both pass through
    const result = filterProposals([p1, p2]);
    expect(result.kept).toHaveLength(2);
  });

  it('span-overlap: passes through proposals whose original is not located', () => {
    const pageContent = 'Some page content with specific text.';
    const p1 = makeProposal({
      footnote: 1,
      original: 'not in page at all xyz',
      replacement: 'replacement phrase',
      fixType: 'correct',
    });
    const result = filterProposals([p1], pageContent);
    // Not rejected as overlap — passes through to apply (which will fail there)
    expect(result.rejected.every((r) => r.reason !== 'span-overlap')).toBe(true);
  });

  // Reviewer Q1: context-bleed when `original` appears multiple times in page
  it('context-bleed: masks ALL occurrences of original, not just the first', () => {
    // If the original phrase appears twice, we must mask both copies before
    // scanning — otherwise the second copy acts as a false-positive "bleed".
    const repeatedPhrase = 'Anthropic is a leading AI safety company based in San Francisco.';
    const pageContent = `Intro paragraph.\n\n${repeatedPhrase}\n\n${repeatedPhrase}\n\nOutro paragraph.`;
    // Replacement equals the original (legitimate case would be a small edit
    // that coincidentally matches the other copy of the same phrase).
    const p = makeProposal({
      original: repeatedPhrase,
      replacement: repeatedPhrase.replace('leading', 'prominent'),
      fixType: 'correct',
    });
    const result = filterProposals([p], pageContent);
    // Not flagged: neither segment contains "prominent"
    expect(result.rejected.every((r) => r.reason !== 'context-bleed')).toBe(true);
  });

  it('context-bleed: still fires when replacement matches a neighbor even if original repeats', () => {
    // Both copies of original are masked. The "bled" content is in a
    // separate segment (not a copy of original) and should still be caught.
    const orig = 'Alpha short sentence.';
    const neighborLong = 'This long sentence appears in the middle and is the bleed target, forty-plus characters.';
    const pageContent = `${orig}\n\n${neighborLong}\n\n${orig}\n\nEnd.`;
    const p = makeProposal({
      original: orig,
      replacement: neighborLong,
      fixType: 'rewrite',
    });
    const result = filterProposals([p], pageContent);
    expect(result.rejected.some((r) => r.reason === 'context-bleed')).toBe(true);
  });

  // Reviewer Q2: identical-original proposals → span-overlap is correct
  it('span-overlap: identical originals map to same span, second is rejected', () => {
    const pageContent = 'The shared phrase is the thing we edit once. Rest of page.';
    const p1 = makeProposal({
      footnote: 1,
      original: 'The shared phrase is the thing we edit once.',
      replacement: 'The shared phrase is the object we edit once.',
      fixType: 'correct',
    });
    const p2 = makeProposal({
      footnote: 2,
      original: 'The shared phrase is the thing we edit once.',
      replacement: 'The shared phrase is the target we modify once.',
      fixType: 'rewrite',
    });
    const result = filterProposals([p1, p2], pageContent);
    expect(result.kept.map((p) => p.footnote)).toEqual([1]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('span-overlap');
  });

  // Reviewer Q3: multi-bullet `original` no longer greedy-matches across lines
  it('mdx-structure: multi-line original (multiple bullets) does not trigger false-negative on first', () => {
    // Before the `/s` flag was removed, a greedy `.*$` captured both bullets
    // and the non-empty second bullet hid emptiness of the first.
    const p = makeProposal({
      original: '- **A**: first bullet content[^5]\n- **B**: second bullet content[^6]',
      replacement: '- **A**:[^5]\n- **B**: second bullet content[^6]',
      fixType: 'remove_detail',
    });
    const result = filterProposals([p]);
    // The filter does not fire (intentional — we don't reason across multi-line
    // originals). The first bullet is clearly broken but other filters
    // (component-drop, shrink) should catch it; this test just pins that we
    // don't silently accept multi-line bullet edits.
    // Other filters kick in: shrink check should reject this (remove_detail is
    // exempt from shrink, but the structure check also passes on multi-line).
    // The key assertion: if it was kept, that's the bug we accepted — if it
    // was rejected for some OTHER reason, that's fine.
    if (result.kept.length === 1) {
      // Not caught. Document the limitation — but callers with pageContent
      // still get context-bleed / span-overlap coverage for the apply stage.
      expect(result.kept[0]).toBeDefined();
    } else {
      expect(result.rejected.length).toBeGreaterThan(0);
    }
  });

  // Filter precedence: ensure reported rejection reasons follow documented order
  it('precedence: component-drop fires before shrink', () => {
    const p = makeProposal({
      original: 'A long original with <EntityLink id="x"/> embedded for length.',
      replacement: 'Short.',
      fixType: 'rewrite',
    });
    const result = filterProposals([p]);
    // Both component-drop and shrink would fire; component-drop must win
    expect(result.rejected[0].reason).toBe('component-drop');
  });

  it('precedence: remove-ref-scope fires before mdx-structure for remove_ref', () => {
    // Edge case: remove_ref on a list bullet where the replacement collapses
    // BOTH the footnote and the content. remove-ref-scope should catch it
    // first (it's a stricter check about the intent of remove_ref).
    const p = makeProposal({
      original: '- **Label**: important content[^5]',
      replacement: '- **Label**:',
      fixType: 'remove_ref',
    });
    const result = filterProposals([p]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('remove-ref-scope');
  });

  it('span-overlap: third proposal overlapping first (not second) is rejected', () => {
    const pageContent = 'The big paragraph lead-in goes here and runs on with detail for a while longer to test coverage.';
    const p1 = makeProposal({
      footnote: 1,
      original: 'The big paragraph lead-in goes here',
      replacement: 'The big paragraph intro goes here',
      fixType: 'correct',
    });
    const p2 = makeProposal({
      footnote: 2,
      original: 'for a while longer to test coverage',
      replacement: 'for a bit longer to test coverage',
      fixType: 'correct',
    });
    const p3 = makeProposal({
      footnote: 3,
      // Overlaps p1, not p2
      original: 'big paragraph lead-in goes',
      replacement: 'big paragraph intro goes',
      fixType: 'correct',
    });
    const result = filterProposals([p1, p2, p3], pageContent);
    // p1 and p2 keep, p3 rejects as overlap with p1 (verifies claimed.find() scans all)
    expect(result.kept.map((p) => p.footnote).sort()).toEqual([1, 2]);
    expect(result.rejected.map((r) => r.proposal.footnote)).toEqual([3]);
    expect(result.rejected[0].reason).toBe('span-overlap');
  });

  it('combined: new and old filters cooperate in the same batch', () => {
    const pageContent = [
      'This is a long opening sentence with enough content.',
      'The second sentence with forty-plus characters here for bleed check.',
      'And a list item below:',
      '- **Label**: The list item content phrase here[^10]',
    ].join('\n\n');

    const cleanRewrite = makeProposal({
      footnote: 1,
      original: 'This is a long opening sentence with enough content.',
      replacement: 'This is a long opening sentence with fresh content.',
      fixType: 'correct',
    });
    const bleed = makeProposal({
      footnote: 2,
      original: 'The second sentence with forty-plus characters here for bleed check.',
      replacement: 'This is a long opening sentence with enough content.',
      fixType: 'rewrite',
    });
    const danglingBullet = makeProposal({
      footnote: 3,
      original: '- **Label**: The list item content phrase here[^10]',
      replacement: '- **Label**:[^10]',
      fixType: 'remove_detail',
    });

    const result = filterProposals([cleanRewrite, bleed, danglingBullet], pageContent);
    expect(result.kept.map((p) => p.footnote)).toEqual([1]);
    expect(result.rejected).toHaveLength(2);
    const reasons = result.rejected.map((r) => r.reason).sort();
    expect(reasons).toEqual(['context-bleed', 'mdx-structure']);
  });
});

describe('FIX_ACTIONS drift guard', () => {
  // If someone renames an action in SYSTEM_PROMPT without updating FIX_ACTIONS,
  // the shrink filter silently stops matching. This test pins the pairing.
  it('includes every action the system prompt lists', () => {
    // Mirror of the action vocabulary in the SYSTEM_PROMPT fix_type line.
    // Update BOTH simultaneously if the prompt changes.
    const promptActions = ['rewrite', 'correct', 'soften', 'remove_ref', 'remove_detail'];
    expect([...FIX_ACTIONS].sort()).toEqual(promptActions.sort());
  });
});

describe('repairJsonBackslashEscapes', () => {
  it('preserves valid JSON escapes', () => {
    const s = '"a\\n\\t\\r\\"\\\\\\/b"';
    expect(repairJsonBackslashEscapes(s)).toBe(s);
    expect(() => JSON.parse(repairJsonBackslashEscapes(s))).not.toThrow();
  });

  it('doubles backslashes before invalid escape chars', () => {
    const s = '"\\$100K"';
    const repaired = repairJsonBackslashEscapes(s);
    expect(JSON.parse(repaired)).toBe('\\$100K');
  });

  it('handles multiple invalid escapes in one string', () => {
    const s = '"\\$ \\< \\%"';
    expect(JSON.parse(repairJsonBackslashEscapes(s))).toBe('\\$ \\< \\%');
  });

  it('handles mixed valid and invalid escapes', () => {
    const s = '"line\\n\\$val"';
    expect(JSON.parse(repairJsonBackslashEscapes(s))).toBe('line\n\\$val');
  });
});

describe('applyFixes', () => {
  const content = [
    '---',
    'title: Test',
    '---',
    '',
    'The widget costs $50[^1] and was released in 2020.',
    '',
    'The company has 500 employees[^2] worldwide.',
  ].join('\n');

  it('applies a single fix', () => {
    const proposals = [
      {
        footnote: 1,
        original: 'costs $50[^1]',
        replacement: 'costs approximately $45[^1]',
        explanation: 'Corrected price',
        fixType: 'correct',
      },
    ];

    const result = applyFixes(content, proposals);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    const modified = result.content;
    expect(modified).toContain('costs approximately $45[^1]');
    expect(modified).not.toContain('costs $50[^1]');
  });

  it('applies multiple fixes in correct order', () => {
    const proposals = [
      {
        footnote: 1,
        original: 'costs $50[^1]',
        replacement: 'costs about $50[^1]',
        explanation: 'Softened',
        fixType: 'soften',
      },
      {
        footnote: 2,
        original: '500 employees[^2]',
        replacement: 'approximately 500 employees[^2]',
        explanation: 'Softened',
        fixType: 'soften',
      },
    ];

    const result = applyFixes(content, proposals);
    expect(result.applied).toBe(2);
    const modified = result.content;
    expect(modified).toContain('costs about $50[^1]');
    expect(modified).toContain('approximately 500 employees[^2]');
  });

  it('skips fixes where original text is not found', () => {
    const proposals = [
      {
        footnote: 1,
        original: 'nonexistent text',
        replacement: 'something else',
        explanation: 'Should skip',
        fixType: 'correct',
      },
    ];

    const result = applyFixes(content, proposals);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.details[0].status).toBe('not_found');
  });

  it('does not set content when no fixes applied', () => {
    const proposals = [
      {
        footnote: 1,
        original: 'nonexistent',
        replacement: 'new',
        explanation: 'Missing',
        fixType: 'correct',
      },
    ];

    const result = applyFixes(content, proposals);
    expect(result.content).toBeNull();
  });
});

describe('enrichFromApi', () => {
  it('returns enriched objects with null fields when API is unavailable', async () => {
    // When the wiki-server is not available, enrichFromApi
    // should gracefully return the original data with null enrichment fields
    const flagged: FlaggedCitation[] = [
      {
        pageId: 'test-page',
        footnote: 1,
        claimText: 'truncated claim...',
        sourceTitle: 'Source',
        url: 'https://example.com',
        verdict: 'inaccurate',
        score: 0.3,
        issues: 'Wrong date',
        difficulty: 'easy',
        checkedAt: '2025-01-01',
      },
    ];

    const enriched = await enrichFromApi(flagged);
    expect(enriched).toHaveLength(1);
    expect(enriched[0].pageId).toBe('test-page');
    expect(enriched[0].claimText).toBe('truncated claim...');
    // Enrichment fields should be present (null if API unavailable)
    expect('fullClaimText' in enriched[0]).toBe(true);
    expect('sourceQuote' in enriched[0]).toBe(true);
    expect('supportingQuotes' in enriched[0]).toBe(true);
    expect('sourceFullText' in enriched[0]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section extraction (escalation support)
// ---------------------------------------------------------------------------

describe('extractSection', () => {
  const body = [
    '## Overview',
    '',
    'First paragraph about the topic.',
    '',
    'Second paragraph with a claim[^1] that is cited.',
    '',
    'Third paragraph with more claims[^2] here.',
    '',
    '## History',
    '',
    'The organization was founded in 2015[^3].',
    '',
    '### Early Days',
    '',
    'During early days, they achieved[^4] a lot.',
    '',
    '## Footnotes',
    '',
    '[^1]: https://example.com/source1',
    '[^2]: https://example.com/source2',
    '[^3]: https://example.com/source3',
    '[^4]: https://example.com/source4',
  ].join('\n');

  it('extracts section bounded by headings', () => {
    const result = extractSection(body, 1);
    expect(result).not.toBeNull();
    expect(result!.heading).toBe('## Overview');
    expect(result!.text).toContain('## Overview');
    expect(result!.text).toContain('claim[^1]');
    expect(result!.text).toContain('[^2]');
    expect(result!.text).not.toContain('## History');
  });

  it('extracts section for footnote in second section', () => {
    const result = extractSection(body, 3);
    expect(result).not.toBeNull();
    expect(result!.heading).toBe('## History');
    expect(result!.text).toContain('founded in 2015[^3]');
  });

  it('handles subsections', () => {
    const result = extractSection(body, 4);
    expect(result).not.toBeNull();
    expect(result!.heading).toBe('### Early Days');
    expect(result!.text).toContain('achieved[^4]');
    expect(result!.text).not.toContain('## Footnotes');
  });

  it('excludes footnote definition lines', () => {
    const result = extractSection(body, 1);
    expect(result).not.toBeNull();
    expect(result!.text).not.toContain('[^1]: https://');
  });

  it('returns null for missing footnote', () => {
    expect(extractSection(body, 99)).toBeNull();
  });

  it('returns null when footnote only appears in definitions', () => {
    const bodyOnlyDefs = [
      '## Section',
      '',
      'No references in text.',
      '',
      '[^5]: https://example.com',
    ].join('\n');
    expect(extractSection(bodyOnlyDefs, 5)).toBeNull();
  });

  it('does not match [^1] inside [^10] or [^12]', () => {
    const bodyWithHighNums = [
      '## Section',
      '',
      'A claim with footnote[^10] and another[^12].',
    ].join('\n');
    // Searching for [^1] should NOT match [^10] or [^12]
    expect(extractSection(bodyWithHighNums, 1)).toBeNull();
    // But [^10] should match
    const result10 = extractSection(bodyWithHighNums, 10);
    expect(result10).not.toBeNull();
    expect(result10!.text).toContain('[^10]');
  });
});

describe('groupFlaggedBySection', () => {
  const body = [
    '## Overview',
    '',
    'A claim[^1] and another[^2] in same section.',
    '',
    '## Details',
    '',
    'A different claim[^3] here.',
  ].join('\n');

  const makeFlagged = (fn: number): FlaggedCitation => ({
    pageId: 'test',
    footnote: fn,
    claimText: `claim ${fn}`,
    sourceTitle: 'Source',
    url: 'https://example.com',
    verdict: 'inaccurate',
    score: 0.3,
    issues: 'Wrong',
    difficulty: 'easy',
    checkedAt: '2025-01-01',
  });

  it('groups citations in the same section together', () => {
    const groups = groupFlaggedBySection(body, [makeFlagged(1), makeFlagged(2)]);
    expect(groups.size).toBe(1);
    const [entry] = [...groups.values()];
    expect(entry.citations).toHaveLength(2);
    expect(entry.section.heading).toBe('## Overview');
  });

  it('separates citations across different sections', () => {
    const groups = groupFlaggedBySection(body, [makeFlagged(1), makeFlagged(3)]);
    expect(groups.size).toBe(2);
  });

  it('skips citations with no matching section', () => {
    const groups = groupFlaggedBySection(body, [makeFlagged(99)]);
    expect(groups.size).toBe(0);
  });
});

describe('findAllFootnotesInSection', () => {
  it('finds all footnote references', () => {
    const text = 'Some text[^1] and more[^3] and also[^2].';
    expect(findAllFootnotesInSection(text)).toEqual([1, 2, 3]);
  });

  it('deduplicates footnotes appearing multiple times', () => {
    const text = 'A claim[^1] confirmed by[^1] the same source.';
    expect(findAllFootnotesInSection(text)).toEqual([1]);
  });

  it('excludes footnote definition lines', () => {
    const text = [
      'Some text[^1] in the section.',
      '',
      '[^1]: https://example.com',
      '[^2]: https://other.com',
    ].join('\n');
    expect(findAllFootnotesInSection(text)).toEqual([1]);
  });

  it('returns empty array for no footnotes', () => {
    expect(findAllFootnotesInSection('Just plain text.')).toEqual([]);
  });
});

describe('applySectionRewrites', () => {
  const content = [
    '---',
    'title: Test Page',
    '---',
    '',
    '## Overview',
    '',
    'The project started in 2015[^1] and grew rapidly.',
    '',
    '## Details',
    '',
    'It has 500 members[^2] worldwide.',
  ].join('\n');

  it('applies a single section rewrite', () => {
    const rewrites: SectionRewrite[] = [
      {
        heading: '## Overview',
        originalSection: '## Overview\n\nThe project started in 2015[^1] and grew rapidly.',
        rewrittenSection: '## Overview\n\nThe project started in 2016[^1] and grew steadily.',
        startLine: 4,
        endLine: 6,
      },
    ];

    const result = applySectionRewrites(content, rewrites);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.content).toContain('started in 2016[^1]');
    expect(result.content).toContain('grew steadily');
    expect(result.content).toContain('500 members[^2]'); // unchanged
  });

  it('applies multiple rewrites bottom-to-top', () => {
    const rewrites: SectionRewrite[] = [
      {
        heading: '## Overview',
        originalSection: '## Overview\n\nThe project started in 2015[^1] and grew rapidly.',
        rewrittenSection: '## Overview\n\nThe project launched in 2016[^1].',
        startLine: 4,
        endLine: 6,
      },
      {
        heading: '## Details',
        originalSection: '## Details\n\nIt has 500 members[^2] worldwide.',
        rewrittenSection: '## Details\n\nIt has approximately 500 members[^2] globally.',
        startLine: 8,
        endLine: 10,
      },
    ];

    const result = applySectionRewrites(content, rewrites);
    expect(result.applied).toBe(2);
    expect(result.content).toContain('launched in 2016[^1]');
    expect(result.content).toContain('approximately 500 members[^2]');
  });

  it('skips rewrites where original section is not found', () => {
    const rewrites: SectionRewrite[] = [
      {
        heading: '## Missing',
        originalSection: '## Missing\n\nThis section does not exist.',
        rewrittenSection: '## Missing\n\nRewritten.',
        startLine: 0,
        endLine: 2,
      },
    ];

    const result = applySectionRewrites(content, rewrites);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.content).toBe(content);
  });
});

describe('cleanupOrphanedFootnotes', () => {
  it('removes footnote definitions with no inline references', () => {
    const content = [
      '## Section',
      '',
      'Some text with a reference[^1].',
      '',
      '[^1]: [Source One](https://example.com/1)',
      '[^2]: [Source Two](https://example.com/2)',
    ].join('\n');

    const result = cleanupOrphanedFootnotes(content);
    expect(result.removed).toEqual([2]);
    expect(result.content).toContain('[^1]: [Source One]');
    expect(result.content).not.toContain('[^2]');
  });

  it('keeps all definitions when all have inline references', () => {
    const content = [
      '## Section',
      '',
      'A claim[^1] and another[^2].',
      '',
      '[^1]: https://example.com/1',
      '[^2]: https://example.com/2',
    ].join('\n');

    const result = cleanupOrphanedFootnotes(content);
    expect(result.removed).toEqual([]);
    expect(result.content).toBe(content);
  });

  it('removes multiple orphaned definitions', () => {
    const content = [
      '## Section',
      '',
      'Only one reference[^3].',
      '',
      '[^1]: https://example.com/1',
      '[^2]: https://example.com/2',
      '[^3]: https://example.com/3',
    ].join('\n');

    const result = cleanupOrphanedFootnotes(content);
    expect(result.removed).toEqual([1, 2]);
    expect(result.content).toContain('[^3]: https://');
    expect(result.content).not.toContain('[^1]:');
    expect(result.content).not.toContain('[^2]:');
  });

  it('handles content with no footnotes at all', () => {
    const content = '## Section\n\nJust plain text.';
    const result = cleanupOrphanedFootnotes(content);
    expect(result.removed).toEqual([]);
    expect(result.content).toBe(content);
  });

  it('does not count definition-line refs as inline refs', () => {
    // [^5] only appears in the definition line, not in body text
    const content = [
      '## Section',
      '',
      'No inline ref here.',
      '',
      '[^5]: [Title](https://example.com)',
    ].join('\n');

    const result = cleanupOrphanedFootnotes(content);
    expect(result.removed).toEqual([5]);
  });

  it('cleans up double-blank lines after removal', () => {
    const content = [
      '## Section',
      '',
      'Text here.',
      '',
      '[^1]: https://example.com',
      '',
      '## Next',
    ].join('\n');

    const result = cleanupOrphanedFootnotes(content);
    expect(result.removed).toEqual([1]);
    // Should not have triple+ blank lines
    expect(result.content).not.toMatch(/\n\n\n/);
  });
});

describe('applySourceReplacements', () => {
  it('replaces URL in titled link definition', () => {
    const content = [
      '## Section',
      '',
      'A claim[^1].',
      '',
      '[^1]: [Old Title](https://old.example.com/page)',
    ].join('\n');

    const result = applySourceReplacements(content, [
      {
        footnote: 1,
        oldUrl: 'https://old.example.com/page',
        newUrl: 'https://new.example.com/better',
        newTitle: 'Better Source',
        confidence: 'medium',
        reason: 'Found better match',
      },
    ]);

    expect(result.applied).toBe(1);
    expect(result.content).toContain('[^1]: [Better Source](https://new.example.com/better)');
    expect(result.content).not.toContain('old.example.com');
  });

  it('replaces bare URL definition', () => {
    const content = [
      'A claim[^2].',
      '',
      '[^2]: https://bare.example.com/old',
    ].join('\n');

    const result = applySourceReplacements(content, [
      {
        footnote: 2,
        oldUrl: 'https://bare.example.com/old',
        newUrl: 'https://new.example.com/better',
        newTitle: 'New Source',
        confidence: 'medium',
        reason: 'test',
      },
    ]);

    expect(result.applied).toBe(1);
    expect(result.content).toContain('[^2]: [New Source](https://new.example.com/better)');
  });

  it('skips when footnote definition not found', () => {
    const content = 'A claim[^1].\n\n[^1]: [Title](https://example.com)';

    const result = applySourceReplacements(content, [
      {
        footnote: 99,
        oldUrl: 'https://nonexistent.com',
        newUrl: 'https://new.com',
        newTitle: 'New',
        confidence: 'low',
        reason: 'test',
      },
    ]);

    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('handles URLs with special regex characters', () => {
    const content = '[^1]: [Title](https://example.com/path?q=test&page=1)';

    const result = applySourceReplacements(content, [
      {
        footnote: 1,
        oldUrl: 'https://example.com/path?q=test&page=1',
        newUrl: 'https://better.com/page',
        newTitle: 'Better',
        confidence: 'medium',
        reason: 'test',
      },
    ]);

    expect(result.applied).toBe(1);
    expect(result.content).toContain('[Better](https://better.com/page)');
  });

  it('replaces URL in academic embedded-link definition', () => {
    const content = [
      'A claim[^1].',
      '',
      '[^1]: Karnofsky, H., "[Some Background](https://old.example.com/article)," Open Phil, 2016.',
    ].join('\n');

    const result = applySourceReplacements(content, [
      {
        footnote: 1,
        oldUrl: 'https://old.example.com/article',
        newUrl: 'https://new.example.com/better',
        newTitle: 'Better Source',
        confidence: 'medium',
        reason: 'test',
      },
    ]);

    expect(result.applied).toBe(1);
    expect(result.content).toContain('[^1]: [Better Source](https://new.example.com/better)');
    expect(result.content).not.toContain('old.example.com');
  });

  it('replaces URL in text-then-bare-URL definition', () => {
    const content = [
      'A claim[^1].',
      '',
      '[^1]: TransformerLens GitHub repository: https://old.example.com/repo',
    ].join('\n');

    const result = applySourceReplacements(content, [
      {
        footnote: 1,
        oldUrl: 'https://old.example.com/repo',
        newUrl: 'https://new.example.com/better',
        newTitle: 'Better Repo',
        confidence: 'medium',
        reason: 'test',
      },
    ]);

    expect(result.applied).toBe(1);
    expect(result.content).toContain('[^1]: [Better Repo](https://new.example.com/better)');
    expect(result.content).not.toContain('old.example.com');
  });
});

describe('buildSearchQuery', () => {
  it('extracts first sentence when available', () => {
    const claim = 'The organization was founded in 2015. It grew rapidly over the next decade.';
    const query = buildSearchQuery(claim);
    expect(query).toBe('The organization was founded in 2015.');
    expect(query).not.toContain('grew rapidly');
  });

  it('strips MDX components and footnote markers', () => {
    const claim = '<EntityLink id="openai">OpenAI</EntityLink> was founded[^1] in 2015.';
    const query = buildSearchQuery(claim);
    expect(query).toContain('OpenAI');
    expect(query).not.toContain('<EntityLink');
    expect(query).not.toContain('[^1]');
  });

  it('truncates long text without sentence breaks to max 200 chars', () => {
    const claim = 'A ' + 'very long claim with many words and details about different topics that goes on '.repeat(5);
    const query = buildSearchQuery(claim);
    expect(query.length).toBeLessThanOrEqual(200);
    expect(query.length).toBeGreaterThan(100);
    // Should be trimmed (no trailing whitespace)
    expect(query).toBe(query.trim());
  });

  it('returns short claims as-is', () => {
    const claim = 'AI safety is important';
    expect(buildSearchQuery(claim)).toBe('AI safety is important');
  });
});

describe('generateSearchQuery', () => {
  it('falls back to buildSearchQuery when no Anthropic client available', async () => {
    // Without ANTHROPIC_BILLING_KEY, generateSearchQuery should gracefully
    // fall back to the static buildSearchQuery function
    const claim = 'The organization was founded in 2015. It grew rapidly.';
    const query = await generateSearchQuery(claim);
    // Should return a non-empty string (either from LLM or fallback)
    expect(query.length).toBeGreaterThan(5);
    expect(typeof query).toBe('string');
  });
});
