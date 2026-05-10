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
import { writeStakeholderSourceToYaml } from '../yaml-write-stakeholder.ts';
import type { PolicyEntityIndex } from '../yaml-target-resolvers.ts';

const SAMPLE_YAML = `- id: aisi
  stableId: sid_PolicyPol1
  type: policy
  title: AISI
  stakeholders:
    - name: UK Government
      position: support
      importance: high
      reason: pioneered AISI
    - name: US Government
      position: support
      importance: high
      reason: established USAISI
- id: ca-sb1047
  stableId: sid_PolicyPol2
  type: policy
  stakeholders:
    - name: California Senate
      position: oppose
      importance: high
      reason: vetoed
    - name: Tech industry
      position: oppose
      importance: medium
      reason: feared overreach
    - name: Tech industry
      position: support
      importance: low
      reason: subset endorsed gates
`;

let tmpRoot: string;
let yamlPath: string;
let index: PolicyEntityIndex;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yaml-stake-'));
  mkdirSync(tmpRoot, { recursive: true });
  yamlPath = join(tmpRoot, 'responses.yaml');
  writeFileSync(yamlPath, SAMPLE_YAML, 'utf-8');
  index = {
    sidToFilepath: new Map([
      ['sid_PolicyPol1', yamlPath],
      ['sid_PolicyPol2', yamlPath],
    ]),
    parseFailureCount: 0,
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('writeStakeholderSourceToYaml', () => {
  it('writes source to a single name match', () => {
    const out = writeStakeholderSourceToYaml({
      policyEntitySid: 'sid_PolicyPol1',
      stakeholderName: 'UK Government',
      position: 'support',
      url: 'https://example.com/uk-aisi',
      index,
    });
    expect(out.status).toBe('wrote');
    expect(out.filepath).toBe(yamlPath);

    const after = readFileSync(yamlPath, 'utf-8');
    expect(after).toContain('source: https://example.com/uk-aisi');
    expect(after).toContain('reason: pioneered AISI');
    expect(after).toContain('reason: established USAISI');
    // The other policy is untouched.
    expect(after).toContain('California Senate');
  });

  it('skips when source already exists and is non-empty', () => {
    const initial = SAMPLE_YAML.replace(
      'reason: pioneered AISI',
      'reason: pioneered AISI\n      source: https://existing.example.com',
    );
    writeFileSync(yamlPath, initial, 'utf-8');

    const out = writeStakeholderSourceToYaml({
      policyEntitySid: 'sid_PolicyPol1',
      stakeholderName: 'UK Government',
      position: 'support',
      url: 'https://example.com/new-source',
      index,
    });
    expect(out.status).toBe('skipped-existing');
    const after = readFileSync(yamlPath, 'utf-8');
    expect(after).toContain('https://existing.example.com');
    expect(after).not.toContain('https://example.com/new-source');
  });

  it('returns no-yaml-target when policy sid not in index', () => {
    const out = writeStakeholderSourceToYaml({
      policyEntitySid: 'sid_NotInIndex',
      stakeholderName: 'UK Government',
      position: 'support',
      url: 'https://example.com/x',
      index,
    });
    expect(out.status).toBe('no-yaml-target');
    expect(out.filepath).toBeNull();
  });

  it('returns not-found when stakeholder name absent in policy', () => {
    const out = writeStakeholderSourceToYaml({
      policyEntitySid: 'sid_PolicyPol1',
      stakeholderName: 'Atlantis Senate',
      position: 'support',
      url: 'https://example.com/x',
      index,
    });
    expect(out.status).toBe('not-found');
  });

  it('disambiguates duplicate names by position', () => {
    const out = writeStakeholderSourceToYaml({
      policyEntitySid: 'sid_PolicyPol2',
      stakeholderName: 'Tech industry',
      position: 'support',
      url: 'https://example.com/tech-support',
      index,
    });
    expect(out.status).toBe('wrote');

    const after = readFileSync(yamlPath, 'utf-8');
    expect(after).toContain('source: https://example.com/tech-support');
    // The other Tech-industry entry (oppose) does not get a source.
    const opposeSection = after
      .split('- name: Tech industry\n      position: oppose')[1]
      ?.split('- name: Tech industry\n      position: support')[0] ?? '';
    expect(opposeSection).not.toContain('source: https://example.com/tech-support');
  });

  it('returns not-found on duplicate name without a position to disambiguate', () => {
    const out = writeStakeholderSourceToYaml({
      policyEntitySid: 'sid_PolicyPol2',
      stakeholderName: 'Tech industry',
      position: null,
      url: 'https://example.com/x',
      index,
    });
    expect(out.status).toBe('not-found');
  });

  // Regression: PR #4871 showed responses.yaml getting reformatted end-to-end
  // because doc.toString() defaults to lineWidth: 80 and re-wraps every long
  // string literal in the document. The dual-write must touch ONLY the
  // targeted stakeholder's `source:` line — every other byte of the file
  // must be preserved.
  it('preserves long unrelated lines verbatim — does not re-wrap them', () => {
    const LONG_DESCRIPTION =
      'Government-run institutions dedicated to evaluating frontier AI systems for dangerous capabilities and safety properties, pioneered by the UK AISI in 2023, with analogues in the US (USAISI), EU, Japan, and others.';
    const LONG_REASON =
      'Pursues its own parallel AI safety evaluation approach through domestic institutions rather than joining the international AISI network coordinated under the UK Bletchley process';

    const longLineYaml = `- id: aisi
  stableId: sid_PolicyLong
  type: policy
  title: AISI
  description: ${LONG_DESCRIPTION}
  stakeholders:
    - name: UK Government
      position: support
      importance: high
      reason: pioneered AISI
    - name: China
      position: mixed
      importance: medium
      reason: ${LONG_REASON}
`;
    writeFileSync(yamlPath, longLineYaml, 'utf-8');
    index = {
      sidToFilepath: new Map([['sid_PolicyLong', yamlPath]]),
      parseFailureCount: 0,
    };

    const out = writeStakeholderSourceToYaml({
      policyEntitySid: 'sid_PolicyLong',
      stakeholderName: 'UK Government',
      position: 'support',
      url: 'https://example.com/uk-aisi',
      index,
    });
    expect(out.status).toBe('wrote');

    const after = readFileSync(yamlPath, 'utf-8');

    expect(after).toContain(`description: ${LONG_DESCRIPTION}\n`);
    expect(after).toContain(`reason: ${LONG_REASON}\n`);

    const beforeLines = longLineYaml.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines.length).toBe(beforeLines.length + 1);
  });
});
