/**
 * Tests for KB records migration — pure transformation and ID logic.
 *
 * Tests the deterministic ID generation, record-to-row mapping functions,
 * and helper utilities without touching the wiki-server API.
 */

import { describe, it, expect } from 'vitest';
import { Graph } from '../../packages/factbase/src/graph.ts';
import type { RecordEntry, Entity } from '../../packages/factbase/src/types.ts';
import {
  personnelId,
  grantId,
  fundingRoundId,
  investmentId,
  equityPositionId,
  resolveEntityId,
  serializeStakeValue,
  parseNumericOrRange,
  mapKeyPerson,
  mapBoardSeat,
  mapCareerHistory,
  mapGrant,
  mapFundingRound,
  mapInvestment,
  mapEquityPosition,
} from './kb-migrate-records.ts';

// ── Test helpers ────────────────────────────────────────────────────────

/** Create a minimal Graph with some entities for resolveEntityId testing. */
function makeGraph(entities: Entity[]): Graph {
  const graph = new Graph();
  for (const e of entities) {
    graph.addEntity(e);
  }
  return graph;
}

/** Convenience to build a RecordEntry for testing map functions. */
function makeRecord(overrides: Partial<RecordEntry> & { key: string; ownerEntityId: string }): RecordEntry {
  return {
    schema: overrides.schema ?? 'test-schema',
    fields: overrides.fields ?? {},
    displayName: overrides.displayName,
    asOf: overrides.asOf,
    validEnd: overrides.validEnd,
    key: overrides.key,
    ownerEntityId: overrides.ownerEntityId,
  };
}

const ANTHROPIC: Entity = {
  id: 'mK9pX3rQ7n',
  stableId: 'mK9pX3rQ7n',
  type: 'organization',
  name: 'Anthropic',
  wikiPageId: 'E22',
};

const DARIO: Entity = {
  id: 'zR4nW8xB2f',
  stableId: 'zR4nW8xB2f',
  type: 'person',
  name: 'Dario Amodei',
};

const SEQUOIA: Entity = {
  id: 'sEq01a2b3c',
  stableId: 'sEq01a2b3c',
  type: 'organization',
  name: 'Sequoia Capital',
};

// ── ID generation: determinism ──────────────────────────────────────────

describe('ID generation determinism', () => {
  it('personnelId produces the same ID for identical inputs', () => {
    const id1 = personnelId('mK9pX3rQ7n', 'key-persons', 'dario');
    const id2 = personnelId('mK9pX3rQ7n', 'key-persons', 'dario');
    expect(id1).toBe(id2);
  });

  it('grantId is deterministic', () => {
    const id1 = grantId('mK9pX3rQ7n', 'grant-001');
    const id2 = grantId('mK9pX3rQ7n', 'grant-001');
    expect(id1).toBe(id2);
  });

  it('fundingRoundId is deterministic', () => {
    const id1 = fundingRoundId('mK9pX3rQ7n', 'series-a');
    const id2 = fundingRoundId('mK9pX3rQ7n', 'series-a');
    expect(id1).toBe(id2);
  });

  it('investmentId is deterministic', () => {
    const id1 = investmentId('mK9pX3rQ7n', 'inv-001');
    const id2 = investmentId('mK9pX3rQ7n', 'inv-001');
    expect(id1).toBe(id2);
  });

  it('equityPositionId is deterministic', () => {
    const id1 = equityPositionId('mK9pX3rQ7n', 'eq-001');
    const id2 = equityPositionId('mK9pX3rQ7n', 'eq-001');
    expect(id1).toBe(id2);
  });

  it('all IDs are 10 characters long', () => {
    expect(personnelId('a', 'b', 'c')).toHaveLength(10);
    expect(grantId('a', 'b')).toHaveLength(10);
    expect(fundingRoundId('a', 'b')).toHaveLength(10);
    expect(investmentId('a', 'b')).toHaveLength(10);
    expect(equityPositionId('a', 'b')).toHaveLength(10);
  });
});

// ── ID generation: uniqueness ───────────────────────────────────────────

