import { describe, it, expect } from 'vitest';
import { humanizeClaim } from '../humanize-claim.ts';
import type { MissingSourceRecord } from '../types.ts';

// Test fixture builder: fills housekeeping defaults so each test only spells
// out the fields that matter to the assertion.
function mkRecord(table: string, fields: Record<string, unknown> = {}): MissingSourceRecord {
  return {
    record_id: 'test',
    record_table: table,
    entity_id: null,
    entity_name: '',
    description: '',
    ...fields,
  };
}

describe('humanizeClaim', () => {
  it('renders investments as "X invested in Y"', () => {
    expect(humanizeClaim(mkRecord('investments', {
      investor_name: 'Y Combinator', company_name: 'Ello',
    }))).toBe('Y Combinator invested in Ello');
  });

  it('appends round name when present', () => {
    expect(humanizeClaim(mkRecord('investments', {
      investor_name: 'GIC', company_name: 'Anthropic', round_name: 'Series G',
    }))).toBe('GIC invested in Anthropic (round: Series G)');
  });

  it('renders personnel as "X works at Y as Role"', () => {
    expect(humanizeClaim(mkRecord('personnel', {
      person_name: 'Jacob Haimes', org_name: 'Apart Research', role: 'Research Manager',
    }))).toBe('Jacob Haimes works at Apart Research as Research Manager');
  });

  it('renders equity_positions', () => {
    expect(humanizeClaim(mkRecord('equity_positions', {
      holder_name: 'Dario Amodei', company_name: 'Anthropic',
    }))).toBe('Dario Amodei holds equity in Anthropic');
  });

  it('renders facts with field name and value', () => {
    expect(humanizeClaim(mkRecord('facts', {
      entity_name: 'Anthropic', field_name: 'Total Funding Raised', value: '15000000000',
    }))).toBe("Anthropic's Total Funding Raised is 15000000000");
  });

  it('renders divisions', () => {
    expect(humanizeClaim(mkRecord('divisions', {
      entity_name: 'Coefficient Giving', name: 'Criminal Justice Reform',
    }))).toBe('Coefficient Giving has a division called "Criminal Justice Reform"');
  });

  it('falls back to description when required field missing', () => {
    expect(humanizeClaim(mkRecord('investments', {
      description: 'fallback text', // investor_name + company_name missing
    }))).toBe('fallback text');
  });

  it('falls through to description when company name is a sid_ leak', () => {
    expect(humanizeClaim(mkRecord('investments', {
      description: 'Andreessen Horowitz -> sid_Playground',
      investor_name: 'Andreessen Horowitz',
      company_name: 'sid_Playground', // stripped by f() → required field missing → falls through
    }))).toBe('Andreessen Horowitz -> sid_Playground');
  });

  it('falls back to description for unknown table types', () => {
    expect(humanizeClaim(mkRecord('some_unknown_table', {
      description: 'raw description',
    }))).toBe('raw description');
  });
});
