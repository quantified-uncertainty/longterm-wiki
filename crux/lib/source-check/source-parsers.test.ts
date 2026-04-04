import { describe, it, expect } from 'vitest';
import { applyColumnMapping, parseCSVContent, parseHTMLTable, parseJSONArray } from './source-parsers.ts';

// ---------------------------------------------------------------------------
// parseCSVContent
// ---------------------------------------------------------------------------

describe('parseCSVContent', () => {
  it('parses a simple CSV with headers', () => {
    const csv = `Organization,Amount,Date
MIRI,500000,2018-07
Anthropic,10000000,2023-01
`;
    const rows = parseCSVContent(csv);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ Organization: 'MIRI', Amount: '500000', Date: '2018-07' });
    expect(rows[1]).toEqual({ Organization: 'Anthropic', Amount: '10000000', Date: '2023-01' });
  });

  it('handles quoted fields with commas', () => {
    const csv = `Organization,Amount,Date
"80,000 Hours","$1,200,000",2021-03
`;
    const rows = parseCSVContent(csv);
    expect(rows.length).toBe(1);
    expect(rows[0]['Organization']).toBe('80,000 Hours');
    expect(rows[0]['Amount']).toBe('$1,200,000');
  });

  it('returns empty array for empty input', () => {
    expect(parseCSVContent('')).toEqual([]);
  });

  it('returns empty array for header-only CSV', () => {
    const csv = 'Organization,Amount,Date\n';
    const rows = parseCSVContent(csv);
    expect(rows.length).toBe(0);
  });

  it('trims header whitespace', () => {
    const csv = ' Organization , Amount \nMIRI,500000\n';
    const rows = parseCSVContent(csv);
    expect(rows.length).toBe(1);
    expect(rows[0]).toHaveProperty('Organization');
    expect(rows[0]).toHaveProperty('Amount');
  });

  it('handles more fields in header than in data row gracefully', () => {
    const csv = `A,B,C\nfoo,bar\n`;
    const rows = parseCSVContent(csv);
    expect(rows.length).toBe(1);
    expect(rows[0]['A']).toBe('foo');
    expect(rows[0]['B']).toBe('bar');
    // C is missing in data row — should be empty string or absent
    expect(rows[0]['C']).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseHTMLTable
// ---------------------------------------------------------------------------

describe('parseHTMLTable', () => {
  it('parses a basic HTML table', () => {
    const html = `
      <table>
        <tr><th>Name</th><th>Amount</th></tr>
        <tr><td>MIRI</td><td>500000</td></tr>
        <tr><td>Anthropic</td><td>10000000</td></tr>
      </table>
    `;
    const rows = parseHTMLTable(html);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ Name: 'MIRI', Amount: '500000' });
    expect(rows[1]).toEqual({ Name: 'Anthropic', Amount: '10000000' });
  });

  it('parses a table with <thead> and <tbody>', () => {
    const html = `
      <table>
        <thead><tr><th>Org</th><th>Grant</th></tr></thead>
        <tbody>
          <tr><td>CEA</td><td>200000</td></tr>
        </tbody>
      </table>
    `;
    const rows = parseHTMLTable(html);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ Org: 'CEA', Grant: '200000' });
  });

  it('returns empty array for input with no tables', () => {
    const html = '<div><p>No tables here</p></div>';
    expect(parseHTMLTable(html)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseHTMLTable('')).toEqual([]);
  });

  it('strips HTML tags from cell content', () => {
    const html = `
      <table>
        <tr><th>Name</th></tr>
        <tr><td><a href="/org">MIRI</a></td></tr>
      </table>
    `;
    const rows = parseHTMLTable(html);
    expect(rows.length).toBe(1);
    expect(rows[0]['Name']).toBe('MIRI');
  });

  it('picks the largest table when multiple tables exist', () => {
    const html = `
      <table><tr><th>A</th></tr><tr><td>1</td></tr></table>
      <table>
        <tr><th>B</th><th>C</th></tr>
        <tr><td>x</td><td>y</td></tr>
        <tr><td>p</td><td>q</td></tr>
      </table>
    `;
    const rows = parseHTMLTable(html);
    // Second table has more rows (2 vs 1)
    expect(rows.length).toBe(2);
    expect(rows[0]).toHaveProperty('B');
  });

  it('replaces &nbsp; with a space', () => {
    const html = `
      <table>
        <tr><th>Name</th></tr>
        <tr><td>foo&nbsp;bar</td></tr>
      </table>
    `;
    const rows = parseHTMLTable(html);
    expect(rows[0]['Name']).toBe('foo bar');
  });

  it('replaces &amp; with &', () => {
    const html = `
      <table>
        <tr><th>Name</th></tr>
        <tr><td>R&amp;D</td></tr>
      </table>
    `;
    const rows = parseHTMLTable(html);
    expect(rows[0]['Name']).toBe('R&D');
  });
});

