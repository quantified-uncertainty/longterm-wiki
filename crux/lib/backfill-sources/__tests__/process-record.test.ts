import { describe, it, expect } from 'vitest';
import { selfSourcingUrl } from '../process-record.ts';
import type { MissingSourceRecord } from '../types.ts';

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

describe('selfSourcingUrl', () => {
  it('returns the URL when a fact value is an http URL', () => {
    expect(selfSourcingUrl(mkRecord('facts', {
      label: 'Google Scholar',
      value: 'http://example.com/source',
    }))).toBe('http://example.com/source');
  });

  it('returns the URL when a fact value is an https URL', () => {
    expect(selfSourcingUrl(mkRecord('facts', {
      label: 'Website',
      value: 'https://example.com',
    }))).toBe('https://example.com');
  });

  it('trims surrounding whitespace from URL values', () => {
    expect(selfSourcingUrl(mkRecord('facts', {
      value: '  https://example.com/x  ',
    }))).toBe('https://example.com/x');
  });

  it('returns null when value is not a URL', () => {
    expect(selfSourcingUrl(mkRecord('facts', { value: '4074' }))).toBeNull();
    expect(selfSourcingUrl(mkRecord('facts', { value: 'Some descriptive text' }))).toBeNull();
  });

  it('rejects non-http(s) schemes', () => {
    expect(selfSourcingUrl(mkRecord('facts', { value: 'javascript:alert(1)' }))).toBeNull();
    expect(selfSourcingUrl(mkRecord('facts', { value: 'ftp://example.com' }))).toBeNull();
    expect(selfSourcingUrl(mkRecord('facts', { value: 'data:text/plain,hi' }))).toBeNull();
  });

  it('rejects URLs with embedded whitespace (text-with-URL, not URL value)', () => {
    expect(selfSourcingUrl(mkRecord('facts', {
      value: 'see https://example.com for details',
    }))).toBeNull();
  });

  it('returns null when value is missing or non-string', () => {
    expect(selfSourcingUrl(mkRecord('facts', { value: null }))).toBeNull();
    expect(selfSourcingUrl(mkRecord('facts', {}))).toBeNull();
    expect(selfSourcingUrl(mkRecord('facts', { value: 12345 }))).toBeNull();
  });

  it('does not self-source non-facts tables (their value-shape is different)', () => {
    expect(selfSourcingUrl(mkRecord('personnel', {
      value: 'https://example.com',
    }))).toBeNull();
    expect(selfSourcingUrl(mkRecord('investments', {
      value: 'https://example.com',
    }))).toBeNull();
  });

  it('returns null for self-domain URLs to prevent circular sourcing', () => {
    expect(selfSourcingUrl(mkRecord('facts', {
      value: 'https://www.longtermwiki.com/wiki/E1',
    }))).toBeNull();
  });
});
