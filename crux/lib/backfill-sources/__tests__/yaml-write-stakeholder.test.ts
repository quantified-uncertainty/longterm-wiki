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
  // because doc.toString() defaults to lineWidth: 80 and re-wraps long string
  // literals (typical descriptions/reasons in these files are ~100 chars).
  // We pass lineWidth: 120 to match the convention used by other writers
  // (extract-structured-data, political-data, factbase-migrate) so the same
  // file isn't re-folded back and forth. Lines ≤120 chars must survive
  // verbatim.
  it('preserves moderately-long unrelated lines verbatim (≤120 cols)', () => {
    // 90-100 chars at deepest indent — would fold at default 80, must NOT
    // fold at 120 even after the stakeholder-level indent (6 spaces).
    const MODERATE_DESCRIPTION =
      'Government-run AISI institutions evaluating frontier AI systems for dangerous capabilities.';
    const MODERATE_REASON =
      'Pursues its own AI safety evaluation approach through domestic institutions.';

    const moderateLineYaml = `- id: aisi
  stableId: sid_PolicyMod1
  type: policy
  title: AISI
  description: ${MODERATE_DESCRIPTION}
  stakeholders:
    - name: UK Government
      position: support
      importance: high
      reason: pioneered AISI
    - name: China
      position: mixed
      importance: medium
      reason: ${MODERATE_REASON}
`;
    writeFileSync(yamlPath, moderateLineYaml, 'utf-8');
    index = {
      sidToFilepath: new Map([['sid_PolicyMod1', yamlPath]]),
      parseFailureCount: 0,
    };

    const out = writeStakeholderSourceToYaml({
      policyEntitySid: 'sid_PolicyMod1',
      stakeholderName: 'UK Government',
      position: 'support',
      url: 'https://example.com/uk-aisi',
      index,
    });
    expect(out.status).toBe('wrote');

    const after = readFileSync(yamlPath, 'utf-8');

    expect(after).toContain(`description: ${MODERATE_DESCRIPTION}\n`);
    expect(after).toContain(`reason: ${MODERATE_REASON}\n`);

    const beforeLines = moderateLineYaml.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines.length).toBe(beforeLines.length + 1);
  });
});