describe('ID generation uniqueness', () => {
  it('different owner entities produce different personnel IDs', () => {
    const id1 = personnelId('entity-A', 'key-persons', 'same-key');
    const id2 = personnelId('entity-B', 'key-persons', 'same-key');
    expect(id1).not.toBe(id2);
  });

  it('different collections produce different personnel IDs', () => {
    const id1 = personnelId('mK9pX3rQ7n', 'key-persons', 'dario');
    const id2 = personnelId('mK9pX3rQ7n', 'board-seats', 'dario');
    expect(id1).not.toBe(id2);
  });

  it('different record keys produce different personnel IDs', () => {
    const id1 = personnelId('mK9pX3rQ7n', 'key-persons', 'dario');
    const id2 = personnelId('mK9pX3rQ7n', 'key-persons', 'daniela');
    expect(id1).not.toBe(id2);
  });

  it('different grant keys produce different IDs', () => {
    const id1 = grantId('mK9pX3rQ7n', 'grant-001');
    const id2 = grantId('mK9pX3rQ7n', 'grant-002');
    expect(id1).not.toBe(id2);
  });

  it('grantId and fundingRoundId differ for same owner+key', () => {
    // They use different collection prefixes internally
    const g = grantId('mK9pX3rQ7n', 'round-a');
    const f = fundingRoundId('mK9pX3rQ7n', 'round-a');
    expect(g).not.toBe(f);
  });

  it('investmentId and equityPositionId differ for same owner+key', () => {
    const i = investmentId('mK9pX3rQ7n', 'pos-1');
    const e = equityPositionId('mK9pX3rQ7n', 'pos-1');
    expect(i).not.toBe(e);
  });
});

// ── resolveEntityId ─────────────────────────────────────────────────────

describe('resolveEntityId', () => {
  const graph = makeGraph([ANTHROPIC, DARIO]);

  it('returns the entity ID when the entity exists', () => {
    expect(resolveEntityId(graph, 'mK9pX3rQ7n')).toBe('mK9pX3rQ7n');
  });

  it('returns the input string when the entity does not exist', () => {
    expect(resolveEntityId(graph, 'D. E. Shaw Research')).toBe('D. E. Shaw Research');
  });

  it('returns the input string for an unknown entity ID', () => {
    expect(resolveEntityId(graph, 'nonexistent123')).toBe('nonexistent123');
  });
});

// ── serializeStakeValue ─────────────────────────────────────────────────

