import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  canonicalizeEntityType,
  loadPlaybook,
  listPlaybookTypes,
  formatPlaybookMarkdown,
  formatPlaybookForPrompt,
  PLAYBOOKS_DIR,
  type ResearchPlaybook,
} from '../research-playbooks.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_YAML = `
entityType: organization
description: Test playbook for orgs.
checklist:
  - Founding year
  - Headcount
sources:
  - name: Crunchbase
    reliability: medium
    covers: [funding, investors]
    pitfalls:
      - Headcount is stale
  - name: SEC EDGAR
    reliability: very-high
    covers: [financials]
    applies_when: publicly traded
common_pitfalls:
  - Conflating parent and subsidiary
research_order:
  - Start with official site
  - Cross-reference aggregators
`;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'playbooks-test-'));
}

function writePlaybook(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, `${name}.yaml`), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// canonicalizeEntityType
// ---------------------------------------------------------------------------

describe('canonicalizeEntityType', () => {
  it('returns null for empty / whitespace / null / undefined input', () => {
    expect(canonicalizeEntityType(null)).toBeNull();
    expect(canonicalizeEntityType(undefined)).toBeNull();
    expect(canonicalizeEntityType('')).toBeNull();
    expect(canonicalizeEntityType('   ')).toBeNull();
  });

  it('passes through canonical types unchanged', () => {
    expect(canonicalizeEntityType('organization')).toBe('organization');
    expect(canonicalizeEntityType('person')).toBe('person');
    expect(canonicalizeEntityType('ai-model')).toBe('ai-model');
  });

  it('resolves common aliases to canonical form', () => {
    expect(canonicalizeEntityType('researcher')).toBe('person');
    expect(canonicalizeEntityType('lab')).toBe('organization');
    expect(canonicalizeEntityType('lab-frontier')).toBe('organization');
    expect(canonicalizeEntityType('funder')).toBe('organization');
  });

  it('trims surrounding whitespace before lookup', () => {
    expect(canonicalizeEntityType('  person  ')).toBe('person');
    expect(canonicalizeEntityType('  researcher  ')).toBe('person');
  });

  it('returns the unknown type unchanged when it is not an alias', () => {
    // Unknown types pass through so callers can detect "no playbook" via loadPlaybook.
    expect(canonicalizeEntityType('widget')).toBe('widget');
  });
});

// ---------------------------------------------------------------------------
// loadPlaybook
// ---------------------------------------------------------------------------

describe('loadPlaybook', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the playbook file does not exist', () => {
    expect(loadPlaybook('organization', { dir: tmpDir })).toBeNull();
  });

  it('returns null for empty or nullish entity types', () => {
    expect(loadPlaybook(null, { dir: tmpDir })).toBeNull();
    expect(loadPlaybook(undefined, { dir: tmpDir })).toBeNull();
    expect(loadPlaybook('', { dir: tmpDir })).toBeNull();
  });

  it('loads and validates a well-formed playbook', () => {
    writePlaybook(tmpDir, 'organization', VALID_YAML);
    const pb = loadPlaybook('organization', { dir: tmpDir });
    expect(pb).not.toBeNull();
    expect(pb!.entityType).toBe('organization');
    expect(pb!.checklist).toEqual(['Founding year', 'Headcount']);
    expect(pb!.sources).toHaveLength(2);
    expect(pb!.sources[0].name).toBe('Crunchbase');
    expect(pb!.sources[0].reliability).toBe('medium');
    expect(pb!.sources[0].covers).toEqual(['funding', 'investors']);
    expect(pb!.sources[1].applies_when).toBe('publicly traded');
    expect(pb!.common_pitfalls).toEqual(['Conflating parent and subsidiary']);
    expect(pb!.research_order).toHaveLength(2);
  });

  it('defaults common_pitfalls and research_order to empty arrays when missing', () => {
    writePlaybook(
      tmpDir,
      'minimal',
      `
entityType: minimal
description: Minimal playbook.
checklist: [One fact]
sources:
  - name: Some source
    reliability: high
    covers: [everything]
