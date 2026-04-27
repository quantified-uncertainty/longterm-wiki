import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  labForUrl,
  renderLabHintsForPrompt,
  loadLabHints,
  resetLabHintsCache,
} from './lab-hints.ts';

function writeFixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lab-hints-'));
  const path = join(dir, 'labs.yaml');
  writeFileSync(path, content);
  return path;
}

const FIXTURE = `
labs:
  anthropic:
    safety_framework: ASL
    url_patterns:
      - anthropic.com
      - www-cdn.anthropic.com
    expected_fields: [safety_tier, eval_scores_cited]
    known_absent: [training_compute_flops]
    section_hints:
      safety_tier: "Look for 'ASL-N' tier."

  openai:
    safety_framework: Preparedness
    url_patterns:
      - openai.com
      - cdn.openai.com
    expected_fields: [safety_tier_domains]
`;

describe('loadLabHints', () => {
  beforeEach(() => resetLabHintsCache());

  it('returns an empty labs object when file is missing', () => {
    const file = loadLabHints('/tmp/does-not-exist-lab-hints-test.yaml');
    expect(file.labs).toEqual({});
  });

  it('loads the real labs config and contains the expected labs', () => {
    // The real file at data/auto-update/system-card-labs.yaml — don't use
    // the default cache path, we reset the cache in beforeEach and load it
    // fresh so this test is deterministic.
    const file = loadLabHints('data/auto-update/system-card-labs.yaml');
    expect(file.labs).toBeDefined();
    expect(Object.keys(file.labs).length).toBeGreaterThan(0);
    expect(file.labs.anthropic).toBeDefined();
    expect(file.labs.openai).toBeDefined();
  });
});

describe('labForUrl', () => {
  beforeEach(() => resetLabHintsCache());

  it('matches Anthropic URLs', () => {
    const path = writeFixture(FIXTURE);
    const file = loadLabHints(path);
    expect(labForUrl('https://www.anthropic.com/claude-4-system-card', file)).toBe(
      'anthropic',
    );
    expect(
      labForUrl('https://www-cdn.anthropic.com/xxx/Claude-4.pdf', file),
    ).toBe('anthropic');
  });

  it('matches OpenAI URLs', () => {
    const path = writeFixture(FIXTURE);
    const file = loadLabHints(path);
    expect(labForUrl('https://openai.com/index/gpt5-system-card/', file)).toBe(
      'openai',
    );
    expect(labForUrl('https://cdn.openai.com/uuid/card.pdf', file)).toBe('openai');
  });

  it('returns null for unrecognized URLs', () => {
    const path = writeFixture(FIXTURE);
    const file = loadLabHints(path);
    expect(labForUrl('https://random-blog.example/whatever', file)).toBeNull();
  });
});

describe('renderLabHintsForPrompt', () => {
  beforeEach(() => resetLabHintsCache());

  it('returns empty string when no lab', () => {
    const path = writeFixture(FIXTURE);
    const file = loadLabHints(path);
    expect(renderLabHintsForPrompt(null, file)).toBe('');
  });

  it('returns empty string when lab key not in config', () => {
    const path = writeFixture(FIXTURE);
    const file = loadLabHints(path);
    expect(renderLabHintsForPrompt('unknown-lab', file)).toBe('');
  });

  it('renders framework, expected, known_absent, and section hints', () => {
    const path = writeFixture(FIXTURE);
    const file = loadLabHints(path);
    const rendered = renderLabHintsForPrompt('anthropic', file);
    expect(rendered).toContain('Lab: anthropic');
    expect(rendered).toContain('Safety framework: ASL');
    expect(rendered).toContain('safety_tier');
    expect(rendered).toContain('training_compute_flops');
    expect(rendered).toContain("Look for 'ASL-N' tier.");
  });
});
