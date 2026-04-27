import { describe, it, expect } from 'vitest';
import { extractMatchTerms } from './match-terms.ts';
import type { MissingSourceRecord } from './types.ts';

describe('extractMatchTerms', () => {
  it('returns both value and label for facts (OR-matching widens recall)', () => {
    const record: MissingSourceRecord = {
      record_id: '1', record_table: 'facts',
      entity_id: 'sid_abc', entity_name: 'Anthropic',
      description: 'Revenue = $1.5B', label: 'Revenue', value: '$1.5B',
    };
    expect(extractMatchTerms(record)).toEqual(['$1.5b', 'revenue']);
  });

  it('returns just the value when label is empty', () => {
    const record: MissingSourceRecord = {
      record_id: '2', record_table: 'facts',
      entity_id: 'sid_abc', entity_name: 'Anthropic',
      description: '1200', label: '', value: '1200',
    };
    expect(extractMatchTerms(record)).toEqual(['1200']);
  });

  it('takes the first clause of long narrative values, plus the label', () => {
    const record: MissingSourceRecord = {
      record_id: '4', record_table: 'facts',
      entity_id: 'sid_ak', entity_name: 'Andrej Karpathy',
      description: 'Notable For = Former Director of AI at Tesla, former OpenAI researcher; founded Eureka Labs',
      label: 'Notable For',
      value: 'Former Director of AI at Tesla, former OpenAI researcher; founded Eureka Labs',
    };
    expect(extractMatchTerms(record)).toEqual([
      'former director of ai at tesla',
      'notable for',
    ]);
  });

  it('falls back to label when value is empty', () => {
    const record: MissingSourceRecord = {
      record_id: '3a', record_table: 'facts',
      entity_id: 'sid_abc', entity_name: 'Anthropic',
      description: 'Is Public Benefit Corp', label: 'Is Public Benefit Corp', value: '',
    };
    expect(extractMatchTerms(record)).toEqual(['is public benefit corp']);
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