`,
    );
    const pb = loadPlaybook('minimal', { dir: tmpDir });
    expect(pb).not.toBeNull();
    expect(pb!.common_pitfalls).toEqual([]);
    expect(pb!.research_order).toEqual([]);
  });

  it('canonicalizes aliases before lookup (researcher → person)', () => {
    writePlaybook(tmpDir, 'person', VALID_YAML.replace('organization', 'person'));
    const pb = loadPlaybook('researcher', { dir: tmpDir });
    expect(pb).not.toBeNull();
    expect(pb!.entityType).toBe('person');
  });

  it('canonicalizes aliases before lookup (lab-frontier → organization)', () => {
    writePlaybook(tmpDir, 'organization', VALID_YAML);
    const pb = loadPlaybook('lab-frontier', { dir: tmpDir });
    expect(pb).not.toBeNull();
    expect(pb!.entityType).toBe('organization');
  });

  it('returns null for malformed YAML (syntax error) without throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writePlaybook(tmpDir, 'organization', '::: not valid yaml :::\n  - oops');
    const pb = loadPlaybook('organization', { dir: tmpDir });
    expect(pb).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns null when YAML is valid but violates the schema', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writePlaybook(
      tmpDir,
      'organization',
      `
entityType: organization
description: Missing required fields.
`,
    );
    const pb = loadPlaybook('organization', { dir: tmpDir });
    expect(pb).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('rejects a source with an invalid reliability value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writePlaybook(
      tmpDir,
      'organization',
      `
entityType: organization
description: Test.
checklist: [X]
sources:
  - name: Bad source
    reliability: mediocre
    covers: [foo]
`,
    );
    expect(loadPlaybook('organization', { dir: tmpDir })).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('rejects a playbook with empty checklist or sources arrays', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writePlaybook(
      tmpDir,
      'organization',
      `
