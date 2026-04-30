import { describe, it, expect } from 'vitest';
import {
  SKIP_SOURCING_REASONS,
  isSkipSourcingReason,
  formatSkipSourcingReasonError,
  formatSkipSourcingAuditReason,
  formatSkipSourcingBanner,
  checkSkipSourcingReason,
} from './skip-sourcing-reasons.ts';

describe('skip-sourcing-reasons (QUA-730)', () => {
  describe('isSkipSourcingReason', () => {
    it.each(SKIP_SOURCING_REASONS)('accepts the controlled value %s', (reason) => {
      expect(isSkipSourcingReason(reason)).toBe(true);
    });

    it('rejects undefined', () => {
      expect(isSkipSourcingReason(undefined)).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isSkipSourcingReason('')).toBe(false);
    });

    it('rejects strings outside the vocabulary', () => {
      expect(isSkipSourcingReason('because')).toBe(false);
      expect(isSkipSourcingReason('temporary')).toBe(false);
      // The pre-QUA-730 free-form value should not validate.
      expect(isSkipSourcingReason('cli: --skip-sourcing flag set by caller')).toBe(false);
    });

    it('rejects non-strings', () => {
      expect(isSkipSourcingReason(null)).toBe(false);
      expect(isSkipSourcingReason(0)).toBe(false);
      expect(isSkipSourcingReason({ reason: 'migration' })).toBe(false);
    });
  });

  describe('formatSkipSourcingReasonError', () => {
    it('explains when no reason was provided', () => {
      const msg = formatSkipSourcingReasonError(undefined);
      expect(msg).toContain('--skip-sourcing requires --skip-sourcing-reason');
      expect(msg).toContain('QUA-730');
      // Lists every allowed value.
      for (const reason of SKIP_SOURCING_REASONS) {
        expect(msg).toContain(reason);
      }
    });

    it('echoes the rejected value when an invalid one was provided', () => {
      const msg = formatSkipSourcingReasonError('whatever');
      expect(msg).toContain('"whatever"');
      expect(msg).toContain('not in the controlled vocabulary');
    });
  });

  describe('formatSkipSourcingAuditReason', () => {
    it('embeds caller label and reason for the wiki-server audit log', () => {
      expect(formatSkipSourcingAuditReason('migration', 'cli')).toBe(
        'cli: skip-sourcing reason=migration',
      );
      expect(formatSkipSourcingAuditReason('key-unavailable', 'agent-tool')).toBe(
        'agent-tool: skip-sourcing reason=key-unavailable',
      );
    });
  });

  describe('checkSkipSourcingReason', () => {
    it('returns null when skipSourcing is absent', () => {
      expect(checkSkipSourcingReason({})).toBeNull();
      expect(checkSkipSourcingReason({ skipSourcing: false })).toBeNull();
    });

    it('returns null when skipSourcing is set with a valid reason', () => {
      expect(
        checkSkipSourcingReason({ skipSourcing: true, skipSourcingReason: 'migration' }),
      ).toBeNull();
      expect(
        checkSkipSourcingReason({ skipSourcing: true, skipSourcingReason: 'key-unavailable' }),
      ).toBeNull();
    });

    it('returns exit code 2 when skipSourcing is set without a reason', () => {
      const err = checkSkipSourcingReason({ skipSourcing: true });
      expect(err).not.toBeNull();
      expect(err?.exitCode).toBe(2);
      expect(err?.output).toContain('--skip-sourcing-reason');
    });

    it('returns exit code 2 when skipSourcing is set with an invalid reason', () => {
      const err = checkSkipSourcingReason({
        skipSourcing: true,
        skipSourcingReason: 'because',
      });
      expect(err).not.toBeNull();
      expect(err?.exitCode).toBe(2);
      expect(err?.output).toContain('"because"');
    });

    it('trims whitespace before validating', () => {
      // Trailing whitespace from manual flag invocation should not reject.
      expect(
        checkSkipSourcingReason({ skipSourcing: true, skipSourcingReason: '  testing  ' }),
      ).toBeNull();
    });
  });

  describe('formatSkipSourcingBanner', () => {
    it('produces a yellow CLI banner', () => {
      const out = formatSkipSourcingBanner({
        source: 'cli',
        recordCount: 20,
        table: 'personnel',
        reason: 'key-unavailable',
      });
      expect(out).toContain('--skip-sourcing');
      expect(out).toContain('20 personnel record(s)');
      expect(out).toContain('Reason: key-unavailable');
      expect(out).toContain('\x1b[33m'); // yellow
      expect(out).toContain('═'.repeat(72));
    });

    it('produces an agent-prefixed banner for the agent path', () => {
      const out = formatSkipSourcingBanner({
        source: 'agent',
        recordCount: 5,
        table: 'grants',
        reason: 'testing',
      });
      expect(out).toContain('agent --skipSourcing');
      expect(out).toContain('5 grants record(s)');
    });
  });
});
