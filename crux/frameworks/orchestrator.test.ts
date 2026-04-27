import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildFrameworkSyncItems,
  buildVersionSyncItem,
  runIngest,
  type IngestDeps,
  type FrameworkSyncItem,
  type VersionSyncItem,
} from './orchestrator.ts';
import { _resetRegistryCache, frameworkIdFromKey, versionIdFromHash } from './registry.ts';
import type { ExtractResult, ExtractedThreshold } from './extract.ts';
import type { FetchResult } from './fetch.ts';
import type { DiffAggregate } from './diff.ts';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const REGISTRY_FIXTURE = `
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
        source_url: "https://example.com/alpha-v1"
      - version_label: "v2"
        published_date: "2025-06-01"
        source_url: "https://example.com/alpha-v2"
  beta:
    org_slug: orgbeta
    name: "Beta Framework"
    status: active
    versions:
      - version_label: "v1"
        published_date: "2024-08-01"
        source_url: "https://example.com/beta-v1"
`;

let fixturePath: string;

beforeEach(() => {
  _resetRegistryCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frameworks-fixture-'));
  fixturePath = path.join(tmp, 'frameworks.yaml');
  fs.writeFileSync(fixturePath, REGISTRY_FIXTURE);
});

function fakeFetch(contentHash: string, lengthChars = 1234): FetchResult {
  return {
    sourceText: 'fake source body',
    contentLengthChars: lengthChars,
    contentHash,
    contentType: 'html',
    httpStatus: 200,
    canonicalUrl: 'https://example.com/canonical',
    waybackSnapshotUrl: null,
  };
}

function fakeThreshold(overrides: Partial<ExtractedThreshold> = {}): ExtractedThreshold {
  return {
    riskDomainCanonical: 'cbrn',
    riskDomainLabel: 'CBRN',
    tierLabel: 'High',
    tierSortOrder: 3,
    triggerDescription: 'capability X',
    sourceQuote: 'a quote',
    sourcePageHint: null,
    requiredMitigations: null,
    associatedEvals: null,
    commitmentLanguage: 'committed',
    extractionConfidence: 0.9,
    ...overrides,
  };
}

function fakeExtract(thresholds: ExtractedThreshold[] = [fakeThreshold()]): ExtractResult {
  return {
    thresholds,
    candidateCount: thresholds.length,
    unverifiedCount: 0,
    sourceText: 'fake',
    sourceFormat: 'html',
    sourceHash: 'hash-from-extract',
    contentLengthChars: 100,
    usage: { input_tokens: 1, output_tokens: 1 },
    pass1Model: 'claude-haiku-test',
    pass2Model: 'claude-sonnet-test',
    extractorVersion: 'test@1',
    extractedAt: new Date().toISOString(),
  };
}

function fakeAggregate(items: DiffAggregate['items'] = []): DiffAggregate {
  return {
    items,
    changeSummary: 'no changes',
    weakeningFlagged: false,
    strengtheningFlagged: false,
    neutralChangesCount: 0,
    overallDirection: 'neutral',
  };
}

interface RecordingDeps extends IngestDeps {
  calls: {
    fetched: string[];
    extracted: string[];
    diffed: number;
    syncedFrameworks: FrameworkSyncItem[][];
    syncedVersions: VersionSyncItem[][];
    syncedThresholds: Array<Record<string, unknown>>[];
    syncedDiffs: Array<Record<string, unknown>>[];
    syncedDiffItems: Array<Record<string, unknown>>[];
    existingChecks: string[];
  };
  /** Map of versionId → "exists" so we can simulate skip-if-exists. */
  existing: Set<string>;
}

