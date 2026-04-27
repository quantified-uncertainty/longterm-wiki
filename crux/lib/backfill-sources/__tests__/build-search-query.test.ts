import { describe, it, expect } from 'vitest';
import { buildSearchQuery } from '../build-search-query.ts';
import type { MissingSourceRecord } from '../types.ts';

describe('buildSearchQuery', () => {
  function rec(table: string, fields: Record<string, unknown>): MissingSourceRecord {
    return { record_id: '1', record_table: table, entity_id: 'sid_x', entity_name: '', description: '', ...fields };
  }

  it('personnel: drops parenthetical alias from org and avoids duplicate entity name', () => {
    const q = buildSearchQuery(rec('personnel', {
      entity_name: 'QURI (Quantified Uncertainty Research Institute)',
      person_name: 'Ozzie Gooen',
      org_name: 'QURI (Quantified Uncertainty Research Institute)',
      role: 'Executive Director',
      description: 'Ozzie Gooen at QURI (Quantified Uncertainty Research Institute) (Executive Director)',
    }));
    expect(q).toBe('Ozzie Gooen QURI Executive Director');
  });

  it('personnel: keeps plain org name when there is no parenthetical', () => {
    const q = buildSearchQuery(rec('personnel', {
      entity_name: 'Apart Research',
      person_name: 'Jacob Haimes',
      org_name: 'Apart Research',
      role: 'Research Manager',
    }));
    expect(q).toBe('Jacob Haimes Apart Research Research Manager');
  });

  it('facts: uses entity + label + value, not the description column', () => {
    const q = buildSearchQuery(rec('facts', {
      entity_name: 'Anthropic',
      label: 'Total Funding Raised',
      value: '15000000000',
      description: 'Anthropic: Total Funding Raised = 15000000000',
    }));
    expect(q).toBe('Anthropic Total Funding Raised 15000000000');
  });

  it('investments: drops the verb so AND-style engines do not filter out matching press', () => {
    const q = buildSearchQuery(rec('investments', {
      entity_name: 'Y Combinator',
      investor_name: 'Y Combinator',
      company_name: 'Ello',
      round_name: 'YC batch',
      description: 'Y Combinator -> Ello',
    }));
    expect(q).toBe('Y Combinator Ello YC batch');
  });

  it('policy_stakeholders: drops the position word so press using "signed/endorsed/joined" still surfaces', () => {
    const q = buildSearchQuery(rec('policy_stakeholders', {
      entity_name: 'Anthropic',
      stakeholder_display_name: 'Anthropic',
      position: 'support',
      policy_name: 'Seoul Declaration on AI Safety',
    }));
    expect(q).toBe('Anthropic Seoul Declaration on AI Safety');
  });

  it('page_citations: ignores the synthetic "Page #N" entity_name', () => {
    const q = buildSearchQuery(rec('page_citations', {
      entity_name: 'Page #201',
      description: "METR's evaluations serve as an early warning system",
    }));
    expect(q).toBe("METR's evaluations serve as an early warning system");
  });

  it('equity_positions: uses holder + company instead of doubling entity name', () => {
    const q = buildSearchQuery(rec('equity_positions', {
      entity_name: 'Anthropic',
      holder_name: 'Amazon',
      company_name: 'Anthropic',
      description: 'amazon in Anthropic',
    }));
    expect(q).toBe('Amazon stake in Anthropic');
  });

  it('truncates very long queries to the configured cap', () => {
    const long = 'x'.repeat(1000);
    const q = buildSearchQuery(rec('facts', {
      entity_name: 'Anthropic',
      label: 'Notes',
      value: long,
    }));
    expect(q.length).toBeLessThanOrEqual(400);
  });

  it('default builder strips the duplicated entity name from description', () => {
    const q = buildSearchQuery(rec('unknown_table', {
      entity_name: 'Coefficient Giving',
      description: 'Coefficient Giving Criminal Justice Reform',
    }));
    expect(q).toBe('Coefficient Giving Criminal Justice Reform');
  });
});
