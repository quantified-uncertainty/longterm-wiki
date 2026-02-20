import { describe, it, expect } from 'vitest';
import {
  findFootnoteRefs,
  findFootnoteDefs,
  detectOrphanedFootnotes,
  detectDuplicateFootnoteDefs,
  detectSequentialArxivIds,
  detectUnsourcedFootnotes,
  computeIntegrityRisk,
  assessContentIntegrity,
  isPlausibleArxivPrefix,
} from './content-integrity.ts';

// ---------------------------------------------------------------------------
// findFootnoteRefs
// ---------------------------------------------------------------------------

describe('findFootnoteRefs', () => {
  it('finds inline footnote references', () => {
    const body = 'Some claim[^1] and another[^2] and repeated[^1].';
    expect(findFootnoteRefs(body)).toEqual(new Set([1, 2]));
  });

  it('excludes definition lines', () => {
    const body = `Some claim[^1] here.

[^1]: This is the definition with [^2] inside it.`;
    // Only [^1] from the body, not [^2] from the definition line
    expect(findFootnoteRefs(body)).toEqual(new Set([1]));
  });

  it('returns empty set when no refs', () => {
    expect(findFootnoteRefs('No footnotes here.')).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// findFootnoteDefs
// ---------------------------------------------------------------------------

describe('findFootnoteDefs', () => {
  it('finds footnote definitions', () => {
    const body = `Some text.

[^1]: First source https://example.com
[^2]: Second source`;
    expect(findFootnoteDefs(body)).toEqual(new Set([1, 2]));
  });

  it('returns empty set when no definitions', () => {
    expect(findFootnoteDefs('No definitions.')).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// detectOrphanedFootnotes
// ---------------------------------------------------------------------------

describe('detectOrphanedFootnotes', () => {
  it('detects no orphans when all refs have definitions', () => {
    const body = `Claim[^1] and another[^2].

[^1]: Source one https://example.com
[^2]: Source two https://example.com`;
    const result = detectOrphanedFootnotes(body);
    expect(result.orphanedRefs).toEqual([]);
    expect(result.orphanedRatio).toBe(0);
  });

  it('detects orphaned refs (truncated page)', () => {
    const body = `Claim[^1] and another[^2] and more[^3].

[^1]: Source one https://example.com`;
    // [^2] and [^3] have no definitions
    const result = detectOrphanedFootnotes(body);
    expect(result.orphanedRefs).toEqual([2, 3]);
    expect(result.totalRefs).toBe(3);
    expect(result.totalDefs).toBe(1);
    expect(result.orphanedRatio).toBeCloseTo(2 / 3);
  });

  it('detects all orphaned (fully truncated)', () => {
    const body = 'Claim[^1] and another[^2] and more[^3].';
    const result = detectOrphanedFootnotes(body);
    expect(result.orphanedRefs).toEqual([1, 2, 3]);
    expect(result.orphanedRatio).toBe(1);
  });

  it('handles page with no footnotes at all', () => {
    const result = detectOrphanedFootnotes('Just plain text.');
    expect(result.orphanedRefs).toEqual([]);
    expect(result.orphanedRatio).toBe(0);
    expect(result.totalRefs).toBe(0);
    expect(result.totalDefs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectDuplicateFootnoteDefs
// ---------------------------------------------------------------------------

describe('detectDuplicateFootnoteDefs', () => {
  it('detects no duplicates when all unique', () => {
    const body = `[^1]: Source one
[^2]: Source two`;
    expect(detectDuplicateFootnoteDefs(body)).toEqual([]);
  });

  it('detects duplicate definitions', () => {
    const body = `[^1]: Source one
[^2]: Source two
[^1]: Duplicate of source one`;
    expect(detectDuplicateFootnoteDefs(body)).toEqual([1]);
  });

  it('handles no definitions', () => {
    expect(detectDuplicateFootnoteDefs('No defs.')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectSequentialArxivIds
// ---------------------------------------------------------------------------

describe('detectSequentialArxivIds', () => {
  it('detects sequential arxiv IDs', () => {
    const body = `
Some paper (2506.00001) and next (2506.00002) and third (2506.00003).
`;
    const result = detectSequentialArxivIds(body);
    expect(result.suspicious).toBe(true);
    expect(result.longestRun).toBe(3);
    expect(result.sequentialIds).toEqual(['2506.00001', '2506.00002', '2506.00003']);
  });

  it('detects long runs of fabricated IDs', () => {
    const ids = Array.from({ length: 10 }, (_, i) =>
      `2506.${String(i).padStart(5, '0')}`
    ).join(', ');
    const body = `References: ${ids}`;
    const result = detectSequentialArxivIds(body);
    expect(result.suspicious).toBe(true);
    expect(result.longestRun).toBe(10);
  });

  it('does not flag non-sequential IDs', () => {
    const body = `
Real papers: 2301.07041, 2305.14314, 2310.01234.
`;
    const result = detectSequentialArxivIds(body);
    expect(result.suspicious).toBe(false);
    expect(result.longestRun).toBeLessThan(3);
  });

  it('does not flag fewer than minRunLength sequential IDs', () => {
    const body = 'Papers: 2506.00001, 2506.00002';
    const result = detectSequentialArxivIds(body, 3);
    expect(result.suspicious).toBe(false);
  });

  it('handles no arxiv-like IDs', () => {
    const result = detectSequentialArxivIds('No arxiv references here.');
    expect(result.suspicious).toBe(false);
    expect(result.longestRun).toBe(0);
  });

  it('respects custom minRunLength', () => {
    const body = 'Papers: 2506.00001, 2506.00002';
    expect(detectSequentialArxivIds(body, 2).suspicious).toBe(true);
    expect(detectSequentialArxivIds(body, 3).suspicious).toBe(false);
  });

  it('handles duplicate IDs in input without inflating run length', () => {
    // Same ID repeated should be deduplicated, not counted as a longer run
    const body = 'Paper 2506.00001 cited again 2506.00001 and 2506.00002';
    const result = detectSequentialArxivIds(body, 3);
    expect(result.suspicious).toBe(false);
    expect(result.longestRun).toBeLessThanOrEqual(2);
  });

  it('does not flag version numbers as arxiv IDs', () => {
    // Version strings like 3.14.15926 or 1234.5678 shouldn't match
    const body = 'Using library v0001.0002, update to 0001.0003.';
    const result = detectSequentialArxivIds(body);
    // 00 is not a valid month, so these should be filtered out
    expect(result.suspicious).toBe(false);
  });

  it('does not flag numbers with implausible YYMM prefixes', () => {
    // 9913 = year 99, month 13 — invalid
    const body = 'IDs: 9913.00001, 9913.00002, 9913.00003';
    const result = detectSequentialArxivIds(body);
    expect(result.suspicious).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectUnsourcedFootnotes
// ---------------------------------------------------------------------------

describe('detectUnsourcedFootnotes', () => {
  it('detects footnotes with URLs as sourced', () => {
    const body = `[^1]: Source https://example.com/paper
[^2]: Another https://arxiv.org/abs/2301.12345`;
    const result = detectUnsourcedFootnotes(body);
    expect(result.unsourced).toBe(0);
    expect(result.totalDefs).toBe(2);
    expect(result.unsourcedRatio).toBe(0);
  });

  it('detects unsourced footnotes (no URL)', () => {
    const body = `[^1]: Just some text without a link.
[^2]: Source https://example.com`;
    const result = detectUnsourcedFootnotes(body);
    expect(result.unsourced).toBe(1);
    expect(result.totalDefs).toBe(2);
    expect(result.unsourcedRatio).toBe(0.5);
  });

  it('handles multi-line footnote definitions', () => {
    const body = `[^1]: This is a long footnote that continues
    on the next line with a URL https://example.com
[^2]: This has no URL
    even on continuation lines.`;
    const result = detectUnsourcedFootnotes(body);
    expect(result.unsourced).toBe(1); // [^2] has no URL
    expect(result.totalDefs).toBe(2);
  });

  it('handles empty body', () => {
    const result = detectUnsourcedFootnotes('');
    expect(result.unsourced).toBe(0);
    expect(result.totalDefs).toBe(0);
    expect(result.unsourcedRatio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeIntegrityRisk
// ---------------------------------------------------------------------------

describe('computeIntegrityRisk', () => {
  it('returns 0 for clean page', () => {
    const integrity = assessContentIntegrity(`Claim[^1] here.

[^1]: Source https://example.com`);
    const { score, factors } = computeIntegrityRisk(integrity);
    expect(score).toBe(0);
    expect(factors).toEqual([]);
  });

  it('returns high score for severely truncated page', () => {
    // 3 refs, 0 defs = 100% orphaned
    const integrity = assessContentIntegrity(
      'Claim[^1] and[^2] and[^3].'
    );
    const { score, factors } = computeIntegrityRisk(integrity);
    expect(score).toBe(30);
    expect(factors).toContain('severe-truncation');
  });

  it('returns moderate score for partial orphaning', () => {
    const integrity = assessContentIntegrity(`Claim[^1] and[^2] and[^3].

[^1]: Source https://example.com
[^2]: Source https://example.com`);
    // 1 out of 3 refs orphaned = 33% (not >50%, so orphaned-footnotes not severe-truncation)
    const { score, factors } = computeIntegrityRisk(integrity);
    expect(score).toBe(15);
    expect(factors).toContain('orphaned-footnotes');
  });

  it('returns high score for fabricated arxiv IDs', () => {
    const integrity = assessContentIntegrity(
      'Papers: 2506.00001, 2506.00002, 2506.00003'
    );
    const { score, factors } = computeIntegrityRisk(integrity);
    expect(score).toBe(25);
    expect(factors).toContain('suspicious-sequential-ids');
  });

  it('accumulates multiple risk factors', () => {
    // Orphaned footnotes + sequential arxiv IDs + no URLs
    const integrity = assessContentIntegrity(
      `Claim[^1] from 2506.00001, 2506.00002, 2506.00003.

[^1]: No URL here just text.`
    );
    const { score, factors } = computeIntegrityRisk(integrity);
    // orphaned: [^1] has def so no orphans; sequential IDs: +25; unsourced: 1/1 = 100% → +10
    expect(factors).toContain('suspicious-sequential-ids');
    expect(factors).toContain('mostly-unsourced-footnotes');
    expect(score).toBe(35); // 25 + 10
  });
});

// ---------------------------------------------------------------------------
// isPlausibleArxivPrefix
// ---------------------------------------------------------------------------

describe('isPlausibleArxivPrefix', () => {
  it('accepts valid YYMM prefixes', () => {
    expect(isPlausibleArxivPrefix('2301')).toBe(true);  // Jan 2023
    expect(isPlausibleArxivPrefix('0704')).toBe(true);  // Apr 2007 (earliest new format)
    expect(isPlausibleArxivPrefix('2612')).toBe(true);  // Dec 2026
    expect(isPlausibleArxivPrefix('1506')).toBe(true);  // Jun 2015
  });

  it('rejects invalid months', () => {
    expect(isPlausibleArxivPrefix('2300')).toBe(false); // month 00
    expect(isPlausibleArxivPrefix('2313')).toBe(false); // month 13
    expect(isPlausibleArxivPrefix('2399')).toBe(false); // month 99
  });

  it('rejects years before arxiv new format', () => {
    expect(isPlausibleArxivPrefix('0601')).toBe(false); // 2006, before new format
    expect(isPlausibleArxivPrefix('0001')).toBe(false); // year 00
  });

  it('rejects years far in the future', () => {
    // Upper bound is dynamic: current year + 1. Year 99 is always invalid.
    expect(isPlausibleArxivPrefix('9901')).toBe(false); // year 99
    // Current year + 2 should be rejected
    const farFutureYY = String((new Date().getFullYear() % 100) + 2).padStart(2, '0');
    expect(isPlausibleArxivPrefix(`${farFutureYY}01`)).toBe(false);
  });

  it('rejects non-4-char strings', () => {
    expect(isPlausibleArxivPrefix('230')).toBe(false);
    expect(isPlausibleArxivPrefix('23011')).toBe(false);
    expect(isPlausibleArxivPrefix('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter false positive prevention
// ---------------------------------------------------------------------------

describe('assessContentIntegrity with frontmatter-stripped input', () => {
  it('does not produce false positives from YAML-like content', () => {
    // Simulate body content that might remain after incomplete frontmatter stripping
    const bodyWithYamlArtifacts = `quality: 75
title: Some Page
---

This is the actual body with a claim[^1].

[^1]: Source https://example.com`;
    const integrity = assessContentIntegrity(bodyWithYamlArtifacts);
    const { score } = computeIntegrityRisk(integrity);
    // Should not trigger false positives from quality: 75 or other YAML-like lines
    expect(score).toBe(0);
  });

  it('handles body that starts with YAML-like key-value pairs', () => {
    const body = `version: 2301.12345
date: 2024-01-15

Real content here[^1].

[^1]: Source https://example.com`;
    const integrity = assessContentIntegrity(body);
    // 2301.12345 is a valid arxiv prefix but only one ID, not sequential
    expect(integrity.sequentialArxivIds.suspicious).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectUnsourcedFootnotes edge cases
// ---------------------------------------------------------------------------

describe('detectUnsourcedFootnotes edge cases', () => {
  it('handles definition at EOF without trailing newline', () => {
    // No trailing newline after the last definition
    const body = '[^1]: Source https://example.com\n[^2]: No URL here';
    const result = detectUnsourcedFootnotes(body);
    expect(result.totalDefs).toBe(2);
    expect(result.unsourced).toBe(1); // [^2] has no URL
  });

  it('handles single definition at EOF without trailing newline', () => {
    const body = 'Some text.\n\n[^1]: No URL here';
    const result = detectUnsourcedFootnotes(body);
    expect(result.totalDefs).toBe(1);
    expect(result.unsourced).toBe(1);
  });

  it('handles definition followed by blank line at EOF', () => {
    const body = '[^1]: Source https://example.com\n';
    const result = detectUnsourcedFootnotes(body);
    expect(result.totalDefs).toBe(1);
    expect(result.unsourced).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: integrity signals flow through to risk scores
// ---------------------------------------------------------------------------

describe('integration: integrity signals in risk scoring', () => {
  it('clean page with sourced footnotes produces zero integrity risk', () => {
    const body = `This page has proper citations[^1] and structure[^2].

[^1]: First source https://example.com/paper1
[^2]: Second source https://arxiv.org/abs/2301.12345`;
    const integrity = assessContentIntegrity(body);
    const risk = computeIntegrityRisk(integrity);
    expect(risk.score).toBe(0);
    expect(risk.factors).toEqual([]);
  });

  it('page with all integrity issues accumulates all risk factors', () => {
    // Truncated (orphaned refs) + sequential IDs + duplicate defs + unsourced
    const body = `Claim[^1] and[^2] and[^3] from 2506.00001, 2506.00002, 2506.00003.

[^1]: No URL here.
[^1]: Duplicate def also no URL.`;
    const integrity = assessContentIntegrity(body);
    const risk = computeIntegrityRisk(integrity);

    // orphaned: [^2] and [^3] missing (2/3 = 67% > 50% → severe-truncation: +30)
    expect(risk.factors).toContain('severe-truncation');
    // sequential IDs: +25
    expect(risk.factors).toContain('suspicious-sequential-ids');
    // duplicate [^1]: +10
    expect(risk.factors).toContain('duplicate-footnote-defs');
    // unsourced: 2/2 defs have no URL (ratio 1.0 > 0.5) → +10
    expect(risk.factors).toContain('mostly-unsourced-footnotes');

    expect(risk.score).toBe(30 + 25 + 10 + 10);
  });
});
