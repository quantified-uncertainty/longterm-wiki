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
  it('extracts records from KB YAML files', async () => {
    const { records, unresolved } = await extractKeyPersons();

    // Should find at least some records (there are ~50 across 11 org files)
    expect(records.length).toBeGreaterThan(10);

    // Should have records from multiple organizations
    const orgs = new Set(records.map((r) => r.orgSlug));
    expect(orgs.size).toBeGreaterThan(3);
  });

  it('resolves known person slugs to entity IDs', async () => {
    const { records } = await extractKeyPersons();

    // Find a well-known person (Dario Amodei at Anthropic)
    const dario = records.find(
      (r) => r.orgSlug === 'anthropic' && r.personSlug === 'dario-amodei',
    );
    expect(dario).toBeDefined();
    expect(dario!.personEntityId).toBeTruthy();
    expect(dario!.personEntityId!.length).toBe(10);
    expect(dario!.title).toBe('CEO');
    expect(dario!.isFounder).toBe(true);
  });

  it('includes start/end dates from YAML', async () => {
    const { records } = await extractKeyPersons();

    // Find someone with a start date
    const withStart = records.filter((r) => r.startDate !== null);
    expect(withStart.length).toBeGreaterThan(0);
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
