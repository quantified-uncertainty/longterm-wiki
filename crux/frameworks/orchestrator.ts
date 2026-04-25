/**
 * Frontier-safety-framework end-to-end ingester (QUA-707 Phase 4-A).
 *
 * Orchestrates the full pipeline for the ~12 published frontier-safety
 * frameworks listed in `data/frameworks/frameworks.yaml`:
 *
 *   1. seed       — upsert one `safety_frameworks` row per framework key
 *                  (lightweight, no LLM)
 *   2. ingest     — for each version: fetchFramework → versionId by
 *                  natural-key → skip-if-already-synced → extract
 *                  thresholds → sync version + thresholds; then for each
 *                  consecutive version pair, classify the structural diff
 *                  and sync diff + diff-items
 *
 * Idempotency contract:
 *   - Framework ids derived from registry key (`frameworkIdFromKey`).
 *   - Version ids derived from (frameworkId, versionLabel, normalized
 *     contentHash). Re-running with the same source content produces the
 *     same id and upserts in place.
 *   - Threshold ids derived from (versionId, riskDomain, tierSortOrder).
 *   - Diff + diff-item ids derived from version pair / item index.
 *   - Before extracting, the orchestrator checks whether the version id
 *     already exists in PG; if it does and `--force-reextract` was not
 *     passed, the extraction (and thus the LLM bill) is skipped.
 *
 * The orchestrator is intentionally split into pure helpers that the
 * tests exercise in isolation, plus a top-level `runIngest()` that wires
 * them together. The wiki-server / LLM / fetch deps are injected so unit
 * tests can run without touching a network.
 */

import {
  diffFrameworkVersions,
  structuralDiff,
  aggregateDiff,
  type DiffAggregate,
} from './diff.ts';
import {
  extractFrameworkThresholds,
  type ExtractedThreshold,
  type ExtractResult,
} from './extract.ts';
import { fetchFramework, type FetchResult } from './fetch.ts';
import { generateId } from '../lib/grant-import/id.ts';
import { MODELS } from '../lib/anthropic.ts';
import {
  toThresholdSyncItems,
  toDiffSyncPayloads,
} from './sync-payloads.ts';
import {
  loadRegistry,
  versionIdFromHash,
  type RegistryFramework,
  type RegistryVersion,
} from './registry.ts';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface FrameworkSyncItem {
  id: string;
  orgId: string;
  name: string;
  shortName: string | null;
  frameworkFamily: string | null;
  currentStatus: 'active' | 'archived' | 'superseded' | 'draft';
  firstPublishedDate: string | null;
  notes: string | null;
}

/**
 * Build sync items for `/api/safety-frameworks/sync` from the registry.
 * `firstPublishedDate` is derived from the earliest version's
 * `publishedDate` so we don't need a separate manifest field.
 */
export function buildFrameworkSyncItems(
  entries: RegistryFramework[],
): FrameworkSyncItem[] {
  return entries.map((e) => ({
    id: e.frameworkId,
    orgId: e.orgId,
    name: e.name,
    shortName: e.shortName,
    frameworkFamily: e.frameworkFamily,
    currentStatus: e.status,
    firstPublishedDate: e.versions[0]?.publishedDate ?? null,
    notes: e.notes,
  }));
}

export interface VersionSyncItem {
  id: string;
  frameworkId: string;
  versionLabel: string;
  versionSortOrder: number;
  publishedDate: string | null;
  discoveredDate: string;
  sourceUrl: string;
  sourceUrlCanonical: string | null;
  waybackSnapshotUrl: string | null;
  pdfArchiveUrl: string | null;
  contentHash: string;
  contentLengthChars: number;
  summary: string | null;
  isDraft: boolean;
  ingestStatus: 'pending_review' | 'published' | 'rejected';
}

/**
 * Build a version sync item from a fetch result. The fetch result's
 * normalized `contentHash` is the natural-key for `safety_framework_versions`,
 * so re-fetching the same content from the same URL produces the same
 * version id and upserts in place.
 */