function makeDeps(opts: {
  /** Map version url → contentHash. Different hash per call would need an array; not needed yet. */
  hashByUrl?: Record<string, string>;
  /** Make every fetch fail with this message. */
  fetchError?: string;
  /** Make extraction fail (used to test extract_failed status). */
  extractError?: string;
  /** Pre-populate the "existing" set so fetchExistingVersion returns truthy. */
  preExisting?: string[];
} = {}): RecordingDeps {
  const calls: RecordingDeps['calls'] = {
    fetched: [],
    extracted: [],
    diffed: 0,
    syncedFrameworks: [],
    syncedVersions: [],
    syncedThresholds: [],
    syncedDiffs: [],
    syncedDiffItems: [],
    existingChecks: [],
  };
  const existing = new Set<string>(opts.preExisting ?? []);
  return {
    calls,
    existing,
    fetchFramework: async (o) => {
      calls.fetched.push(o.url);
      if (opts.fetchError) throw new Error(opts.fetchError);
      const hash = opts.hashByUrl?.[o.url] ?? `hash-${o.url}`;
      return fakeFetch(hash);
    },
    extractFrameworkThresholds: async (o) => {
      calls.extracted.push(o.url);
      if (opts.extractError) throw new Error(opts.extractError);
      return fakeExtract();
    },
    diffFrameworkVersions: async () => {
      calls.diffed++;
      return fakeAggregate([
        {
          changeType: 'mitigation_softened',
          riskDomainCanonical: 'cbrn',
          beforeSnapshot: null,
          afterSnapshot: null,
          severity: 2,
          classifierTag: 'weaker',
          rationale: 'because',
        },
      ]);
    },
    fetchExistingVersion: async (id) => {
      calls.existingChecks.push(id);
      return existing.has(id) ? { id } : null;
    },
    syncFrameworks: async (items) => {
      calls.syncedFrameworks.push(items);
    },
    syncVersions: async (items) => {
      calls.syncedVersions.push(items);
    },
    syncThresholds: async (items) => {
      calls.syncedThresholds.push(items);
    },
    syncDiffs: async (items) => {
      calls.syncedDiffs.push(items);
    },
    syncDiffItems: async (items) => {
      calls.syncedDiffItems.push(items);
    },
    log: () => {
      /* silent in tests */
    },
  };
}

// ---------------------------------------------------------------------------
// buildFrameworkSyncItems / buildVersionSyncItem (pure helpers)
// ---------------------------------------------------------------------------

describe('buildFrameworkSyncItems', () => {
  it('builds one item per framework with derived firstPublishedDate', () => {
    const entries = [
      {
        key: 'k',
        frameworkId: frameworkIdFromKey('k'),
        orgId: 'o',
        name: 'N',
        shortName: null,
        frameworkFamily: null,
        status: 'active' as const,
        notes: null,
        versions: [
          { versionLabel: 'v1', publishedDate: '2024-01-01', sourceUrl: 'u1', isDraft: false, versionSortOrder: 1 },
          { versionLabel: 'v2', publishedDate: '2025-01-01', sourceUrl: 'u2', isDraft: false, versionSortOrder: 2 },
        ],
      },
    ];
    const items = buildFrameworkSyncItems(entries);
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(entries[0].frameworkId);
    expect(items[0].orgId).toBe('o');
    expect(items[0].firstPublishedDate).toBe('2024-01-01');
    expect(items[0].currentStatus).toBe('active');
  });

  it('handles a framework with no versions gracefully (firstPublishedDate=null)', () => {
    const items = buildFrameworkSyncItems([
      {
        key: 'k', frameworkId: 'AAAAAAAAAA', orgId: 'o', name: 'N',
        shortName: null, frameworkFamily: null, status: 'active', notes: null,
        versions: [],
      },
    ]);
    expect(items[0].firstPublishedDate).toBe(null);
  });
});