entityType: organization
description: Empty lists.
checklist: []
sources: []
`,
    );
    expect(loadPlaybook('organization', { dir: tmpDir })).toBeNull();
    warnSpy.mockRestore();
  });

  it('warns when file entityType disagrees with the resolved canonical key but still loads', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // File is named organization.yaml but declares a different entityType.
    writePlaybook(tmpDir, 'organization', VALID_YAML.replace('entityType: organization', 'entityType: project'));
    const pb = loadPlaybook('organization', { dir: tmpDir });
    expect(pb).not.toBeNull();
    expect(pb!.entityType).toBe('project');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('entityType mismatch'));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// listPlaybookTypes
// ---------------------------------------------------------------------------

describe('listPlaybookTypes', () => {
  it('returns [] for a non-existent directory', () => {
    const tmpDir = path.join(os.tmpdir(), `definitely-missing-${Date.now()}`);
    expect(listPlaybookTypes({ dir: tmpDir })).toEqual([]);
  });

  it('returns the canonical names of all .yaml files, sorted', () => {
    const tmpDir = makeTempDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'organization.yaml'), '');
      fs.writeFileSync(path.join(tmpDir, 'person.yaml'), '');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), ''); // filtered out
      fs.writeFileSync(path.join(tmpDir, 'ai-model.yaml'), '');
      expect(listPlaybookTypes({ dir: tmpDir })).toEqual(['ai-model', 'organization', 'person']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const SAMPLE_PLAYBOOK: ResearchPlaybook = {
  entityType: 'organization',
  description: 'Sample description.',
  checklist: ['Founding year', 'Total funding'],
  sources: [
    {
      name: 'Crunchbase',
      reliability: 'medium',
      covers: ['funding', 'investors'],
      pitfalls: ['Headcount is stale'],
    },
    {
      name: 'SEC EDGAR',
      reliability: 'very-high',
      covers: ['financials'],
      applies_when: 'publicly traded',
    },
  ],
  common_pitfalls: ['Parent vs subsidiary confusion'],
  research_order: ['Step 1', 'Step 2'],
};

describe('formatPlaybookMarkdown', () => {
  it('renders all sections present in the playbook', () => {
    const md = formatPlaybookMarkdown(SAMPLE_PLAYBOOK);
    expect(md).toContain('## Research Playbook: organization');
    expect(md).toContain('Sample description.');
    expect(md).toContain('### Standard Checklist');
    expect(md).toContain('- Founding year');
    expect(md).toContain('### Recommended Sources');
    expect(md).toContain('| Crunchbase | medium |');
    expect(md).toContain('Headcount is stale');
    expect(md).toContain('_when_: publicly traded');
    expect(md).toContain('### Recommended Research Order');
    expect(md).toContain('1. Step 1');
    expect(md).toContain('### Common Pitfalls');
    expect(md).toContain('- Parent vs subsidiary confusion');
  });

  it('omits optional sections when arrays are empty', () => {
    const md = formatPlaybookMarkdown({
      ...SAMPLE_PLAYBOOK,
      common_pitfalls: [],
      research_order: [],
    });
    expect(md).not.toContain('Recommended Research Order');
    expect(md).not.toContain('Common Pitfalls');
  });

  it('escapes pipe characters in table cells', () => {
    const md = formatPlaybookMarkdown({
      ...SAMPLE_PLAYBOOK,
      sources: [
        {
          name: 'Weird | Source',
          reliability: 'high',
          covers: ['a | b'],
        },
      ],
    });
    expect(md).toContain('Weird \\| Source');
    expect(md).toContain('a \\| b');
  });
});

describe('formatPlaybookForPrompt', () => {
  it('includes all core sections in compact form', () => {
    const prompt = formatPlaybookForPrompt(SAMPLE_PLAYBOOK);
    expect(prompt).toContain('# Research Playbook: organization');
    expect(prompt).toContain('Sample description.');
    expect(prompt).toContain('## Standard data points to gather');
    expect(prompt).toContain('- Founding year');
    expect(prompt).toContain('## Recommended sources (in priority order)');
    expect(prompt).toContain('**Crunchbase** (medium)');
    expect(prompt).toContain('**SEC EDGAR** (very-high)');
    expect(prompt).toContain('[publicly traded]');
    expect(prompt).toContain('pitfall: Headcount is stale');
    expect(prompt).toContain('## Recommended research order');
    expect(prompt).toContain('1. Step 1');
    expect(prompt).toContain('## Common pitfalls to avoid');
  });

  it('is shorter than the markdown variant for the same input', () => {
    const prompt = formatPlaybookForPrompt(SAMPLE_PLAYBOOK);
    const md = formatPlaybookMarkdown(SAMPLE_PLAYBOOK);
    // Prompt form skips the table scaffolding, so it should be noticeably shorter.
    expect(prompt.length).toBeLessThan(md.length);
  });
});

// ---------------------------------------------------------------------------
// Integration: the real repo playbooks must parse cleanly
// ---------------------------------------------------------------------------

describe('checked-in playbooks', () => {
  it('organization.yaml loads and has the expected shape', () => {
    const pb = loadPlaybook('organization', { dir: PLAYBOOKS_DIR });
    expect(pb).not.toBeNull();
    expect(pb!.entityType).toBe('organization');
    expect(pb!.sources.length).toBeGreaterThan(0);
    expect(pb!.checklist.length).toBeGreaterThan(0);
  });

  it('person.yaml loads and has the expected shape', () => {
    const pb = loadPlaybook('person', { dir: PLAYBOOKS_DIR });
    expect(pb).not.toBeNull();
    expect(pb!.entityType).toBe('person');
    expect(pb!.sources.length).toBeGreaterThan(0);
    expect(pb!.checklist.length).toBeGreaterThan(0);
  });

  it('researcher alias resolves to person via loadPlaybook', () => {
    const pb = loadPlaybook('researcher', { dir: PLAYBOOKS_DIR });
    expect(pb).not.toBeNull();
    expect(pb!.entityType).toBe('person');
  });

  it('lab-frontier alias resolves to organization via loadPlaybook', () => {
    const pb = loadPlaybook('lab-frontier', { dir: PLAYBOOKS_DIR });
    expect(pb).not.toBeNull();
    expect(pb!.entityType).toBe('organization');
  });
});
