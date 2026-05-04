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
});
