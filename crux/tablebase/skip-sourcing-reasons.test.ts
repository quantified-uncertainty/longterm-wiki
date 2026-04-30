import { describe, it, expect } from 'vitest';
import {
  SKIP_SOURCING_REASONS,
  isSkipSourcingReason,
  formatSkipSourcingReasonError,
  formatSkipSourcingAuditReason,
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
});