describe('buildVersionSyncItem', () => {
  it('uses the contentHash for the deterministic version id', () => {
    const fw = {
      key: 'k', frameworkId: 'FRAMEWORK00', orgId: 'o', name: 'N',
      shortName: null, frameworkFamily: null, status: 'active' as const, notes: null,
      versions: [],
    };
    const version = {
      versionLabel: 'v1', publishedDate: '2024-01-01',
      sourceUrl: 'https://example.com/x', isDraft: false, versionSortOrder: 1,
    };
    const fetched = fakeFetch('CONTENT_HASH_AAA');
    const item = buildVersionSyncItem(fw, version, fetched, new Date('2026-04-24T12:00:00Z'));

    expect(item.id).toBe(versionIdFromHash('FRAMEWORK00', 'v1', 'CONTENT_HASH_AAA'));
    expect(item.frameworkId).toBe('FRAMEWORK00');
    expect(item.versionLabel).toBe('v1');
    expect(item.contentHash).toBe('CONTENT_HASH_AAA');
    expect(item.discoveredDate).toBe('2026-04-24');
    expect(item.publishedDate).toBe('2024-01-01');
    expect(item.ingestStatus).toBe('pending_review');
  });

  it('sets sourceUrlCanonical only when canonicalUrl differs from sourceUrl', () => {
    const fw = {
      key: 'k', frameworkId: 'FRAMEWORK00', orgId: 'o', name: 'N',
      shortName: null, frameworkFamily: null, status: 'active' as const, notes: null,
      versions: [],
    };
    const version = {
      versionLabel: 'v1', publishedDate: '2024-01-01',
      sourceUrl: 'https://example.com/x', isDraft: false, versionSortOrder: 1,
    };
    // Same URL: canonical should be null.
    const a = buildVersionSyncItem(fw, version, {
      ...fakeFetch('h'),
      canonicalUrl: 'https://example.com/x',
    });
    expect(a.sourceUrlCanonical).toBe(null);
    // Different URL: canonical should be set.
    const b = buildVersionSyncItem(fw, version, {
      ...fakeFetch('h'),
      canonicalUrl: 'https://example.com/redirected',
    });
    expect(b.sourceUrlCanonical).toBe('https://example.com/redirected');
  });
});

// ---------------------------------------------------------------------------
// runIngest — happy-path orchestration
// ---------------------------------------------------------------------------

