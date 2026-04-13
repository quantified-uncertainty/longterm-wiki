import { describe, it, expect, vi } from 'vitest';
import { withRetry, CreditExhaustedError, isCreditExhaustedError } from './resilience.ts';

describe('resilience', () => {
  describe('isCreditExhaustedError', () => {
    it('matches the exact Anthropic 400 body', () => {
      const err = new Error(
        'LLM call failed: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011"}',
      );
      expect(isCreditExhaustedError(err)).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isCreditExhaustedError(new Error('Credit Balance Is Too Low'))).toBe(true);
    });

    it('accepts a plain string', () => {
      expect(isCreditExhaustedError('your credit balance is too low')).toBe(true);
    });

    it('recognises a CreditExhaustedError instance', () => {
      expect(isCreditExhaustedError(new CreditExhaustedError('x', null))).toBe(true);
    });

    it('rejects unrelated errors', () => {
      expect(isCreditExhaustedError(new Error('timeout'))).toBe(false);
      expect(isCreditExhaustedError(new Error('429 rate_limit'))).toBe(false);
      expect(isCreditExhaustedError(new Error('overloaded'))).toBe(false);
      expect(isCreditExhaustedError(null)).toBe(false);
      expect(isCreditExhaustedError(undefined)).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('throws CreditExhaustedError on credit-balance errors without retrying', async () => {
      const fn = vi.fn(async () => {
        throw new Error(
          '400 invalid_request_error: Your credit balance is too low to access the Anthropic API.',
        );
      });

      await expect(withRetry(fn, { maxRetries: 3, label: 'test' })).rejects.toBeInstanceOf(
        CreditExhaustedError,
      );
      // Credit errors are terminal — must not retry.
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('preserves the original error on CreditExhaustedError', async () => {
      const original = new Error('credit balance is too low');
      const fn = vi.fn(async () => {
        throw original;
      });
      try {
        await withRetry(fn);
        expect.fail('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(CreditExhaustedError);
        expect((e as CreditExhaustedError).originalError).toBe(original);
        expect((e as CreditExhaustedError).message).toContain('credit balance');
      }
    });

    it('still retries transient errors (429, timeout, overloaded)', async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 2) throw new Error('timeout');
        return 'ok';
      });
      const result = await withRetry(fn, { maxRetries: 2, label: 'test', onRetry: () => {} });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws non-retryable non-credit errors immediately', async () => {
      const fn = vi.fn(async () => {
        throw new Error('invalid JSON response');
      });
      await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow('invalid JSON response');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('CreditExhaustedError', () => {
    it('has the expected name for instanceof-less checks', () => {
      const err = new CreditExhaustedError('test', null);
      expect(err.name).toBe('CreditExhaustedError');
      expect(err).toBeInstanceOf(Error);
    });
  });
});