// ---------------------------------------------------------------------------
// parseJSONArray
// ---------------------------------------------------------------------------

describe('parseJSONArray', () => {
  it('parses a plain JSON array', () => {
    const json = JSON.stringify([
      { title: 'AI Safety Project', amount: 50000 },
      { title: 'Alignment Research', amount: 100000 },
    ]);
    const rows = parseJSONArray(json);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ title: 'AI Safety Project', amount: 50000 });
  });

  it('extracts array from a wrapped object', () => {
    const json = JSON.stringify({
      data: [{ id: 1, name: 'MIRI' }],
      total: 1,
    });
    const rows = parseJSONArray(json);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ id: 1, name: 'MIRI' });
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseJSONArray('not json')).toEqual([]);
    expect(parseJSONArray('{bad json}')).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseJSONArray('')).toEqual([]);
  });

  it('returns empty array for JSON object with no array values', () => {
    const json = JSON.stringify({ count: 1, name: 'foo' });
    expect(parseJSONArray(json)).toEqual([]);
  });

  it('returns empty array for JSON primitives', () => {
    expect(parseJSONArray('"hello"')).toEqual([]);
    expect(parseJSONArray('42')).toEqual([]);
    expect(parseJSONArray('null')).toEqual([]);
  });

  it('handles Unicode characters in JSON content', () => {
    const json = JSON.stringify([{ name: 'Nuño Sempere', org: 'Rethink Priorities' }]);
    const rows = parseJSONArray(json);
    expect(rows[0]['name']).toBe('Nuño Sempere');
  });
});

// ---------------------------------------------------------------------------
// applyColumnMapping
// ---------------------------------------------------------------------------

describe('applyColumnMapping', () => {
  it('maps source columns to internal field names', () => {
    const rows = [{ Organization: 'MIRI', Amount: 50000 }];
    const mapping = { Organization: 'grantee', Amount: 'amount' };
    const result = applyColumnMapping(rows, mapping);
    expect(result[0]).toEqual({ grantee: 'MIRI', amount: 50000 });
  });

  it('keeps unmapped fields that do not collide with mapping targets', () => {
    const rows = [{ Organization: 'MIRI', Amount: 50000, extra: 'data' }];
    const mapping = { Organization: 'grantee', Amount: 'amount' };
    const result = applyColumnMapping(rows, mapping);
    expect(result[0]).toEqual({ grantee: 'MIRI', amount: 50000, extra: 'data' });
  });

  it('does NOT copy unmapped fields whose key collides with a mapping target', () => {
    // Source row has a field called 'amount' (lowercase) AND 'Amount' (capitalized).
    // The mapping maps 'Amount' → 'amount'. Without the fix, the unmapped 'amount'
    // field would overwrite the mapped value.
    const rows = [{ Amount: 50000, amount: 'wrong-value', grantee: 'should-be-dropped' }];
    const mapping = { Amount: 'amount', Organization: 'grantee' };
    const result = applyColumnMapping(rows, mapping);
    // 'Amount' is a mapping source → mapped to 'amount' with value 50000
    // 'amount' is NOT a mapping source, but IS a mapping target → should be skipped
    // 'grantee' is NOT a mapping source, but IS a mapping target → should be skipped
    expect(result[0]).toEqual({ amount: 50000 });
  });

  it('handles empty mapping gracefully', () => {
    const rows = [{ a: 1, b: 2 }];
    const result = applyColumnMapping(rows, {});
    expect(result[0]).toEqual({ a: 1, b: 2 });
  });
});
