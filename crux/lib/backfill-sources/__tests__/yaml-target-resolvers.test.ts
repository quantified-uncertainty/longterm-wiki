import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFactbaseEntityIndex,
  buildPolicyEntityIndex,
} from '../yaml-target-resolvers.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yaml-resolvers-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('buildFactbaseEntityIndex', () => {
  it('indexes entity:-format files and skips legacy thing: files', () => {
    const fbDir = join(tmpRoot, 'fb');
    mkdirSync(fbDir, { recursive: true });
    writeFileSync(join(fbDir, 'a.yaml'), 'entity: sid_AAAaaaaaaa\nfacts:\n  - id: f_x\n');
    writeFileSync(join(fbDir, 'b.yaml'), 'entity: sid_BBBbbbbbbb\nfacts: []\n');
    writeFileSync(join(fbDir, 'legacy.yaml'), 'thing:\n  id: legacy-slug\nfacts: []\n');
    writeFileSync(join(fbDir, 'README.md'), 'ignored');

    const idx = buildFactbaseEntityIndex(fbDir);
    expect(idx.sidToFilepath.size).toBe(2);
    expect(idx.sidToFilepath.get('sid_AAAaaaaaaa')).toBe(join(fbDir, 'a.yaml'));
    expect(idx.sidToFilepath.get('sid_BBBbbbbbbb')).toBe(join(fbDir, 'b.yaml'));
    expect(idx.unindexedCount).toBe(1);
  });

  it('returns empty index when directory has no yaml files', () => {
    const dir = join(tmpRoot, 'empty');
    mkdirSync(dir, { recursive: true });
    const idx = buildFactbaseEntityIndex(dir);
    expect(idx.sidToFilepath.size).toBe(0);
    expect(idx.unindexedCount).toBe(0);
  });
});

describe('buildPolicyEntityIndex', () => {
  it('indexes only policy-type entities with stableId', () => {
    const dir = join(tmpRoot, 'entities');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'mixed.yaml'),
      [
        '- id: an-org',
        '  stableId: sid_OrgOrgOrgO',
        '  type: organization',
        '- id: a-policy',
        '  stableId: sid_PolicyPol1',
        '  type: policy',
        '  stakeholders:',
        '    - name: Foo',
        '      position: support',
        '- id: another-policy',
        '  stableId: sid_PolicyPol2',
        '  type: policy',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'just-a-concept.yaml'),
      [
        '- id: a-concept',
        '  stableId: sid_ConceptCo1',
        '  type: concept',
        '',
      ].join('\n'),
    );

    const idx = buildPolicyEntityIndex(dir);
    expect(idx.sidToFilepath.size).toBe(2);
    expect(idx.sidToFilepath.get('sid_PolicyPol1')).toBe(join(dir, 'mixed.yaml'));
    expect(idx.sidToFilepath.get('sid_PolicyPol2')).toBe(join(dir, 'mixed.yaml'));
    expect(idx.parseFailureCount).toBe(0);
  });

  it('counts parse failures without throwing', () => {
    const dir = join(tmpRoot, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.yaml'), '{{{not yaml');
    writeFileSync(join(dir, 'ok.yaml'), '- id: x\n  stableId: sid_OkOkOkOkOk\n  type: policy\n');

    const idx = buildPolicyEntityIndex(dir);
    expect(idx.sidToFilepath.size).toBe(1);
    expect(idx.parseFailureCount).toBe(1);
  });

  it('skips entries without stableId or with non-sid stableId', () => {
    const dir = join(tmpRoot, 'skip');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'x.yaml'),
      [
        '- id: nope-no-sid',
        '  type: policy',
        '- id: nope-bare-id',
        '  stableId: bare10char',
        '  type: policy',
        '',
      ].join('\n'),
    );
    const idx = buildPolicyEntityIndex(dir);
    expect(idx.sidToFilepath.size).toBe(0);
  });
});
