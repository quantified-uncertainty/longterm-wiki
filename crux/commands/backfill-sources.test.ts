import { describe, it, expect } from 'vitest';
import {
  extractMatchTerms,
  contentMatchesRecord,
  type MissingSourceRecord,
} from './backfill-sources.ts';

// ---------------------------------------------------------------------------
// extractMatchTerms
// ---------------------------------------------------------------------------

describe('extractMatchTerms', () => {
  it('extracts label from facts', () => {
    const record: MissingSourceRecord = {
      record_id: '1', record_table: 'facts',
      entity_id: 'sid_abc', entity_name: 'Anthropic',
      description: 'Revenue = $1.5B', label: 'Revenue', value: '$1.5B',
    };
    expect(extractMatchTerms(record)).toEqual(['revenue']);
  });

  it('falls back to value when fact has no label', () => {
    const record: MissingSourceRecord = {
      record_id: '2', record_table: 'facts',
      entity_id: 'sid_abc', entity_name: 'Anthropic',
      description: '1200', label: '', value: '1200',
    };
    expect(extractMatchTerms(record)).toEqual(['1200']);
  });

  it('returns empty for facts with both empty label and value', () => {
    const record: MissingSourceRecord = {
      record_id: '3', record_table: 'facts',
      entity_id: 'sid_abc', entity_name: 'Anthropic',
      description: '', label: '', value: '',
    };
    expect(extractMatchTerms(record)).toHaveLength(0);
  });

  it('extracts person name from personnel', () => {
    const record: MissingSourceRecord = {
      record_id: 'p1', record_table: 'personnel',
      entity_id: 'sid_abc', entity_name: 'Anthropic',
      description: 'Chris Olah at Anthropic',
      person_name: 'Chris Olah',
    };
    expect(extractMatchTerms(record)).toEqual(['chris olah']);
  });

  it('extracts company name from investments', () => {
    const record: MissingSourceRecord = {
      record_id: 'i1', record_table: 'investments',
      entity_id: 'sid_yc', entity_name: 'Y Combinator',
      description: 'YC → Stack AI',
      company_name: 'Stack AI',
    };
    expect(extractMatchTerms(record)).toEqual(['stack ai']);
  });

  it('extracts holder from equity_positions with hyphen-to-space conversion', () => {
    const record: MissingSourceRecord = {
      record_id: 'ep1', record_table: 'equity_positions',
      entity_id: 'sid_abc', entity_name: 'Anthropic',
      description: 'dario-amodei in Anthropic',
      holder_name: 'dario-amodei',
    };
    expect(extractMatchTerms(record)).toEqual(['dario amodei']);
  });

  it('extracts stakeholder name from policy_stakeholders', () => {
    const record: MissingSourceRecord = {
      record_id: 'ps1', record_table: 'policy_stakeholders',
      entity_id: 'sid_pol', entity_name: 'NIST AI RMF',
      description: 'NIST (support)',
      stakeholder_display_name: 'NIST',
    };
    expect(extractMatchTerms(record)).toEqual(['nist']);
  });

  it('extracts title from publications', () => {
    const record: MissingSourceRecord = {
      record_id: 'pub1', record_table: 'publications',
      entity_id: 'sid_abc', entity_name: 'Anthropic',
      description: 'Constitutional AI',
      title: 'Constitutional AI',
    };
    expect(extractMatchTerms(record)).toEqual(['constitutional ai']);
  });

  it('returns empty for unknown table', () => {
    const record: MissingSourceRecord = {
      record_id: 'x', record_table: 'unknown',
      entity_id: 'sid_abc', entity_name: 'Anthropic',
      description: 'something',
    };
    expect(extractMatchTerms(record)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// contentMatchesRecord
// ---------------------------------------------------------------------------

describe('contentMatchesRecord', () => {
  it('matches when all terms present (case-insensitive)', () => {
    expect(contentMatchesRecord(
      'Chris Olah joined Anthropic as a researcher.',
      ['chris olah'],
    )).toBe(true);
  });

  it('fails when term is absent', () => {
    expect(contentMatchesRecord(
      'Dario Amodei founded Anthropic.',
      ['chris olah'],
    )).toBe(false);
  });

  it('returns false for empty terms', () => {
    expect(contentMatchesRecord('some content', [])).toBe(false);
  });

  it('returns false for empty content', () => {
    expect(contentMatchesRecord('', ['term'])).toBe(false);
  });

  it('matches multiple terms (all required)', () => {
    expect(contentMatchesRecord(
      'Google invested in Anthropic at a $60B valuation.',
      ['google', 'anthropic'],
    )).toBe(true);

    expect(contentMatchesRecord(
      'Google invested in DeepMind.',
      ['google', 'anthropic'],
    )).toBe(false);
  });
});
