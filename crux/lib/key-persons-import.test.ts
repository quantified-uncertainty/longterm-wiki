/**
 * Tests for the key-persons import module.
 *
 * Tests extraction from real KB YAML data and conversion to sync items.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  extractKeyPersons,
  toSyncItems,
  syncKeyPersons,
  type ExtractedKeyPerson,
  type KeyPersonSyncItem,
} from './key-persons-import.ts';

describe('extractKeyPersons', () => {
  it('returns empty results (deprecated — records are now in PG)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { records, unresolved } = await extractKeyPersons();

    expect(records).toEqual([]);
    expect(unresolved).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('deprecated'),
    );

    warnSpy.mockRestore();
  });
});

describe('toSyncItems', () => {
  it('converts extracted records to sync items with deterministic IDs', () => {
    const records: ExtractedKeyPerson[] = [
      {
        yamlKey: 'dario-amodei',
        orgSlug: 'anthropic',
        orgEntityId: 'abc1234567',
        personSlug: 'dario-amodei',
        personEntityId: 'xyz9876543',
        title: 'CEO',
        startDate: '2021-01',
        endDate: null,
        isFounder: true,
        source: 'https://anthropic.com/company',
        notes: null,
      },
    ];

    const items = toSyncItems(records);
    expect(items).toHaveLength(1);

    const item = items[0];
    expect(item.id).toHaveLength(10);
    expect(item.personId).toBe('xyz9876543');
    expect(item.organizationId).toBe('abc1234567');
    expect(item.role).toBe('CEO');
    expect(item.roleType).toBe('key-person');
    expect(item.startDate).toBe('2021-01');
    expect(item.endDate).toBeNull();
    expect(item.isFounder).toBe(true);
  });

  it('skips records with unresolved person IDs', () => {
    const records: ExtractedKeyPerson[] = [
      {
        yamlKey: 'unknown-person',
        orgSlug: 'some-org',
        orgEntityId: 'abc1234567',
        personSlug: 'unknown-person',
        personEntityId: null,
        title: 'Researcher',
        startDate: null,
        endDate: null,
        isFounder: false,
        source: null,
        notes: null,
      },
    ];

    const items = toSyncItems(records);
    expect(items).toHaveLength(0);
  });

  it('generates deterministic IDs (same input = same output)', () => {
    const records: ExtractedKeyPerson[] = [
      {
        yamlKey: 'test-person',
        orgSlug: 'test-org',
        orgEntityId: 'org1234567',
        personSlug: 'test-person',
        personEntityId: 'per1234567',
        title: 'Engineer',
        startDate: null,
        endDate: null,
        isFounder: false,
        source: null,
        notes: null,
      },
    ];

    const items1 = toSyncItems(records);
    const items2 = toSyncItems(records);
    expect(items1[0].id).toBe(items2[0].id);
  });
});

describe('syncKeyPersons', () => {
  it('returns { upserted: 0, failed: 0 } in dry-run mode without making API calls', async () => {
    // Spy on console.log to suppress output during test
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const items: KeyPersonSyncItem[] = [
      {
        id: 'test123456',
        personId: 'per1234567',
        organizationId: 'org1234567',
        role: 'CEO',
        roleType: 'key-person',
        startDate: '2021-01',
        endDate: null,
        isFounder: true,
        source: null,
        notes: null,
      },
    ];

    // Set a fake server URL so syncKeyPersons doesn't throw
    const envKey = 'LONGTERMWIKI_SERVER_URL';
    const originalUrl = process.env[envKey];
    process.env[envKey] = 'http://fake-server-for-test:9999';

    try {
      const result = await syncKeyPersons(items, true);
      expect(result).toEqual({ upserted: 0, failed: 0 });
    } finally {
      // Restore original env
      if (originalUrl === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalUrl;
      }
      logSpy.mockRestore();
    }
  });
});
