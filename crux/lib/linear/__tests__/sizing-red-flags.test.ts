import { describe, it, expect } from 'vitest';
import { detectRedFlags, formatRedFlagsWarning } from '../sizing-red-flags.ts';

describe('detectRedFlags', () => {
  describe('zero flags', () => {
    it('returns no flags for a small bug-fix title', () => {
      expect(detectRedFlags('Fix typo in README', '')).toEqual([]);
    });

    it('returns no flags when neither title nor description match', () => {
      expect(
        detectRedFlags(
          'Repair broken tooltip on entity page',
          'The tooltip vanishes when the user hovers over the avatar.',
        ),
      ).toEqual([]);
    });

    it('does not fire on a single backticked identifier', () => {
      expect(detectRedFlags('Refactor `foo`', '')).toEqual([]);
    });

    it('does not fire on two backticked identifiers (under threshold)', () => {
      expect(detectRedFlags('Refactor `foo` and `bar`', '')).toEqual([]);
    });
  });

  describe('phase-or-wave', () => {
    it('fires on "Phase 2" in title', () => {
      const flags = detectRedFlags('Phase 2: closeout', '');
      expect(flags).toHaveLength(1);
      expect(flags[0].kind).toBe('phase-or-wave');
      expect(flags[0].match.toLowerCase()).toBe('phase 2');
    });

    it('fires on "Wave B" in body', () => {
      const flags = detectRedFlags('Roll out integrations', 'Wave B: enable for tier-2 customers.');
      expect(flags).toHaveLength(1);
      expect(flags[0].kind).toBe('phase-or-wave');
    });

    it('fires on "Phase 1A" (mixed digits + letters)', () => {
      const flags = detectRedFlags('Phase 1A migration', '');
      expect(flags[0].kind).toBe('phase-or-wave');
    });

    it('is case-insensitive', () => {
      expect(detectRedFlags('PHASE 3 rollout', '')[0]?.kind).toBe('phase-or-wave');
      expect(detectRedFlags('phase 3 rollout', '')[0]?.kind).toBe('phase-or-wave');
    });

    it('does not fire on the bare word "phase" without a number', () => {
      expect(detectRedFlags('Phase out the old endpoint', '')).toEqual([]);
    });

    it('only emits one entry per kind even on repeated matches', () => {
      const flags = detectRedFlags('Phase 1 and Phase 2', 'Wave A and Phase 3');
      expect(flags.filter((f) => f.kind === 'phase-or-wave')).toHaveLength(1);
    });
  });

  describe('row-count-batching', () => {
    it('fires on "migrate 5,000"', () => {
      const flags = detectRedFlags('Migrate 5,000 rows', '');
      expect(flags[0].kind).toBe('row-count-batching');
      expect(flags[0].match.toLowerCase()).toBe('migrate 5,000');
    });

    it('fires on "backfill 100"', () => {
      expect(detectRedFlags('', 'We need to backfill 100 records')[0]?.kind).toBe('row-count-batching');
    });

    it('fires on "populate 10,000"', () => {
      expect(detectRedFlags('Populate 10,000 facts', '')[0]?.kind).toBe('row-count-batching');
    });

    it('fires on "rewrite 250"', () => {
      expect(detectRedFlags('Rewrite 250 prompts', '')[0]?.kind).toBe('row-count-batching');
    });

    it('does not fire on "migrate" without a number', () => {
      expect(detectRedFlags('Migrate the auth middleware', '')).toEqual([]);
    });

    it('does not fire on "migration" (token boundary)', () => {
      expect(detectRedFlags('Migration system overhaul 5000', '')).toEqual([]);
    });
  });

  describe('mixed-shapes', () => {
    it('fires on "audit and"', () => {
      const flags = detectRedFlags('Audit and fix tier-1 entities', '');
      expect(flags[0].kind).toBe('mixed-shapes');
    });

    it('fires on "design and"', () => {
      const flags = detectRedFlags('Design and ship the new resolver', '')[0];
      expect(flags?.kind).toBe('mixed-shapes');
    });

    it('does not fire on bare "audit" without "and"', () => {
      expect(detectRedFlags('Audit the validation gate', '')).toEqual([]);
    });
  });

  describe('multi-table-enumeration', () => {
    it('fires on three backticked identifiers separated by commas', () => {
      const flags = detectRedFlags('Update `foo`, `bar`, `baz`', '');
      expect(flags[0].kind).toBe('multi-table-enumeration');
    });

    it('fires on five backticked identifiers', () => {
      const flags = detectRedFlags('Touch `a`, `b`, `c`, `d`, `e`', '');
      expect(flags[0].kind).toBe('multi-table-enumeration');
    });

    it('handles snake_case identifiers', () => {
      const flags = detectRedFlags('', 'Migrate `entity_resources`, `resource_papers`, `entity_facts`');
      expect(flags[0]?.kind).toBe('multi-table-enumeration');
    });

    it('does not fire on two backticked identifiers', () => {
      expect(detectRedFlags('Update `foo`, `bar`', '')).toEqual([]);
    });

    it('handles whitespace variation around commas', () => {
      expect(
        detectRedFlags('`a` ,  `b`  ,`c`', '')[0]?.kind,
      ).toBe('multi-table-enumeration');
    });
  });

  describe('multi-flag scenarios', () => {
    it('fires three flags on the canonical example from the ticket', () => {
      // From QUA-575: "Phase 2: migrate 5,000 rows across `foo`, `bar`, `baz`"
      // Expected: 3 red flags (phase-or-wave, row-count-batching, multi-table-enumeration).
      const flags = detectRedFlags(
        'Phase 2: migrate 5,000 rows across `foo`, `bar`, `baz`',
        '',
      );
      const kinds = flags.map((f) => f.kind).sort();
      expect(kinds).toEqual(
        ['multi-table-enumeration', 'phase-or-wave', 'row-count-batching'].sort(),
      );
    });

    it('combines flags from title and description', () => {
      const flags = detectRedFlags(
        'Phase 1 cleanup',
        'Audit and fix the resolver across `a`, `b`, `c`',
      );
      const kinds = new Set(flags.map((f) => f.kind));
      expect(kinds).toContain('phase-or-wave');
      expect(kinds).toContain('mixed-shapes');
      expect(kinds).toContain('multi-table-enumeration');
    });

    it('returns at most one flag per kind even when multiple match', () => {
      const flags = detectRedFlags(
        'Phase 1 and Phase 2 design and audit and review',
        'migrate 100 then backfill 200',
      );
      const kindCounts = new Map<string, number>();
      for (const f of flags) {
        kindCounts.set(f.kind, (kindCounts.get(f.kind) ?? 0) + 1);
      }
      for (const count of kindCounts.values()) {
        expect(count).toBe(1);
      }
    });
  });
});

describe('formatRedFlagsWarning', () => {
  it('returns empty string for no flags', () => {
    expect(formatRedFlagsWarning([])).toBe('');
  });

  it('mentions the rule file path so the user can read more', () => {
    const flags = detectRedFlags('Phase 2', '');
    const out = formatRedFlagsWarning(flags);
    expect(out).toContain('docs/agent-rules/ticket-sizing.md');
  });

  it('mentions the --allow-big escape hatch', () => {
    const flags = detectRedFlags('Phase 2', '');
    const out = formatRedFlagsWarning(flags);
    expect(out).toContain('--allow-big');
  });

  it('lists each detected kind', () => {
    const flags = detectRedFlags('Phase 2: migrate 5,000 rows', '');
    const out = formatRedFlagsWarning(flags);
    expect(out).toContain('phase-or-wave');
    expect(out).toContain('row-count-batching');
  });
});
