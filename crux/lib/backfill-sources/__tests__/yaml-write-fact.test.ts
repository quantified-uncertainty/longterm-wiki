import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFactSourceToYaml } from '../yaml-write-fact.ts';
import type { FactbaseEntityIndex } from '../yaml-target-resolvers.ts';

const SAMPLE = `entity: sid_EntEntEnt0
facts:
  - id: f_FactFactNo
    property: revenue
    value: 1.2e+9
    asOf: 2025-09
  - id: f_HasSourceX
    property: revenue
    value: 1e+8
    asOf: 2024-06
    source: https://existing.example.com
`;

let tmpRoot: string;
let yamlPath: string;
let index: FactbaseEntityIndex;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yaml-fact-'));
  mkdirSync(tmpRoot, { recursive: true });
  yamlPath = join(tmpRoot, 'ent.yaml');
  writeFileSync(yamlPath, SAMPLE, 'utf-8');
  index = {
    sidToFilepath: new Map([['sid_EntEntEnt0', yamlPath]]),
    unindexedCount: 0,
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('writeFactSourceToYaml', () => {
  it('writes source for a fact missing one', () => {
    const out = writeFactSourceToYaml({
      entitySid: 'sid_EntEntEnt0',
      factId: 'f_FactFactNo',
      url: 'https://example.com/news',
      index,
    });
    expect(out.status).toBe('wrote');

    const after = readFileSync(yamlPath, 'utf-8');
    expect(after).toContain('source: https://example.com/news');
    // The other fact's existing source is untouched.
    expect(after).toContain('https://existing.example.com');
  });

  it('returns skipped-existing when fact already has a source', () => {
    const out = writeFactSourceToYaml({
      entitySid: 'sid_EntEntEnt0',
      factId: 'f_HasSourceX',
      url: 'https://example.com/replacement',
      index,
    });
    expect(out.status).toBe('skipped-existing');
    const after = readFileSync(yamlPath, 'utf-8');
    expect(after).not.toContain('https://example.com/replacement');
  });

  it('returns not-found when factId is absent', () => {
    const out = writeFactSourceToYaml({
      entitySid: 'sid_EntEntEnt0',
      factId: 'f_DoesNotExi',
      url: 'https://example.com/x',
      index,
    });
    expect(out.status).toBe('not-found');
  });

  it('returns no-yaml-target when entity sid is not indexed', () => {
    const out = writeFactSourceToYaml({
      entitySid: 'sid_NotIndexed',
      factId: 'f_FactFactNo',
      url: 'https://example.com/x',
      index,
    });
    expect(out.status).toBe('no-yaml-target');
    expect(out.filepath).toBeNull();
  });

  // Regression: PR #4871 — same root cause as the stakeholder writer. The
  // FactBase YAML serializer at default lineWidth:80 re-wraps long strings on
  // every save. We pass lineWidth:120 to match the codebase's other YAML
  // writers (extract-structured-data, factbase-migrate). Lines ≤120 cols must
  // survive verbatim.
  it('preserves moderately-long unrelated lines verbatim (≤120 cols)', () => {
    // ~110 chars — would fold at default 80, must NOT fold at 120.
    const MODERATE_NOTE =
      'Series E at $61.5B post-money per Bloomberg, Reuters; Lightspeed lead, Salesforce Ventures and Cisco participating.';

    const moderateLineYaml = `entity: sid_EntModrLin
facts:
  - id: f_FactNoSrc1
    property: revenue
    value: 1.2e+9
    asOf: 2025-09
  - id: f_FactHasSrc
    property: valuation
    value: 6.15e+10
    asOf: 2025-03
    notes: ${MODERATE_NOTE}
    source: https://existing.example.com/series-e
`;
    writeFileSync(yamlPath, moderateLineYaml, 'utf-8');
    index = {
      sidToFilepath: new Map([['sid_EntModrLin', yamlPath]]),
      unindexedCount: 0,
    };

    const out = writeFactSourceToYaml({
      entitySid: 'sid_EntModrLin',
      factId: 'f_FactNoSrc1',
      url: 'https://example.com/news',
      index,
    });
    expect(out.status).toBe('wrote');

    const after = readFileSync(yamlPath, 'utf-8');

    expect(after).toContain(`notes: ${MODERATE_NOTE}\n`);
    expect(after).toContain('source: https://example.com/news');
    expect(after).toContain('source: https://existing.example.com/series-e');
  });

  // Regression: PR #4871 follow-up. The writer was unconditionally setting
  // `notes: [auto-discovered by tb backfill-sources]` on the targeted fact,
  // overwriting any human-written notes. Existing notes must survive.
  it('does not clobber existing notes on the targeted fact', () => {
    const HUMAN_NOTE = 'Verified against Anthropic shareholder filing 2025-03';
    const yaml = `entity: sid_EntKeepNot
facts:
  - id: f_FactKeepNo
    property: revenue
    value: 1.2e+9
    asOf: 2025-09
    notes: ${HUMAN_NOTE}
`;
    writeFileSync(yamlPath, yaml, 'utf-8');
    index = {
      sidToFilepath: new Map([['sid_EntKeepNot', yamlPath]]),
      unindexedCount: 0,
    };

    const out = writeFactSourceToYaml({
      entitySid: 'sid_EntKeepNot',
      factId: 'f_FactKeepNo',
      url: 'https://example.com/news',
      index,
    });
    expect(out.status).toBe('wrote');

    const after = readFileSync(yamlPath, 'utf-8');
    expect(after).toContain(`notes: ${HUMAN_NOTE}`);
    expect(after).toContain('source: https://example.com/news');
    expect(after).not.toContain('[auto-discovered by tb backfill-sources]');
  });
});
