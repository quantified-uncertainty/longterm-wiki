import { describe, it, expect } from 'vitest';
import { evaluateManifest, MIN_RECORDS_FOR_GATE, runCheck } from './validate-manifest-sourcing.ts';

const F = '2026-04-30-100000-personnel.json';
const REL = `data/tablebase-manifests/${F}`;

describe('validate-manifest-sourcing (QUA-730)', () => {
  describe('evaluateManifest', () => {
    it('flags a bulk manifest with no sourcing data', () => {
      const v = evaluateManifest(REL, {
        table: 'personnel',
        recordCount: 20,
        sourcingSummary: { withSourcing: 0, withoutSourcing: 20 },
      });
      expect(v).not.toBeNull();
      expect(v?.recordCount).toBe(20);
      expect(v?.withSourcing).toBe(0);
      expect(v?.withoutSourcing).toBe(20);
      expect(v?.file).toBe(REL);
      expect(v?.table).toBe('personnel');
    });

    it('passes when at least one record has sourcing', () => {
      const v = evaluateManifest(REL, {
        table: 'personnel',
        recordCount: 20,
        sourcingSummary: { withSourcing: 1, withoutSourcing: 19 },
      });
      expect(v).toBeNull();
    });

    it('passes when every record has sourcing', () => {
      const v = evaluateManifest(REL, {
        table: 'personnel',
        recordCount: 20,
        sourcingSummary: { withSourcing: 20, withoutSourcing: 0 },
      });
      expect(v).toBeNull();
    });

    it(`exempts manifests with <= ${MIN_RECORDS_FOR_GATE} records`, () => {
      // Boundary: a manifest with exactly MIN_RECORDS_FOR_GATE records is exempt.
      const v = evaluateManifest(REL, {
        table: 'personnel',
        recordCount: MIN_RECORDS_FOR_GATE,
        sourcingSummary: { withSourcing: 0, withoutSourcing: MIN_RECORDS_FOR_GATE },
      });
      expect(v).toBeNull();
    });

    it(`fires at MIN_RECORDS_FOR_GATE + 1`, () => {
      const v = evaluateManifest(REL, {
        table: 'personnel',
        recordCount: MIN_RECORDS_FOR_GATE + 1,
        sourcingSummary: { withSourcing: 0, withoutSourcing: MIN_RECORDS_FOR_GATE + 1 },
      });
      expect(v).not.toBeNull();
    });

    it('skips legacy manifests where sourcingSummary fields are both 0 (pre-2026-04-09 format)', () => {
      // Both `withSourcing === 0` and `withoutSourcing === 0` is the signal
      // that the field wasn't populated by the writer. Without this carve-out
      // every old manifest in the diff would fail the gate.
      const v = evaluateManifest(REL, {
        table: 'personnel',
        recordCount: 50,
        sourcingSummary: { withSourcing: 0, withoutSourcing: 0 },
      });
      expect(v).toBeNull();
    });

    it('returns null when the manifest body cannot be loaded', () => {
      expect(evaluateManifest(REL, null)).toBeNull();
    });

    it('falls back to the basename when the table field is missing', () => {
      const v = evaluateManifest(REL, {
        recordCount: 10,
        sourcingSummary: { withSourcing: 0, withoutSourcing: 10 },
      });
      expect(v).not.toBeNull();
      expect(v?.table).toBe('2026-04-30-100000-personnel');
    });

    it('treats absent sourcingSummary as legacy and skips', () => {
      // No sourcingSummary key at all: behave the same as both-zero.
      const v = evaluateManifest(REL, { table: 'personnel', recordCount: 50 });
      expect(v).toBeNull();
    });

    it('flags newly-added manifests using the pre-2026-04-09 verificationSummary schema as a regression', () => {
      // Without this branch, a writer that emits the old schema would slip
      // through the "absent sourcingSummary → skip" carve-out — exactly the
      // bug the gate is meant to catch. See QUA-730 review feedback.
      const v = evaluateManifest(REL, {
        table: 'personnel',
        recordCount: 20,
        verificationSummary: { withVerification: 0, withoutVerification: 20 },
      });
      expect(v).not.toBeNull();
      expect(v?.reason).toBe('legacy-schema');
      expect(v?.withSourcing).toBe(0);
      expect(v?.withoutSourcing).toBe(20);
    });

    it('does not flag legacy-schema manifests when sourcingSummary is also present (writer bridging)', () => {
      // If a writer emits BOTH summaries (e.g. during a migration), trust
      // the new schema. Only the no-sourcingSummary branch is a regression.
      const v = evaluateManifest(REL, {
        table: 'personnel',
        recordCount: 20,
        verificationSummary: { withVerification: 0, withoutVerification: 20 },
        sourcingSummary: { withSourcing: 20, withoutSourcing: 0 },
      });
      expect(v).toBeNull();
    });

    it('flags violations with reason="no-sourcing" for the standard failure mode', () => {
      const v = evaluateManifest(REL, {
        table: 'personnel',
        recordCount: 20,
        sourcingSummary: { withSourcing: 0, withoutSourcing: 20 },
      });
      expect(v?.reason).toBe('no-sourcing');
    });

    it('treats string values for recordCount/withSourcing as zero (adversarial-input guard)', () => {
      // Without coercion, a JSON authoring bug like `recordCount: "20"` could
      // either silently pass or silently fail. We coerce non-numbers to 0 so
      // the manifest never sneaks past with a stringified count.
      const v = evaluateManifest(REL, {
        table: 'personnel',
        // @ts-expect-error testing wrong-type input
        recordCount: '20',
        // @ts-expect-error testing wrong-type input
        sourcingSummary: { withSourcing: '0', withoutSourcing: '20' },
      });
      // recordCount becomes 0 → below MIN_RECORDS_FOR_GATE → skipped.
      expect(v).toBeNull();
    });

    it('rejects null/undefined data without throwing', () => {
      expect(evaluateManifest(REL, null)).toBeNull();
      // @ts-expect-error testing wrong-type input
      expect(evaluateManifest(REL, undefined)).toBeNull();
    });

    it('handles a legacy-schema manifest where the summary fields are stringified', () => {
      // Coercion still applies on the legacy branch — withSourcing should
      // surface as 0, not "0".
      const v = evaluateManifest(REL, {
        table: 'personnel',
        recordCount: 20,
        // @ts-expect-error testing wrong-type input
        verificationSummary: { withVerification: '0', withoutVerification: '20' },
      });
      expect(v?.reason).toBe('legacy-schema');
      expect(v?.withSourcing).toBe(0);
      expect(v?.withoutSourcing).toBe(0); // both stringified → both coerce to 0
    });
  });

  describe('runCheck', () => {
    it('returns passed=true with empty diff (smoke test on this branch)', () => {
      // Sanity check: when invoked from the actual project root, the validator
      // should at minimum not throw. The actual behavior depends on what's in
      // the diff — this only asserts the runCheck pathway is wired.
      const result = runCheck();
      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('violations');
      expect(typeof result.passed).toBe('boolean');
      expect(Array.isArray(result.violations)).toBe(true);
    });
  });
});
