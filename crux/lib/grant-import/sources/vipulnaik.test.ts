/**
 * Tests for the ReDoS-hardened SQL tuple parser in parseVNSQLFile.
 *
 * The tuple regex was rewritten to an unrolled quoted-string pattern so the
 * alternation has no overlapping quantifiers (avoids polynomial ReDoS). These
 * tests assert both correct parsing of tricky quoted/escaped fields AND that a
 * pathological input completes in linear time.
 */

import { describe, it, expect } from 'vitest';
import { parseVNSQLFile } from './vipulnaik.ts';

describe('parseVNSQLFile', () => {
  it('parses tuples with doubled-quote escapes, embedded commas, and NULL', () => {
    // Columns: donor, donee, amount, donation_date, notes
    const sql = [
      'insert into donations (donor, donee, amount, donation_date, notes) values',
      "('Arnold Ventures', 'O''Brien Institute', 5000, '2021-01-01', 'note, with comma'),",
      "('Arnold Ventures', 'Plain Donee', 2500, NULL, NULL);",
    ].join('\n');

    const grants = parseVNSQLFile(sql);

    expect(grants).toHaveLength(2);

    // First record: doubled-quote escape decoded, comma inside string preserved.
    expect(grants[0].donor).toBe('Arnold Ventures');
    expect(grants[0].donee).toBe("O'Brien Institute");
    expect(grants[0].amount).toBe(5000);
    expect(grants[0].date).toBe('2021-01-01');
    expect(grants[0].notes).toBe('note, with comma');

    // Second record: NULL date/notes parsed without crashing.
    expect(grants[1].donee).toBe('Plain Donee');
    expect(grants[1].amount).toBe(2500);
    expect(grants[1].date).toBe('');
    expect(grants[1].notes).toBeNull();
  });

  it('parses fields correctly (field count) within each tuple', () => {
    const sql =
      'insert into donations (donor, donee, amount) values ' +
      "('D1', 'Donee One', 100), ('D2', 'Donee Two', 200);";

    const grants = parseVNSQLFile(sql);
    expect(grants).toHaveLength(2);
    expect(grants[0].donor).toBe('D1');
    expect(grants[1].donor).toBe('D2');
  });

  it('runs in linear time on pathological unterminated-quote input (ReDoS guard)', () => {
    // A run of quote characters with no closing tuple is the classic
    // catastrophic-backtracking trigger. The tupleRegex
    //   /\((?:'[^'\\]*(?:(?:''|\\.)[^'\\]*)*'|[^')])*\)/g
    // is claimed to be "unrolled ... avoids polynomial ReDoS", but it is NOT:
    // on an unterminated quote run it backtracks EXPONENTIALLY (warm-JIT
    // measurements: ~140ms@48, ~270ms@50, ~600ms@52, ~1.1s@54, ~2s@56 quotes;
    // it would never finish at the 40000 the real attacker could send).
    //
    // We use only 56 quotes (not 40000 — that would hang the test forever) so
    // the buggy regex finishes in ~2s and FAILS this <1000ms bound, while a
    // genuinely linear fix finishes in well under 1ms. This assertion is meant
    // to catch the still-present ReDoS, not to be weakened to pass.
    const pathological =
      'insert into donations (donor, donee, amount) values (' + "'".repeat(56);

    const start = performance.now();
    const grants = parseVNSQLFile(pathological);
    const elapsed = performance.now() - start;

    // A correct (linear) implementation passes instantly. The current regex
    // does not — this currently FAILS, documenting the unfixed ReDoS.
    expect(elapsed).toBeLessThan(1000);
    // No complete tuple, so nothing should be extracted.
    expect(grants).toHaveLength(0);
  });
});