describe('runIngest — full pipeline', () => {
  it('syncs frameworks + versions + thresholds + diffs end-to-end', async () => {
    const deps = makeDeps({
      hashByUrl: {
        'https://example.com/alpha-v1': 'HA1',
        'https://example.com/alpha-v2': 'HA2',
        'https://example.com/beta-v1': 'HB1',
      },
    });
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      dryRun: false,
    });

    // 2 frameworks total.
    expect(summary.frameworksSynced).toBe(2);
    expect(deps.calls.syncedFrameworks.length).toBe(1);
    expect(deps.calls.syncedFrameworks[0].length).toBe(2);

    // 3 versions: alpha v1, alpha v2, beta v1.
    expect(summary.versionsAttempted).toBe(3);
    expect(summary.versionsSynced).toBe(3);
    expect(deps.calls.syncedVersions.length).toBe(3);
    expect(deps.calls.syncedThresholds.length).toBe(3);

    // Diff: alpha has 2 versions → 1 pair; beta has 1 → 0. Total 1 diff.
    expect(summary.diffsSynced).toBe(1);
    expect(deps.calls.syncedDiffs.length).toBe(1);
    expect(deps.calls.syncedDiffItems.length).toBe(1);
  });

  it('skips versions whose deterministic id already exists in PG', async () => {
    // Pre-populate "alpha v1" with the id that fakeFetch returns for HA1.
    const fwId = frameworkIdFromKey('alpha');
    const existingId = versionIdFromHash(fwId, 'v1', 'HA1');
    const deps = makeDeps({
      hashByUrl: {
        'https://example.com/alpha-v1': 'HA1',
        'https://example.com/alpha-v2': 'HA2',
        'https://example.com/beta-v1': 'HB1',
      },
      preExisting: [existingId],
    });
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      dryRun: false,
    });

    expect(summary.versionsAttempted).toBe(3);
    expect(summary.versionsSynced).toBe(2);
    expect(summary.versionsSkipped).toBe(1);
    // 2 extractions ran (alpha v2 + beta v1) — alpha v1 was skipped.
    expect(deps.calls.extracted.length).toBe(2);
    expect(deps.calls.extracted).toEqual(
      expect.arrayContaining([
        'https://example.com/alpha-v2',
        'https://example.com/beta-v1',
      ]),
    );
    expect(deps.calls.extracted).not.toContain('https://example.com/alpha-v1');
  });

  it('forceReextract overrides the skip-if-existing check', async () => {
    const fwId = frameworkIdFromKey('alpha');
    const existingId = versionIdFromHash(fwId, 'v1', 'HA1');
    const deps = makeDeps({
      hashByUrl: { 'https://example.com/alpha-v1': 'HA1' },
      preExisting: [existingId],
    });
    await runIngest(deps, {
      registryPath: fixturePath,
      frameworkKey: 'alpha',
      maxVersions: 1,
      forceReextract: true,
      dryRun: false,
    });

    expect(deps.calls.extracted).toContain('https://example.com/alpha-v1');
    expect(deps.calls.existingChecks.length).toBe(0); // skip-check bypassed
  });

  it('dryRun fetches + extracts but does not POST any sync calls', async () => {
    const deps = makeDeps();
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      dryRun: true,
    });

    expect(summary.versionsAttempted).toBe(3);
    expect(summary.versionsSynced).toBe(3);
    expect(deps.calls.syncedFrameworks.length).toBe(0);
    expect(deps.calls.syncedVersions.length).toBe(0);
    expect(deps.calls.syncedThresholds.length).toBe(0);
    expect(deps.calls.syncedDiffs.length).toBe(0);
    // But fetch + extract still ran (cost visibility — dry run should
    // never silently lie about what would happen on --apply).
    expect(deps.calls.fetched.length).toBe(3);
    expect(deps.calls.extracted.length).toBe(3);
  });

  it('skipExtract syncs version skeletons without LLM extraction', async () => {
    const deps = makeDeps();
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      skipExtract: true,
      skipDiffs: true,
      dryRun: false,
    });

    expect(summary.versionsSynced).toBe(3);
    expect(deps.calls.extracted.length).toBe(0);
    expect(deps.calls.syncedThresholds.length).toBe(0);
    expect(deps.calls.syncedVersions.length).toBe(3);
  });

  it('frameworkKey filter only processes the matching framework', async () => {
    const deps = makeDeps();
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      frameworkKey: 'beta',
      dryRun: false,
    });
    expect(summary.frameworksSynced).toBe(1);
    expect(summary.versionsAttempted).toBe(1);
    expect(deps.calls.fetched).toEqual(['https://example.com/beta-v1']);
  });

  it('throws for an unknown framework key with the available list', async () => {
    const deps = makeDeps();
    await expect(
      runIngest(deps, { registryPath: fixturePath, frameworkKey: 'gamma' }),
    ).rejects.toThrow(/Unknown framework key "gamma"/);
  });

  it('maxVersions caps versions per framework', async () => {
    const deps = makeDeps();
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      maxVersions: 1,
      dryRun: false,
    });
    expect(summary.versionsAttempted).toBe(2); // 1 from alpha + 1 from beta
  });

  it('counts fetch failures and continues with the remaining versions', async () => {
    // Build deps where alpha-v1 fails but alpha-v2 + beta-v1 succeed.
    const calls = {
      fetched: [] as string[],
      extracted: [] as string[],
      syncedVersions: [] as VersionSyncItem[][],
    };
    const deps: IngestDeps = {
      fetchFramework: async (o) => {
        calls.fetched.push(o.url);
        if (o.url === 'https://example.com/alpha-v1') throw new Error('boom');
        return fakeFetch(`hash-${o.url}`);
      },
      extractFrameworkThresholds: async (o) => {
        calls.extracted.push(o.url);
        return fakeExtract();
      },
      diffFrameworkVersions: async () => fakeAggregate(),
      fetchExistingVersion: async () => null,
      syncFrameworks: async () => {},
      syncVersions: async (items) => {
        calls.syncedVersions.push(items);
      },
      syncThresholds: async () => {},
      syncDiffs: async () => {},
      syncDiffItems: async () => {},
      log: () => {},
    };

    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      dryRun: false,
    });
    expect(summary.versionsFailed).toBe(1);
    expect(summary.versionsSynced).toBe(2);
    // alpha-v2 wasn't extracted since alpha-v1 fetch failed and the diff
    // chain breaks — but per-version processing continues, so the v2
    // version + thresholds are still synced.
    expect(calls.syncedVersions.length).toBe(2);
    expect(calls.fetched.length).toBe(3);
  });

  it('counts extract failures separately from fetch failures', async () => {
    const deps = makeDeps({ extractError: 'LLM blew up' });
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      dryRun: false,
    });
    expect(summary.versionsFailed).toBe(3);
    expect(summary.versions.every((v) => v.status === 'extract_failed')).toBe(true);
    // Even with extract failures we still synced the version rows.
    expect(deps.calls.syncedVersions.length).toBe(3);
  });

  it('does not run a diff when one side of a pair failed to extract', async () => {
    const calls = {
      diffed: 0,
      syncedDiffs: 0,
      extractCalls: 0,
    };
    const deps: IngestDeps = {
      fetchFramework: async (o) => fakeFetch(`hash-${o.url}`),
      extractFrameworkThresholds: async () => {
        calls.extractCalls++;
        // First extract for alpha v1 succeeds, second (alpha v2) fails.
        if (calls.extractCalls === 2) throw new Error('blow up alpha v2');
        return fakeExtract();
      },
      diffFrameworkVersions: async () => {
        calls.diffed++;
        return fakeAggregate();
      },
      fetchExistingVersion: async () => null,
      syncFrameworks: async () => {},
      syncVersions: async () => {},
      syncThresholds: async () => {},
      syncDiffs: async () => {
        calls.syncedDiffs++;
      },
      syncDiffItems: async () => {},
      log: () => {},
    };
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      frameworkKey: 'alpha', // 2 versions
      dryRun: false,
    });
    expect(summary.versionsSynced).toBe(1);
    expect(summary.versionsFailed).toBe(1);
    // No diff because one side broke.
    expect(calls.diffed).toBe(0);
    expect(calls.syncedDiffs).toBe(0);
  });

  it('skipDiffs disables diffing entirely', async () => {
    const deps = makeDeps();
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      skipDiffs: true,
      dryRun: false,
    });
    expect(summary.diffsSynced).toBe(0);
    expect(deps.calls.diffed).toBe(0);
    expect(deps.calls.syncedDiffs.length).toBe(0);
  });

  it('skipped-existing pairs do not produce diffs (no in-memory thresholds)', async () => {
    const fwId = frameworkIdFromKey('alpha');
    const v1Id = versionIdFromHash(fwId, 'v1', 'HA1');
    const v2Id = versionIdFromHash(fwId, 'v2', 'HA2');
    const deps = makeDeps({
      hashByUrl: {
        'https://example.com/alpha-v1': 'HA1',
        'https://example.com/alpha-v2': 'HA2',
      },
      preExisting: [v1Id, v2Id], // both alpha versions already synced
    });
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      frameworkKey: 'alpha',
      dryRun: false,
    });
    expect(summary.versionsSkipped).toBe(2);
    expect(summary.diffsSynced).toBe(0); // diff skipped — no thresholds
    expect(deps.calls.extracted.length).toBe(0);
    expect(deps.calls.diffed).toBe(0);
  });

  it('returns a structured summary with per-version + per-diff entries', async () => {
    const deps = makeDeps();
    const summary = await runIngest(deps, {
      registryPath: fixturePath,
      dryRun: false,
    });
    expect(summary.versions.length).toBe(3);
    expect(summary.versions.every((v) => v.frameworkKey && v.versionLabel && v.versionId)).toBe(true);
    expect(summary.diffs.length).toBe(1);
    expect(summary.diffs[0].diffItems).toBe(1);
  });
});
