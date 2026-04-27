import { describe, it, expect } from 'vitest';
import { summarizeRecordForManifest } from './manifest-record.ts';

describe('summarizeRecordForManifest (QUA-672)', () => {
  it('preserves temporal fields on personnel records (the original bug)', () => {
    const r = {
      id: 'abc1234567',
      personId: 'p_xyz',
      organizationId: 'sid_org',
      role: 'President of Global Affairs',
      roleType: 'key-person',
      startDate: '2024-05',
      endDate: '2025-01',
      isFounder: false,
      source: 'https://example.com',
    };
    const summary = summarizeRecordForManifest(r);
    expect(summary.startDate).toBe('2024-05');
    expect(summary.endDate).toBe('2025-01');
    expect(summary.roleType).toBe('key-person');
    expect(summary.isFounder).toBe(false);
    expect(summary.role).toBe('President of Global Affairs');
  });

  it('preserves division-specific fields (lead, divisionType, status, dates)', () => {
    const r = {
      id: 'div1234567',
      parentOrgId: 'sid_org',
      name: 'Safety Team',
      divisionType: 'team',
      lead: 'Jane Doe',
      status: 'active',
      startDate: '2023-06',
      endDate: null,
      source: 'https://example.com',
    };
    const summary = summarizeRecordForManifest(r);
    expect(summary.lead).toBe('Jane Doe');
    expect(summary.divisionType).toBe('team');
    expect(summary.status).toBe('active');
    expect(summary.startDate).toBe('2023-06');
    expect(summary.endDate).toBeUndefined(); // null was dropped
  });

  it('drops null and undefined fields', () => {
    const r = {
      id: 'a1b2c3d4e5',
      personId: 'p_xyz',
      role: 'CEO',
      endDate: null,
      background: undefined,
      isFounder: false, // false is NOT null/undefined → kept
    };
    const summary = summarizeRecordForManifest(r);
    expect(summary.endDate).toBeUndefined();
    expect('endDate' in summary).toBe(false);
    expect(summary.background).toBeUndefined();
    expect('background' in summary).toBe(false);
    expect(summary.isFounder).toBe(false);
  });

  it('truncates long freetext fields with an indicator', () => {
    const longText = 'x'.repeat(500);
    const r = {
      id: 'a1b2c3d4e5',
      role: 'CEO',
      notes: longText,
    };
    const summary = summarizeRecordForManifest(r);
    expect(typeof summary.notes).toBe('string');
    expect((summary.notes as string).length).toBeLessThan(500);
    expect(summary.notes).toContain('… [truncated, 200 more chars]');
  });

  it('does not truncate freetext fields under 300 chars', () => {
    const r = {
      id: 'a1b2c3d4e5',
      notes: 'short note',
    };
    const summary = summarizeRecordForManifest(r);
    expect(summary.notes).toBe('short note');
  });

  it('hoists sourcing.verdict and sourcing.evidence to top level', () => {
    const r = {
      id: 'a1b2c3d4e5',
      role: 'CEO',
      sourcing: {
        verdict: 'confirmed',
        evidence: 'Confirmed by official press release',
        confidence: 0.95,
        sourceContentHash: 'abcdef',
        checkedAt: '2026-04-24T00:00:00Z',
      },
    };
    const summary = summarizeRecordForManifest(r);
    expect(summary.verdict).toBe('confirmed');
    expect(summary.evidence).toBe('Confirmed by official press release');
    expect(summary.confidence).toBe(0.95);
    // The inner sourcing object should NOT be in the summary
    expect(summary.sourcing).toBeUndefined();
  });

  it('truncates long evidence strings', () => {
    const r = {
      id: 'a1b2c3d4e5',
      sourcing: {
        verdict: 'confirmed',
        evidence: 'y'.repeat(500),
      },
    };
    const summary = summarizeRecordForManifest(r);
    expect((summary.evidence as string).length).toBeLessThan(500);
    expect(summary.evidence).toContain('… [truncated');
  });

  it("emits verdict: 'none' when no sourcing object is present", () => {
    const r = { id: 'a1b2c3d4e5', role: 'Engineer' };
    const summary = summarizeRecordForManifest(r);
    expect(summary.verdict).toBe('none');
  });

  it('drops claimIds (internal IDs, not human-useful)', () => {
    const r = {
      id: 'a1b2c3d4e5',
      role: 'CEO',
      claimIds: [101, 102, 103],
    };
    const summary = summarizeRecordForManifest(r);
    expect(summary.claimIds).toBeUndefined();
  });

  it('handles empty record gracefully', () => {
    const summary = summarizeRecordForManifest({});
    expect(summary).toEqual({ verdict: 'none' });
  });

  it('does not truncate non-string freetext fields (e.g. object notes)', () => {
    const r = {
      id: 'a1b2c3d4e5',
      notes: { structured: 'data' }, // pathological — should pass through unchanged
    };
    const summary = summarizeRecordForManifest(r);
    expect(summary.notes).toEqual({ structured: 'data' });
  });

  it('preserves both startDate and endDate when both are populated (regression for #4550 false-positive)', () => {
    // Reproduces the exact CodeRabbit false-positive class on Nick Clegg / GPAI records.
    const r = {
      id: 'JhM3kFxq71',
      personId: 'sid_clegg',
      organizationId: 'sid_meta',
      role: 'President of Global Affairs',
      roleType: 'key-person',
      startDate: '2024-05',
      endDate: '2025-01',
      isFounder: false,
    };
    const summary = summarizeRecordForManifest(r);
    expect(summary).toMatchObject({
      startDate: '2024-05',
      endDate: '2025-01',
    });
  });

  it('handles sourcing without evidence (verdict-only)', () => {
    const r = {
      id: 'a1b2c3d4e5',
      sourcing: { verdict: 'unverifiable' },
    };
    const summary = summarizeRecordForManifest(r);
    expect(summary.verdict).toBe('unverifiable');
    expect('evidence' in summary).toBe(false);
  });
});
