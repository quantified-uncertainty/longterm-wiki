import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the wiki-server client before importing the module under test
vi.mock('../lib/wiki-server/client.ts', () => ({
  apiRequest: vi.fn(),
}));

describe('dedup', () => {
  let apiRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const client = await import('../lib/wiki-server/client.ts');
    apiRequest = vi.mocked(client.apiRequest);
    apiRequest.mockReset();
  });

  describe('dedupFundingPrograms', () => {
    it('filters out candidates that match existing records by orgId + name', async () => {
      // Mock server response with existing programs
      apiRequest.mockResolvedValue({
        ok: true,
        data: {
          fundingPrograms: [
            { orgId: 'org1', name: 'AI Safety RFP 2025' },
            { orgId: 'org1', name: 'Technical Fellowship' },
          ],
        },
      });

      const { dedupFundingPrograms } = await import('./dedup.ts');

      const candidates = [
        { orgId: 'org1', name: 'AI Safety RFP 2025', programType: 'rfp' },  // duplicate
        { orgId: 'org1', name: 'New Grant Round', programType: 'grant-round' },  // new
        { orgId: 'org1', name: 'Technical Fellowship', programType: 'fellowship' },  // duplicate
      ];

      const result = await dedupFundingPrograms('org1', candidates);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'New Grant Round' });
    });

    it('is case-insensitive for name matching', async () => {
      apiRequest.mockResolvedValue({
        ok: true,
        data: {
          fundingPrograms: [
            { orgId: 'org1', name: 'AI Safety RFP' },
          ],
        },
      });

      const { dedupFundingPrograms } = await import('./dedup.ts');

      const candidates = [
        { orgId: 'org1', name: 'ai safety rfp', programType: 'rfp' },  // case-insensitive duplicate
        { orgId: 'org1', name: 'Different Program', programType: 'grant-round' },
      ];

      const result = await dedupFundingPrograms('org1', candidates);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'Different Program' });
    });

    it('returns all candidates when server returns no existing records', async () => {
      apiRequest.mockResolvedValue({
        ok: true,
        data: { fundingPrograms: [] },
      });

      const { dedupFundingPrograms } = await import('./dedup.ts');

      const candidates = [
        { orgId: 'org1', name: 'New Program 1' },
        { orgId: 'org1', name: 'New Program 2' },
      ];

      const result = await dedupFundingPrograms('org1', candidates);
      expect(result).toHaveLength(2);
    });

    it('returns all candidates when server is unreachable', async () => {
      apiRequest.mockResolvedValue({
        ok: false,
        message: 'Server unreachable',
      });

      const { dedupFundingPrograms } = await import('./dedup.ts');

      const candidates = [
        { orgId: 'org1', name: 'Program A' },
      ];

      const result = await dedupFundingPrograms('org1', candidates);
      expect(result).toHaveLength(1);
    });

    it('trims whitespace in name comparison', async () => {
      apiRequest.mockResolvedValue({
        ok: true,
        data: {
          fundingPrograms: [
            { orgId: 'org1', name: '  AI Safety RFP  ' },
          ],
        },
      });

      const { dedupFundingPrograms } = await import('./dedup.ts');

      const candidates = [
        { orgId: 'org1', name: 'AI Safety RFP' },  // matches after trim
      ];

      const result = await dedupFundingPrograms('org1', candidates);
      expect(result).toHaveLength(0);
    });
  });
});
