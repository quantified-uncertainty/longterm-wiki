import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseRegistry,
  loadRegistry,
  defaultRegistryPath,
  frameworkIdFromKey,
  versionIdFromHash,
  _resetRegistryCache,
} from './registry.ts';

const VALID = `
version: 1

frameworks:
  alpha:
    org_slug: orgalpha
    name: "Alpha Framework"
    short_name: "AF"
    framework_family: "alpha-fam"
    status: active
    versions:
      - version_label: "v1"
        published_date: "2024-01-01"
        source_url: "https://example.com/v1"
      - version_label: "v2"
        published_date: "2025-06-01"
        source_url: "https://example.com/v2"

  beta:
    org_slug: orgbeta
    name: "Beta Framework"
    status: active
    notes: "Single version only."
    versions:
      - version_label: "v1 draft"
        published_date: "2024-08-01"
        source_url: "https://example.com/beta-v1.pdf"
        is_draft: true
`;

beforeEach(() => {
  _resetRegistryCache();
});

describe('parseRegistry', () => {
  it('parses two frameworks with their versions', () => {
    const out = parseRegistry(VALID);
    expect(out.length).toBe(2);
    // Sorted by key.
    expect(out[0].key).toBe('alpha');
    expect(out[1].key).toBe('beta');
  });

  it('assigns deterministic frameworkId from key', () => {
    const out = parseRegistry(VALID);
    expect(out[0].frameworkId).toBe(frameworkIdFromKey('alpha'));
    expect(out[1].frameworkId).toBe(frameworkIdFromKey('beta'));
    expect(out[0].frameworkId).not.toBe(out[1].frameworkId);
  });

  it('orders versions by publishedDate ascending and assigns sortOrder', () => {
    const out = parseRegistry(VALID);
    const alpha = out.find((e) => e.key === 'alpha')!;
    expect(alpha.versions.map((v) => v.versionLabel)).toEqual(['v1', 'v2']);
    expect(alpha.versions[0].versionSortOrder).toBe(1);
    expect(alpha.versions[1].versionSortOrder).toBe(2);
  });

  it('preserves is_draft on versions', () => {
    const out = parseRegistry(VALID);
    const beta = out.find((e) => e.key === 'beta')!;
    expect(beta.versions[0].isDraft).toBe(true);
    expect(out[0].versions[0].isDraft).toBe(false); // default
  });

  it('preserves notes / shortName / frameworkFamily / status', () => {
    const out = parseRegistry(VALID);
    expect(out[0].shortName).toBe('AF');
    expect(out[0].frameworkFamily).toBe('alpha-fam');
    expect(out[0].status).toBe('active');
    expect(out[0].notes).toBeNull();
    expect(out[1].notes).toBe('Single version only.');
  });

  it('throws on missing org_slug', () => {
    expect(() =>
      parseRegistry(`
version: 1
frameworks:
  bad:
    name: "Foo"
    versions:
      - version_label: v1
        published_date: "2024-01-01"
        source_url: "https://x"
`),
    ).toThrow(/missing org_slug/);
  });

  it('throws on missing name', () => {
    expect(() =>
      parseRegistry(`
version: 1
frameworks:
  bad:
    org_slug: x
    versions:
      - version_label: v1
        published_date: "2024-01-01"
        source_url: "https://x"
`),
    ).toThrow(/missing name/);
  });

  it('throws on a framework with zero versions', () => {
    expect(() =>
      parseRegistry(`
version: 1
frameworks:
  bad:
    org_slug: x
    name: "Foo"
    versions: []
`),
    ).toThrow(/at least one version/);
  });

  it('throws on missing version_label', () => {
    expect(() =>
      parseRegistry(`
version: 1
frameworks:
  bad:
    org_slug: x
    name: "Foo"
    versions:
      - published_date: "2024-01-01"
        source_url: "https://x"
`),
    ).toThrow(/missing version_label/);
  });

  it('throws on missing published_date', () => {
    expect(() =>
      parseRegistry(`
version: 1
frameworks:
  bad:
    org_slug: x
    name: "Foo"
    versions:
      - version_label: v1
        source_url: "https://x"
`),
    ).toThrow(/missing published_date/);
  });

  it('throws on invalid status', () => {
    expect(() =>
      parseRegistry(`
version: 1
frameworks:
  bad:
    org_slug: x
    name: "Foo"
    status: nonsense
    versions:
      - version_label: v1
        published_date: "2024-01-01"
        source_url: "https://x"
`),
    ).toThrow(/invalid status/);
  });

  it('throws on unsupported registry version', () => {
    expect(() =>
      parseRegistry(`
version: 999
frameworks: {}
`),
    ).toThrow(/unsupported registry version/);
  });

  it('returns an empty array when frameworks is missing or empty', () => {
    expect(parseRegistry('version: 1\n').length).toBe(0);
    expect(parseRegistry('version: 1\nframeworks: {}\n').length).toBe(0);
  });
});

describe('frameworkIdFromKey', () => {
  it('returns a 10-char alphanumeric id', () => {
    const id = frameworkIdFromKey('anthropic-rsp');
    expect(id).toMatch(/^[A-Za-z0-9]{10}$/);
  });

  it('is deterministic — same key produces the same id', () => {
    expect(frameworkIdFromKey('anthropic-rsp')).toBe(frameworkIdFromKey('anthropic-rsp'));
  });

  it('different keys produce different ids', () => {
    expect(frameworkIdFromKey('alpha')).not.toBe(frameworkIdFromKey('beta'));
  });
});

describe('versionIdFromHash', () => {
  it('returns 10-char alphanumeric, deterministic', () => {
    const id = versionIdFromHash('fid', 'v1', 'abc123');
    expect(id).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(versionIdFromHash('fid', 'v1', 'abc123')).toBe(id);
  });

  it('different content hashes produce different ids', () => {
    expect(versionIdFromHash('fid', 'v1', 'a')).not.toBe(versionIdFromHash('fid', 'v1', 'b'));
  });

  it('different version labels produce different ids', () => {
    expect(versionIdFromHash('fid', 'v1', 'a')).not.toBe(versionIdFromHash('fid', 'v2', 'a'));
  });
});

describe('loadRegistry — actual data/frameworks/frameworks.yaml', () => {
  it('loads the live registry file without error and returns 12 frameworks', () => {
    const out = loadRegistry();
    // The QUA-691 manifest declares 12 frameworks. If you add one, update
    // this expectation explicitly so the change is visible in the diff.
    expect(out.length).toBe(12);
    // Smoke-check a couple of well-known entries.
    const anthropic = out.find((e) => e.key === 'anthropic-rsp');
    expect(anthropic).toBeDefined();
    expect(anthropic!.orgId).toBe('anthropic');
    expect(anthropic!.versions.length).toBeGreaterThanOrEqual(6);
    const openai = out.find((e) => e.key === 'openai-preparedness');
    expect(openai).toBeDefined();
    expect(openai!.versions.length).toBe(2);
  });

  it('every version has versionSortOrder >= 1 and a published_date', () => {
    const out = loadRegistry();
    for (const fw of out) {
      for (const v of fw.versions) {
        expect(v.versionSortOrder).toBeGreaterThanOrEqual(1);
        expect(v.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(v.sourceUrl).toMatch(/^https?:\/\//);
      }
    }
  });

  it('defaultRegistryPath ends with data/frameworks/frameworks.yaml', () => {
    const p = defaultRegistryPath('/some/root');
    expect(p).toMatch(/data\/frameworks\/frameworks\.yaml$/);
  });
});
