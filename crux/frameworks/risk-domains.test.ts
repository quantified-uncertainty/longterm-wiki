import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  normalizeRiskDomain,
  renderAliasesForPrompt,
  loadRiskDomainAliases,
  resetAliasCache,
  CANONICAL_DOMAINS,
} from './risk-domains.ts';

describe('normalizeRiskDomain', () => {
  beforeEach(() => resetAliasCache());

  it('matches the canonical key case-insensitively', () => {
    expect(normalizeRiskDomain('cbrn')).toBe('cbrn');
    expect(normalizeRiskDomain('CBRN')).toBe('cbrn');
    expect(normalizeRiskDomain('Cyber')).toBe('cyber');
    expect(normalizeRiskDomain('ai_rd')).toBe('ai_rd');
  });

  it('resolves common aliases', () => {
    expect(normalizeRiskDomain('Biological')).toBe('bio');
    expect(normalizeRiskDomain('Bioweapons')).toBe('bio');
    expect(normalizeRiskDomain('Offensive cyber')).toBe('cyber');
    expect(normalizeRiskDomain('AI R&D')).toBe('ai_rd');
    expect(normalizeRiskDomain('Self-replication')).toBe('autonomy_replication');
    expect(normalizeRiskDomain('Loss of Control')).toBe('loss_of_control');
  });

  it('returns null on no match', () => {
    expect(normalizeRiskDomain('gibberish')).toBeNull();
    expect(normalizeRiskDomain('')).toBeNull();
    // @ts-expect-error — adversarial: wrong type
    expect(normalizeRiskDomain(null)).toBeNull();
  });

  it('trims whitespace before matching', () => {
    expect(normalizeRiskDomain('  CBRN  ')).toBe('cbrn');
    expect(normalizeRiskDomain('\tCyber\n')).toBe('cyber');
  });
});

describe('renderAliasesForPrompt', () => {
  it('includes every canonical domain except the "other" catch-all', () => {
    const out = renderAliasesForPrompt();
    for (const d of CANONICAL_DOMAINS) {
      if (d === 'other') continue;
      expect(out).toContain(d);
    }
  });

  it('omits the "other" placeholder', () => {
    const out = renderAliasesForPrompt();
    // "other" with no aliases would otherwise appear as "- other".
    expect(out).not.toContain('- other');
  });
});

describe('loadRiskDomainAliases (missing file)', () => {
  it('returns an empty map rather than throwing when the file is absent', () => {
    resetAliasCache();
    const path = join(tmpdir(), `risk-domains-missing-${Date.now()}.yaml`);
    if (existsSync(path)) unlinkSync(path);
    const file = loadRiskDomainAliases(path);
    expect(file.domains).toEqual({});
  });

  it('normalizes malformed YAML to empty', () => {
    resetAliasCache();
    const path = join(tmpdir(), `risk-domains-bad-${Date.now()}.yaml`);
    // Write YAML without a `domains:` key — the loader should treat it as empty.
    writeFileSync(path, 'version: 1\nnot_domains: {}\n', 'utf-8');
    try {
      const file = loadRiskDomainAliases(path);
      expect(file.domains).toEqual({});
    } finally {
      unlinkSync(path);
    }
  });
});
