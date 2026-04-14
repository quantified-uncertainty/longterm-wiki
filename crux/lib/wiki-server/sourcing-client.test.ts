import { describe, it, expect } from 'vitest';
import { evidenceRecordKey } from './sourcing-client.ts';

describe('evidenceRecordKey', () => {
  // Must match the server's implementation in
  // apps/wiki-server/src/routes/sourcing/sourcing.ts — if either copy
  // drifts from this format, callers of getEvidenceByRecords silently
  // get `undefined` on every lookup.
  it('joins recordType and recordId with a pipe delimiter', () => {
    expect(evidenceRecordKey('fact', 'F1')).toBe('fact|F1');
    expect(evidenceRecordKey('grant', 'g_abc123')).toBe('grant|g_abc123');
    expect(evidenceRecordKey('personnel', '42')).toBe('personnel|42');
  });

  it('produces distinct keys for distinct inputs', () => {
    expect(evidenceRecordKey('fact', 'F1')).not.toBe(
      evidenceRecordKey('grant', 'F1'),
    );
    expect(evidenceRecordKey('fact', 'F1')).not.toBe(
      evidenceRecordKey('fact', 'F2'),
    );
  });
});