describe('serializeStakeValue', () => {
  it('returns null for null', () => {
    expect(serializeStakeValue(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(serializeStakeValue(undefined)).toBeNull();
  });

  it('serializes a number to a string', () => {
    expect(serializeStakeValue(0.15)).toBe('0.15');
  });

  it('serializes a string as-is', () => {
    expect(serializeStakeValue('15%')).toBe('15%');
  });

  it('serializes an array as JSON', () => {
    expect(serializeStakeValue([0.07, 0.15])).toBe('[0.07,0.15]');
  });

  it('serializes an empty array as JSON', () => {
    expect(serializeStakeValue([])).toBe('[]');
  });
});

// ── parseNumericOrRange ─────────────────────────────────────────────────

describe('parseNumericOrRange', () => {
  it('returns null for null', () => {
    expect(parseNumericOrRange(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseNumericOrRange(undefined)).toBeNull();
  });

  it('parses a plain number', () => {
    expect(parseNumericOrRange(5000000)).toBe(5000000);
  });

  it('parses a numeric string', () => {
    expect(parseNumericOrRange('2500000')).toBe(2500000);
  });

  it('returns average for a two-element array range', () => {
    expect(parseNumericOrRange([1000, 3000])).toBe(2000);
  });

  it('returns null for non-numeric string', () => {
    expect(parseNumericOrRange('not-a-number')).toBeNull();
  });

  it('returns null for array with non-numeric elements', () => {
    expect(parseNumericOrRange(['abc', 'def'])).toBeNull();
  });

  it('handles a single-element array by falling through to Number()', () => {
    // Array.length !== 2, so falls through to Number([42]) which is 42 in JS
    const result = parseNumericOrRange([42]);
    expect(result).toBe(42);
  });

  it('handles zero correctly', () => {
    expect(parseNumericOrRange(0)).toBe(0);
  });

  it('returns null for a three-element array (not a valid range)', () => {
    expect(parseNumericOrRange([1, 2, 3])).toBeNull();
  });
});

// ── mapKeyPerson ────────────────────────────────────────────────────────

describe('mapKeyPerson', () => {
  const graph = makeGraph([ANTHROPIC, DARIO]);

  it('maps a basic key-person record', () => {
    const record = makeRecord({
      key: 'dario',
      ownerEntityId: 'mK9pX3rQ7n',
      schema: 'key-person',
      fields: {
        person: 'zR4nW8xB2f',
        title: 'CEO',
        start: '2021',
        is_founder: true,
        source: 'https://example.com',
      },
    });

    const row = mapKeyPerson(record, graph, 'mK9pX3rQ7n');

    expect(row.personId).toBe('zR4nW8xB2f');
    expect(row.organizationId).toBe('mK9pX3rQ7n');
    expect(row.role).toBe('CEO');
    expect(row.roleType).toBe('key-person');
    expect(row.startDate).toBe('2021');
    expect(row.endDate).toBeNull();
    expect(row.isFounder).toBe(true);
    expect(row.source).toBe('https://example.com');
    expect(row.id).toHaveLength(10);
  });

  it('uses displayName when person field is missing', () => {
    const record = makeRecord({
      key: 'john-doe',
      ownerEntityId: 'mK9pX3rQ7n',
      displayName: 'John Doe',
      fields: { title: 'Advisor' },
    });

    const row = mapKeyPerson(record, graph, 'mK9pX3rQ7n');
    expect(row.personId).toBe('John Doe');
  });

  it('uses record key when both person and displayName are missing', () => {
    const record = makeRecord({
      key: 'unknown-person',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { title: 'Staff' },
    });

    const row = mapKeyPerson(record, graph, 'mK9pX3rQ7n');
    expect(row.personId).toBe('unknown-person');
  });

  it('defaults role to "Unknown" when title is missing', () => {
    const record = makeRecord({
      key: 'test',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { person: 'zR4nW8xB2f' },
    });

    const row = mapKeyPerson(record, graph, 'mK9pX3rQ7n');
    expect(row.role).toBe('Unknown');
  });

  it('sets isFounder false when not specified', () => {
    const record = makeRecord({
      key: 'test',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { person: 'zR4nW8xB2f' },
    });

    const row = mapKeyPerson(record, graph, 'mK9pX3rQ7n');
    expect(row.isFounder).toBe(false);
  });
});

// ── mapBoardSeat ────────────────────────────────────────────────────────

describe('mapBoardSeat', () => {
  const graph = makeGraph([ANTHROPIC, DARIO]);

  it('maps a board seat record with all fields', () => {
    const record = makeRecord({
      key: 'dario-board',
      ownerEntityId: 'mK9pX3rQ7n',
      schema: 'board-seat',
      fields: {
        member: 'zR4nW8xB2f',
        role: 'Chair',
        appointed: '2021-01',
        departed: '2023-06',
        appointed_by: 'Board Vote',
        background: 'AI researcher',
        source: 'https://example.com/board',
        notes: 'Co-founded the company',
      },
    });

    const row = mapBoardSeat(record, graph, 'mK9pX3rQ7n');

    expect(row.personId).toBe('zR4nW8xB2f');
    expect(row.organizationId).toBe('mK9pX3rQ7n');
    expect(row.role).toBe('Chair');
    expect(row.roleType).toBe('board');
    expect(row.startDate).toBe('2021-01');
    expect(row.endDate).toBe('2023-06');
    expect(row.isFounder).toBe(false);
    expect(row.appointedBy).toBe('Board Vote');
    expect(row.background).toBe('AI researcher');
    expect(row.source).toBe('https://example.com/board');
    expect(row.notes).toBe('Co-founded the company');
  });

  it('defaults role to "Board Member" when not specified', () => {
    const record = makeRecord({
      key: 'member-1',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { member: 'zR4nW8xB2f' },
    });

    const row = mapBoardSeat(record, graph, 'mK9pX3rQ7n');
    expect(row.role).toBe('Board Member');
  });

  it('uses displayName when member field is absent', () => {
    const record = makeRecord({
      key: 'external-member',
      ownerEntityId: 'mK9pX3rQ7n',
      displayName: 'External Person',
      fields: { role: 'Observer' },
    });

    const row = mapBoardSeat(record, graph, 'mK9pX3rQ7n');
    expect(row.personId).toBe('External Person');
  });
});

// ── mapCareerHistory ────────────────────────────────────────────────────

describe('mapCareerHistory', () => {
  const graph = makeGraph([DARIO]);

  it('maps career history with person as owner', () => {
    const record = makeRecord({
      key: 'openai-role',
      ownerEntityId: 'zR4nW8xB2f',
      schema: 'career-history',
      fields: {
        organization: 'OpenAI',
        title: 'VP of Research',
        start: '2016',
        end: '2020',
      },
    });

    const row = mapCareerHistory(record, graph, 'zR4nW8xB2f');

    expect(row.personId).toBe('zR4nW8xB2f');
    expect(row.organizationId).toBe('OpenAI');
    expect(row.role).toBe('VP of Research');
    expect(row.roleType).toBe('career');
    expect(row.startDate).toBe('2016');
    expect(row.endDate).toBe('2020');
    expect(row.isFounder).toBe(false);
    expect(row.appointedBy).toBeNull();
  });

  it('defaults organization to "Unknown" when missing', () => {
    const record = makeRecord({
      key: 'unknown-org',
      ownerEntityId: 'zR4nW8xB2f',
      fields: { title: 'Researcher' },
    });

    const row = mapCareerHistory(record, graph, 'zR4nW8xB2f');
    expect(row.organizationId).toBe('Unknown');
  });
});

// ── mapGrant ────────────────────────────────────────────────────────────

describe('mapGrant', () => {
  const graph = makeGraph([ANTHROPIC, DARIO]);

  it('maps a grant record with all fields', () => {
    const record = makeRecord({
      key: 'grant-safety-2024',
      ownerEntityId: 'mK9pX3rQ7n',
      schema: 'grant',
      fields: {
        grantee: 'zR4nW8xB2f',
        name: 'AI Safety Research Grant',
        amount: 500000,
        period: '2024-2025',
        date: '2024-01',
        status: 'active',
        source: 'https://example.com/grants',
        notes: 'Annual safety grant',
      },
    });

    const row = mapGrant(record, graph, 'mK9pX3rQ7n');

    expect(row.organizationId).toBe('mK9pX3rQ7n');
    expect(row.granteeId).toBe('zR4nW8xB2f');
    expect(row.name).toBe('AI Safety Research Grant');
    expect(row.amount).toBe(500000);
    expect(row.currency).toBe('USD');
    expect(row.period).toBe('2024-2025');
    expect(row.date).toBe('2024-01');
    expect(row.status).toBe('active');
    expect(row.source).toBe('https://example.com/grants');
    expect(row.notes).toBe('Annual safety grant');
    expect(row.id).toHaveLength(10);
  });

  it('uses record key as name when name field is missing', () => {
    const record = makeRecord({
      key: 'unnamed-grant',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: {},
    });

    const row = mapGrant(record, graph, 'mK9pX3rQ7n');
    expect(row.name).toBe('unnamed-grant');
  });

  it('sets granteeId to null when grantee is missing', () => {
    const record = makeRecord({
      key: 'no-grantee',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { name: 'General Grant' },
    });

    const row = mapGrant(record, graph, 'mK9pX3rQ7n');
    expect(row.granteeId).toBeNull();
  });

  it('sets amount to null when missing', () => {
    const record = makeRecord({
      key: 'no-amount',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { name: 'No Amount Grant' },
    });

    const row = mapGrant(record, graph, 'mK9pX3rQ7n');
    expect(row.amount).toBeNull();
  });

  it('resolves grantee to entity ID when it exists in graph', () => {
    const record = makeRecord({
      key: 'resolved-grant',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { grantee: 'zR4nW8xB2f' },
    });

    const row = mapGrant(record, graph, 'mK9pX3rQ7n');
    expect(row.granteeId).toBe('zR4nW8xB2f');
  });

  it('passes through unresolved grantee string', () => {
    const record = makeRecord({
      key: 'unresolved-grant',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { grantee: 'Unknown Org' },
    });

    const row = mapGrant(record, graph, 'mK9pX3rQ7n');
    expect(row.granteeId).toBe('Unknown Org');
  });
});

// ── mapFundingRound ─────────────────────────────────────────────────────

describe('mapFundingRound', () => {
  const graph = makeGraph([ANTHROPIC, SEQUOIA]);

  it('maps a funding round with all fields', () => {
    const record = makeRecord({
      key: 'series-e',
      ownerEntityId: 'mK9pX3rQ7n',
      schema: 'funding-round',
      fields: {
        name: 'Series E',
        date: '2024-03',
        raised: 2_750_000_000,
        valuation: 18_400_000_000,
        instrument: 'equity',
        lead_investor: 'sEq01a2b3c',
        source: 'https://example.com/funding',
        notes: 'Largest AI funding round',
      },
    });

    const row = mapFundingRound(record, graph, 'mK9pX3rQ7n');

    expect(row.companyId).toBe('mK9pX3rQ7n');
    expect(row.name).toBe('Series E');
    expect(row.date).toBe('2024-03');
    expect(row.raised).toBe(2_750_000_000);
    expect(row.valuation).toBe(18_400_000_000);
    expect(row.instrument).toBe('equity');
    expect(row.leadInvestor).toBe('sEq01a2b3c');
    expect(row.source).toBe('https://example.com/funding');
    expect(row.notes).toBe('Largest AI funding round');
    expect(row.id).toHaveLength(10);
  });

  it('uses record key as name when name is missing', () => {
    const record = makeRecord({
      key: 'series-a',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: {},
    });

    const row = mapFundingRound(record, graph, 'mK9pX3rQ7n');
    expect(row.name).toBe('series-a');
  });

  it('handles null numeric fields', () => {
    const record = makeRecord({
      key: 'seed',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { name: 'Seed' },
    });

    const row = mapFundingRound(record, graph, 'mK9pX3rQ7n');
    expect(row.raised).toBeNull();
    expect(row.valuation).toBeNull();
    expect(row.leadInvestor).toBeNull();
  });
});

// ── mapInvestment ───────────────────────────────────────────────────────

describe('mapInvestment', () => {
  const graph = makeGraph([ANTHROPIC, SEQUOIA]);

  it('maps an investment record with all fields', () => {
    const record = makeRecord({
      key: 'sequoia-series-e',
      ownerEntityId: 'mK9pX3rQ7n',
      schema: 'investment',
      fields: {
        investor: 'sEq01a2b3c',
        round_name: 'Series E',
        date: '2024-03',
        amount: 500_000_000,
        stake_acquired: 0.03,
        instrument: 'equity',
        role: 'Lead',
        conditions: 'Board seat',
        source: 'https://example.com',
        notes: 'Follow-on investment',
      },
    });

    const row = mapInvestment(record, graph, 'mK9pX3rQ7n');

    expect(row.companyId).toBe('mK9pX3rQ7n');
    expect(row.investorId).toBe('sEq01a2b3c');
    expect(row.roundName).toBe('Series E');
    expect(row.date).toBe('2024-03');
    expect(row.amount).toBe(500_000_000);
    expect(row.stakeAcquired).toBe('0.03');
    expect(row.instrument).toBe('equity');
    expect(row.role).toBe('Lead');
    expect(row.conditions).toBe('Board seat');
    expect(row.id).toHaveLength(10);
  });

  it('uses parseNumericOrRange for amount with array range', () => {
    const record = makeRecord({
      key: 'range-inv',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: {
        investor: 'sEq01a2b3c',
        amount: [100_000_000, 200_000_000],
      },
    });

    const row = mapInvestment(record, graph, 'mK9pX3rQ7n');
    expect(row.amount).toBe(150_000_000);
  });

  it('serializes array stake_acquired as JSON', () => {
    const record = makeRecord({
      key: 'range-stake',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: {
        investor: 'sEq01a2b3c',
        stake_acquired: [0.07, 0.15],
      },
    });

    const row = mapInvestment(record, graph, 'mK9pX3rQ7n');
    expect(row.stakeAcquired).toBe('[0.07,0.15]');
  });

  it('uses displayName when investor field is missing', () => {
    const record = makeRecord({
      key: 'unknown-investor',
      ownerEntityId: 'mK9pX3rQ7n',
      displayName: 'Angel Investor LLC',
      fields: {},
    });

    const row = mapInvestment(record, graph, 'mK9pX3rQ7n');
    expect(row.investorId).toBe('Angel Investor LLC');
  });

  it('falls back to key when both investor and displayName are missing', () => {
    const record = makeRecord({
      key: 'mystery-inv',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: {},
    });

    const row = mapInvestment(record, graph, 'mK9pX3rQ7n');
    expect(row.investorId).toBe('mystery-inv');
  });
});

// ── mapEquityPosition ───────────────────────────────────────────────────

describe('mapEquityPosition', () => {
  const graph = makeGraph([ANTHROPIC, SEQUOIA]);

  it('maps an equity position with all fields', () => {
    const record = makeRecord({
      key: 'sequoia-equity',
      ownerEntityId: 'mK9pX3rQ7n',
      schema: 'equity-position',
      fields: {
        holder: 'sEq01a2b3c',
        stake: 0.15,
        source: 'https://example.com/equity',
        notes: 'Post Series E',
      },
      asOf: '2024-03',
      validEnd: '2025-01',
    });

    const row = mapEquityPosition(record, graph, 'mK9pX3rQ7n');

    expect(row.companyId).toBe('mK9pX3rQ7n');
    expect(row.holderId).toBe('sEq01a2b3c');
    expect(row.stake).toBe('0.15');
    expect(row.source).toBe('https://example.com/equity');
    expect(row.notes).toBe('Post Series E');
    expect(row.asOf).toBe('2024-03');
    expect(row.validEnd).toBe('2025-01');
    expect(row.id).toHaveLength(10);
  });

  it('handles null temporal fields', () => {
    const record = makeRecord({
      key: 'no-temporal',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { holder: 'sEq01a2b3c' },
    });

    const row = mapEquityPosition(record, graph, 'mK9pX3rQ7n');
    expect(row.asOf).toBeNull();
    expect(row.validEnd).toBeNull();
  });

  it('serializes array stake as JSON', () => {
    const record = makeRecord({
      key: 'range-equity',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: {
        holder: 'sEq01a2b3c',
        stake: [0.10, 0.20],
      },
    });

    const row = mapEquityPosition(record, graph, 'mK9pX3rQ7n');
    expect(row.stake).toBe('[0.1,0.2]');
  });

  it('uses displayName for holder when field is missing', () => {
    const record = makeRecord({
      key: 'display-holder',
      ownerEntityId: 'mK9pX3rQ7n',
      displayName: 'Mystery Fund',
      fields: { stake: 0.05 },
    });

    const row = mapEquityPosition(record, graph, 'mK9pX3rQ7n');
    expect(row.holderId).toBe('Mystery Fund');
  });
});

// ── Cross-mapper ID consistency ─────────────────────────────────────────

describe('cross-mapper ID consistency', () => {
  const graph = makeGraph([ANTHROPIC]);

  it('same record always gets the same ID across calls', () => {
    const record = makeRecord({
      key: 'series-e',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { name: 'Series E', raised: 2_750_000_000 },
    });

    const row1 = mapFundingRound(record, graph, 'mK9pX3rQ7n');
    const row2 = mapFundingRound(record, graph, 'mK9pX3rQ7n');
    expect(row1.id).toBe(row2.id);
  });

  it('ID uses ownerEntityId from record, not the passed ownerEntityId', () => {
    // The map functions use record.ownerEntityId for ID generation,
    // and the passed ownerEntityId for the row's organizationId/companyId.
    // This tests that behavior is consistent.
    const record = makeRecord({
      key: 'test-grant',
      ownerEntityId: 'mK9pX3rQ7n',
      fields: { name: 'Test' },
    });

    const row = mapGrant(record, graph, 'differentOwner');
    // organizationId uses the passed param
    expect(row.organizationId).toBe('differentOwner');
    // ID uses record.ownerEntityId
    expect(row.id).toBe(grantId('mK9pX3rQ7n', 'test-grant'));
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────

describe('edge cases', () => {
  const graph = makeGraph([]);

  it('handles completely empty fields', () => {
    const record = makeRecord({
      key: 'empty',
      ownerEntityId: 'owner',
      fields: {},
    });

    const row = mapKeyPerson(record, graph, 'owner');
    expect(row.personId).toBe('empty');
    expect(row.role).toBe('Unknown');
    expect(row.startDate).toBeNull();
    expect(row.endDate).toBeNull();
    expect(row.isFounder).toBe(false);
    expect(row.appointedBy).toBeNull();
    expect(row.background).toBeNull();
    expect(row.source).toBeNull();
    expect(row.notes).toBeNull();
  });

  it('handles numeric values in string fields', () => {
    const record = makeRecord({
      key: 'numeric-title',
      ownerEntityId: 'owner',
      fields: { person: 'zR4nW8xB2f', title: 42 },
    });

    const row = mapKeyPerson(record, graph, 'owner');
    expect(row.role).toBe('42');
  });

  it('handles boolean-like values in source fields', () => {
    const record = makeRecord({
      key: 'bool-source',
      ownerEntityId: 'owner',
      fields: { source: false },
    });

    // source: false is falsy but not null/undefined, so String(false) = "false"
    const row = mapGrant(record, graph, 'owner');
    expect(row.source).toBe('false');
  });

  it('handles zero amount correctly', () => {
    const record = makeRecord({
      key: 'zero-grant',
      ownerEntityId: 'owner',
      fields: { amount: 0 },
    });

    const row = mapGrant(record, graph, 'owner');
    expect(row.amount).toBe(0);
  });

  it('handles empty string key', () => {
    const record = makeRecord({
      key: '',
      ownerEntityId: 'owner',
      fields: {},
    });

    const row = mapGrant(record, graph, 'owner');
    expect(row.id).toHaveLength(10);
    expect(row.name).toBe('');
  });
});