export function buildVersionSyncItem(
  framework: RegistryFramework,
  version: RegistryVersion,
  fetched: FetchResult,
  now: Date = new Date(),
): VersionSyncItem {
  return {
    id: versionIdFromHash(framework.frameworkId, version.versionLabel, fetched.contentHash),
    frameworkId: framework.frameworkId,
    versionLabel: version.versionLabel,
    versionSortOrder: version.versionSortOrder,
    publishedDate: version.publishedDate,
    discoveredDate: now.toISOString().slice(0, 10),
    sourceUrl: version.sourceUrl,
    sourceUrlCanonical: fetched.canonicalUrl !== version.sourceUrl ? fetched.canonicalUrl : null,
    waybackSnapshotUrl: fetched.waybackSnapshotUrl,
    pdfArchiveUrl: null,
    contentHash: fetched.contentHash,
    contentLengthChars: fetched.contentLengthChars,
    summary: null,
    isDraft: version.isDraft,
    ingestStatus: 'pending_review',
  };
}

// ---------------------------------------------------------------------------
// Dependency injection — keeps runIngest() testable
// ---------------------------------------------------------------------------

export interface IngestDeps {
  /** Fetch + hash + Wayback push. */
  fetchFramework: (opts: { url: string; skipWayback?: boolean }) => Promise<FetchResult>;
  /** Extract thresholds via two-pass LLM. */
  extractFrameworkThresholds: (opts: {
    url: string;
    lab?: string | null;
    llmModel?: string;
  }) => Promise<ExtractResult>;
  /** Diff two threshold lists (LLM classifier optional). */
  diffFrameworkVersions: (
    before: ExtractedThreshold[],
    after: ExtractedThreshold[],
    opts?: { llmModel?: string },
  ) => Promise<DiffAggregate>;
  /**
   * Cheap GET /api/safety-framework-versions/:id used to skip already-ingested
   * versions before paying the LLM bill. Should return null on 404, not throw.
   */
  fetchExistingVersion: (versionId: string) => Promise<{ id: string } | null>;
  /** POST sync handlers. Each posts the same shape — `{ items: [...] }`. */
  syncFrameworks: (items: FrameworkSyncItem[]) => Promise<void>;
  syncVersions: (items: VersionSyncItem[]) => Promise<void>;
  syncThresholds: (items: Array<Record<string, unknown>>) => Promise<void>;
  syncDiffs: (items: Array<Record<string, unknown>>) => Promise<void>;
  syncDiffItems: (items: Array<Record<string, unknown>>) => Promise<void>;
  /** Logger — caller chooses console / pino / silent. */
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

// ---------------------------------------------------------------------------
// runIngest — top-level orchestration
// ---------------------------------------------------------------------------

export interface IngestOptions {
  /** Optional registry filter. If set, only this framework key is processed. */
  frameworkKey?: string;
  /** Optional cap on versions per framework (smoke-test mode). */
  maxVersions?: number;
  /** Skip the actual /sync POSTs. Still calls fetch (and extract unless skipExtract). */
  dryRun?: boolean;
  /** Skip the (expensive) LLM extraction pass. Useful to seed version skeletons. */
  skipExtract?: boolean;
  /** Skip the diff pass between consecutive versions. */
  skipDiffs?: boolean;
  /** Re-run extraction even if version row already exists. */
  forceReextract?: boolean;
  /** Skip Wayback push (faster; non-archival). */
  skipWayback?: boolean;
  /** LLM model for extract + diff classifier. */
  llmModel?: string;
  /** Skip the LLM classifier pass on diffs (use structuralDiff only). */
  skipClassifier?: boolean;
  /** Override the registry path (testing). */
  registryPath?: string;
}

export interface IngestVersionResult {
  frameworkKey: string;
  versionLabel: string;
  versionId: string;
  status: 'synced' | 'skipped_existing' | 'fetch_failed' | 'extract_failed';
  thresholdsSynced: number;
  unverifiedThresholds: number;
  errorMessage?: string;
  /** In-memory thresholds; used for downstream diff computation. */
  thresholds?: ExtractedThreshold[];
  /** Extraction model — for the diff `classifiedByModel` field. */
  extractionModel?: string;
}

export interface IngestDiffResult {
  fromVersionId: string;
  toVersionId: string;
  diffItems: number;
  weakeningFlagged: boolean;
  status: 'synced' | 'skipped' | 'classify_failed';
  errorMessage?: string;
}

export interface IngestSummary {
  frameworksSynced: number;
  versionsAttempted: number;
  versionsSynced: number;
  versionsSkipped: number;
  versionsFailed: number;
  diffsSynced: number;
  diffsFailed: number;
  versions: IngestVersionResult[];
  diffs: IngestDiffResult[];
}

/**
 * Top-level orchestrator. See module docstring.
 *
 * Concurrency: serial. The LLM bills per call, the wiki-server enforces
 * batch-size limits, and frameworks.yaml is small (~12 entries). Adding
 * parallelism here would just risk rate-limiting the Anthropic API for
 * a handful of seconds of speedup.
 */
export async function runIngest(
  deps: IngestDeps,
  options: IngestOptions = {},
): Promise<IngestSummary> {
  const registry = loadRegistry(options.registryPath);
  const filtered = options.frameworkKey
    ? registry.filter((e) => e.key === options.frameworkKey)
    : registry;

  if (options.frameworkKey && filtered.length === 0) {
    throw new Error(
      `Unknown framework key "${options.frameworkKey}" — not in frameworks.yaml. ` +
        `Available: ${registry.map((e) => e.key).join(', ')}`,
    );
  }

  const summary: IngestSummary = {
    frameworksSynced: 0,
    versionsAttempted: 0,
    versionsSynced: 0,
    versionsSkipped: 0,
    versionsFailed: 0,
    diffsSynced: 0,
    diffsFailed: 0,
    versions: [],
    diffs: [],
  };

  // 1. Sync framework rows.
  const frameworkItems = buildFrameworkSyncItems(filtered);
  if (!options.dryRun) {
    await deps.syncFrameworks(frameworkItems);
  }
  summary.frameworksSynced = frameworkItems.length;
  deps.log('info', `Framework rows: ${frameworkItems.length} ${options.dryRun ? '(dry-run)' : 'synced'}`);

  // 2. For each framework, ingest each version.
  for (const framework of filtered) {
    const versionsToProcess = options.maxVersions
      ? framework.versions.slice(0, options.maxVersions)
      : framework.versions;

    const perFrameworkResults: IngestVersionResult[] = [];

    for (const version of versionsToProcess) {
      summary.versionsAttempted++;
      const result = await ingestVersion(deps, framework, version, options);
      perFrameworkResults.push(result);
      summary.versions.push(result);

      switch (result.status) {
        case 'synced':
          summary.versionsSynced++;
          break;
        case 'skipped_existing':
          summary.versionsSkipped++;
          break;
        case 'fetch_failed':
        case 'extract_failed':
          summary.versionsFailed++;
          break;
      }
    }

    // 3. Diff consecutive version pairs (only when both ends were synced
    //    or skipped — failed fetches break the chain). Run in version
    //    order so weakening flags accumulate against the latest baseline.
    if (!options.skipDiffs && perFrameworkResults.length >= 2) {
      for (let i = 1; i < perFrameworkResults.length; i++) {
        const from = perFrameworkResults[i - 1];
        const to = perFrameworkResults[i];
        if (from.status === 'fetch_failed' || from.status === 'extract_failed') continue;
        if (to.status === 'fetch_failed' || to.status === 'extract_failed') continue;

        const diffResult = await ingestDiff(deps, from, to, options);
        summary.diffs.push(diffResult);
        if (diffResult.status === 'synced') summary.diffsSynced++;
        if (diffResult.status === 'classify_failed') summary.diffsFailed++;
      }
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Per-version pipeline (extracted for testability)
// ---------------------------------------------------------------------------

async function ingestVersion(
  deps: IngestDeps,
  framework: RegistryFramework,
  version: RegistryVersion,
  options: IngestOptions,
): Promise<IngestVersionResult> {
  const tag = `${framework.key}/${version.versionLabel}`;
  let fetched: FetchResult;
  try {
    fetched = await deps.fetchFramework({
      url: version.sourceUrl,
      skipWayback: options.skipWayback,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log('error', `[${tag}] fetch failed: ${msg}`);
    return {
      frameworkKey: framework.key,
      versionLabel: version.versionLabel,
      versionId: '',
      status: 'fetch_failed',
      thresholdsSynced: 0,
      unverifiedThresholds: 0,
      errorMessage: msg,
    };
  }

  const versionItem = buildVersionSyncItem(framework, version, fetched);
  const versionId = versionItem.id;

  // Skip-if-already-synced (saves an LLM call).
  if (!options.forceReextract) {
    const existing = await deps.fetchExistingVersion(versionId).catch(() => null);
    if (existing) {
      deps.log('info', `[${tag}] version already synced (${versionId.slice(0, 8)}…) — skipping extraction`);
      return {
        frameworkKey: framework.key,
        versionLabel: version.versionLabel,
        versionId,
        status: 'skipped_existing',
        thresholdsSynced: 0,
        unverifiedThresholds: 0,
      };
    }
  }

  // Sync the version row before thresholds — versionId is the FK.
  if (!options.dryRun) {
    await deps.syncVersions([versionItem]);
  }

  if (options.skipExtract) {
    deps.log('info', `[${tag}] version synced (${versionId.slice(0, 8)}…); thresholds skipped`);
    return {
      frameworkKey: framework.key,
      versionLabel: version.versionLabel,
      versionId,
      status: 'synced',
      thresholdsSynced: 0,
      unverifiedThresholds: 0,
      thresholds: [],
    };
  }

  // Extract thresholds. The extractor does its own fetch — that's a known
  // double-fetch with the orchestrator, accepted here for simplicity.
  let extract: ExtractResult;
  try {
    extract = await deps.extractFrameworkThresholds({
      url: version.sourceUrl,
      lab: framework.orgId,
      llmModel: options.llmModel,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log('error', `[${tag}] extract failed: ${msg}`);
    return {
      frameworkKey: framework.key,
      versionLabel: version.versionLabel,
      versionId,
      status: 'extract_failed',
      thresholdsSynced: 0,
      unverifiedThresholds: 0,
      errorMessage: msg,
    };
  }

  const extractionModel = extract.pass2Model || extract.pass1Model;
  const thresholdItems = toThresholdSyncItems(versionId, extract.thresholds, {
    extractionModel,
  });

  if (thresholdItems.length > 0 && !options.dryRun) {
    await deps.syncThresholds(thresholdItems);
  }

  deps.log(
    'info',
    `[${tag}] synced version (${versionId.slice(0, 8)}…) + ${thresholdItems.length} threshold(s)` +
      (extract.unverifiedCount > 0 ? ` (${extract.unverifiedCount} unverified)` : ''),
  );

  return {
    frameworkKey: framework.key,
    versionLabel: version.versionLabel,
    versionId,
    status: 'synced',
    thresholdsSynced: thresholdItems.length,
    unverifiedThresholds: extract.unverifiedCount,
    thresholds: extract.thresholds,
    extractionModel,
  };
}

// ---------------------------------------------------------------------------
// Per-pair diff pipeline
// ---------------------------------------------------------------------------

async function ingestDiff(
  deps: IngestDeps,
  from: IngestVersionResult,
  to: IngestVersionResult,
  options: IngestOptions,
): Promise<IngestDiffResult> {
  const tag = `${from.frameworkKey}: ${from.versionLabel} → ${to.versionLabel}`;
  // No in-memory thresholds for either side: both were either skipped (already
  // synced — diff would need thresholds re-fetched from the API) or skip-extract'd
  // (no thresholds at all). In either case, skip the diff and let a follow-up
  // run with --force-reextract or a separate diff command produce it.
  if (!from.thresholds || !to.thresholds) {
    deps.log('info', `[${tag}] thresholds unavailable (skipped or already synced) — diff skipped`);
    return {
      fromVersionId: from.versionId,
      toVersionId: to.versionId,
      diffItems: 0,
      weakeningFlagged: false,
      status: 'skipped',
    };
  }

  let aggregate: DiffAggregate;
  let classifiedByModel: string | null = null;
  try {
    if (options.skipClassifier) {
      aggregate = aggregateDiff(structuralDiff(from.thresholds, to.thresholds));
    } else {
      aggregate = await deps.diffFrameworkVersions(from.thresholds, to.thresholds, {
        llmModel: options.llmModel,
      });
      classifiedByModel = options.llmModel ?? MODELS.sonnet;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log('error', `[${tag}] classify failed: ${msg}`);
    return {
      fromVersionId: from.versionId,
      toVersionId: to.versionId,
      diffItems: 0,
      weakeningFlagged: false,
      status: 'classify_failed',
      errorMessage: msg,
    };
  }

  const payload = toDiffSyncPayloads(from.versionId, to.versionId, aggregate, {
    classifiedByModel,
  });

  if (!options.dryRun) {
    await deps.syncDiffs([payload.diff]);
    if (payload.items.length > 0) {
      await deps.syncDiffItems(payload.items);
    }
  }

  deps.log(
    'info',
    `[${tag}] diff synced — ${payload.items.length} item(s)` +
      (aggregate.weakeningFlagged ? ' ⚠ weakening flagged (unreviewed)' : ''),
  );

  return {
    fromVersionId: from.versionId,
    toVersionId: to.versionId,
    diffItems: payload.items.length,
    weakeningFlagged: aggregate.weakeningFlagged,
    status: 'synced',
  };
}

// ---------------------------------------------------------------------------
// Default deps factory — wires up real fetch / extract / wiki-server
// ---------------------------------------------------------------------------

/**
 * Build a default `IngestDeps` that hits the real wiki-server and the real
 * Anthropic API. Tests should pass their own deps instead of calling this.
 */
export async function defaultIngestDeps(opts: {
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
} = {}): Promise<IngestDeps> {
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const log = opts.log ?? ((level, msg) => {
    const prefix = level === 'error' ? '✗ ' : level === 'warn' ? '⚠ ' : '  ';
    // eslint-disable-next-line no-console
    console.log(prefix + msg);
  });

  async function postSync(path: string, items: unknown[]): Promise<void> {
    if (items.length === 0) return;
    const res = await apiRequest<{ upserted: number }>('POST', path, { items });
    if (!res.ok) {
      throw new Error(`${path} sync failed: ${res.error} — ${res.message}`);
    }
  }

  return {
    fetchFramework: (o) => fetchFramework(o),
    extractFrameworkThresholds: (o) => extractFrameworkThresholds(o),
    diffFrameworkVersions: (before, after, o) => diffFrameworkVersions(before, after, o),
    fetchExistingVersion: async (id) => {
      const res = await apiRequest<{ id: string }>(
        'GET',
        `/api/safety-framework-versions/${encodeURIComponent(id)}`,
      );
      if (!res.ok) {
        if (res.error === 'bad_request') return null; // 404 is bad_request via classifyStatus
        // Surface server / auth / unavailable errors loudly — don't pretend the
        // version doesn't exist. The caller will skip the LLM bill anyway by
        // falling through to the rest of the pipeline if forceReextract is set.
        throw new Error(`fetchExistingVersion ${id}: ${res.error} — ${res.message}`);
      }
      return res.data;
    },
    syncFrameworks: (items) => postSync('/api/safety-frameworks/sync', items),
    syncVersions: (items) => postSync('/api/safety-framework-versions/sync', items),
    syncThresholds: (items) => postSync('/api/framework-capability-thresholds/sync', items),
    syncDiffs: (items) => postSync('/api/framework-diffs/sync', items),
    syncDiffItems: (items) => postSync('/api/framework-diff-items/sync', items),
    log,
  };
}

// Re-export id helpers for convenience.
export { frameworkIdFromKey, versionIdFromHash } from './registry.ts';
export {
  generateId as _generateId, // exported only so tests can compute expected ids
} from '../lib/grant-import/id.ts';
