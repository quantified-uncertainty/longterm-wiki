import { describe, it, expect } from 'vitest';
import { computeFactPriority, computeRecordPriority } from './priority.ts';

describe('computeFactPriority', () => {
  const baseEntity = { id: 'e1', name: 'Test', type: 'organization' } as any;
  const baseFact = { id: 'f1' } as any;

  it('gives highest priority to never-verified items', () => {
    const priority = computeFactPriority(baseEntity, baseFact, undefined, undefined);
    expect(priority).toBeGreaterThanOrEqual(100);
  });

  it('gives high priority to needsRecheck items', () => {
    const existing = { needsRecheck: true, checkedAt: new Date().toISOString() };
    const priority = computeFactPriority(baseEntity, baseFact, existing as any, undefined);
    expect(priority).toBeGreaterThanOrEqual(80);
    // Also gets entity type bonus, so total > 80 but less than never-verified (100+)
    const neverVerified = computeFactPriority(baseEntity, baseFact, undefined, undefined);
    expect(priority).toBeLessThan(neverVerified);
  });

  it('gives staleness-based priority to verified items', () => {
    const recent = { needsRecheck: false, checkedAt: new Date().toISOString() };
    const old = {
      needsRecheck: false,
      checkedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const recentPriority = computeFactPriority(baseEntity, baseFact, recent as any, undefined);
    const oldPriority = computeFactPriority(baseEntity, baseFact, old as any, undefined);
    expect(oldPriority).toBeGreaterThan(recentPriority);
  });

  it('caps staleness at 50', () => {
    const ancient = {
      needsRecheck: false,
      checkedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const entityNoType = { id: 'e1', name: 'Test', type: 'unknown-type' } as any;
    const priority = computeFactPriority(entityNoType, baseFact, ancient as any, undefined);
    // Staleness capped at 50, no entity type bonus for unknown type
    expect(priority).toBeLessThanOrEqual(50);
  });

  it('adds reader importance from page data', () => {
    const withPage = computeFactPriority(baseEntity, baseFact, undefined, { readerImportance: 10 } as any);
    const withoutPage = computeFactPriority(baseEntity, baseFact, undefined, undefined);
    expect(withPage - withoutPage).toBe(50); // 10 * 5
  });
});

describe('computeRecordPriority', () => {
  it('gives highest priority to never-verified records', () => {
    expect(computeRecordPriority('grant', undefined)).toBeGreaterThanOrEqual(100);
  });

  it('gives needsRecheck priority to flagged records', () => {
    const existing = { needsRecheck: true, checkedAt: new Date().toISOString() };
    const priority = computeRecordPriority('grant', existing as any);
    expect(priority).toBeGreaterThanOrEqual(80);
  });

  it('ranks grant higher than equity-position for same verification state', () => {
    const grantPriority = computeRecordPriority('grant', undefined);
    const equityPriority = computeRecordPriority('equity-position', undefined);
    expect(grantPriority).toBeGreaterThan(equityPriority);
  });

  it('returns 0 base for unknown record types that are already verified', () => {
    const existing = { needsRecheck: false, checkedAt: new Date().toISOString() };
    const priority = computeRecordPriority('unknown-type' as any, existing as any);
    // Very recent, no recheck, unknown type — priority near 0
    expect(priority).toBeLessThan(5);
  });
});
