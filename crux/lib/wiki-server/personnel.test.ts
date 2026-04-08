/**
 * Tests for the syncPersonnel client wrapper — issue #4017.
 *
 * Specifically: the `skipEntityValidation: true` option requires a
 * `skipEntityValidationReason` (loud-bypass enforcement). The wrapper throws
 * synchronously before any HTTP request when the requirement is violated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock apiRequest BEFORE importing the module under test
const mockApiRequest = vi.fn(async () => ({ ok: true, data: { upserted: 0 } }));
vi.mock('./client.ts', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

import { syncPersonnel } from './personnel.ts';

describe('syncPersonnel — skipEntityValidation enforcement (issue #4017)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiRequest.mockResolvedValue({ ok: true, data: { upserted: 0 } });
  });

  it('throws when skipEntityValidation=true is set without a reason', async () => {
    await expect(
      syncPersonnel([], { skipEntityValidation: true }),
    ).rejects.toThrow(/skipEntityValidationReason/);
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('throws when skipEntityValidation=true with empty-string reason', async () => {
    await expect(
      syncPersonnel([], {
        skipEntityValidation: true,
        skipEntityValidationReason: '',
      }),
    ).rejects.toThrow(/skipEntityValidationReason/);
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('throws when skipEntityValidation=true with whitespace-only reason', async () => {
    await expect(
      syncPersonnel([], {
        skipEntityValidation: true,
        skipEntityValidationReason: '   ',
      }),
    ).rejects.toThrow(/skipEntityValidationReason/);
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('succeeds when skipEntityValidation=true is paired with a reason', async () => {
    await syncPersonnel([], {
      skipEntityValidation: true,
      skipEntityValidationReason: 'backfill: refs may not exist yet',
    });
    expect(mockApiRequest).toHaveBeenCalledOnce();
    const url = mockApiRequest.mock.calls[0][1] as string;
    expect(url).toContain('skipEntityValidation=true');
    expect(url).toContain('skipEntityValidationReason=');
    expect(url).toContain('backfill');
  });

  it('succeeds when neither skipEntityValidation nor reason is provided (default path)', async () => {
    await syncPersonnel([{ id: 'p1' }]);
    expect(mockApiRequest).toHaveBeenCalledOnce();
    const url = mockApiRequest.mock.calls[0][1] as string;
    // No query string when validation isn't being skipped.
    expect(url).toBe('/api/personnel/sync');
  });

  it('encodes the reason for URL safety', async () => {
    await syncPersonnel([], {
      skipEntityValidation: true,
      skipEntityValidationReason: 'has spaces & special=chars',
    });
    const url = mockApiRequest.mock.calls[0][1] as string;
    // URLSearchParams encodes spaces as +, & and = get percent-encoded
    expect(url).toMatch(/skipEntityValidationReason=has[+%]20spaces|skipEntityValidationReason=has\+spaces/);
    expect(url).toContain('%26'); // encoded &
  });
});
