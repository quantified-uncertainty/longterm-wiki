#!/usr/bin/env node

/**
 * Weekly frontier-safety-framework re-fetch (QUA-711 Phase 4-D).
 *
 * For each framework registered in `data/frameworks/frameworks.yaml`:
 *   1. Pick the latest source URL (the most-recently published version
 *      of that framework — the URL we expect labs to silently edit).
 *   2. `fetchFramework()` — content + sha256 hash.
 *   3. Look up the latest known content hash from
 *      `framework_ingest_log` (`/api/framework-ingest-log/latest/:id`),
 *      falling back to the latest `safety_framework_versions` row when
 *      the log is empty (first run).
 *   4. `classifyIngest()` — emit `unchanged | new_version | silent_update_detected | fetch_failed`.
 *   5. Write a row to `framework_ingest_log`.
 *   6. On `silent_update_detected`, fire a Discord webhook
 *      (`crux/lib/discord/index.ts`).
 *
 * Idempotent. Two runs in the same minute against an unchanged page
 * collapse on the deterministic ingest-log id; runs against a drifted
 * page emit at most one alert per (framework, content_hash) pair (the
 * downstream PG row is keyed on that pair, and the alert only fires when
 * we actually insert a fresh row).
 *
 * Usage:
 *   pnpm crux scripts refresh-frameworks
 *   pnpm crux scripts refresh-frameworks --dry-run
 *   pnpm crux scripts refresh-frameworks --skip-wayback --skip-discord
 *   pnpm crux scripts refresh-frameworks --json
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'url';
import { truncate } from '../lib/text-utils.ts';

import {
  fetchFramework,
  classifyIngest,
  type FetchResult,
  type IngestStatus,
} from '../frameworks/fetch.ts';
import { apiRequest, type ApiResult } from '../lib/wiki-server/client.ts';
import { generateId } from '../lib/grant-import/id.ts';
import {
  sendSilentUpdateAlert,
  type DiscordWebhookOptions,
} from '../lib/discord/index.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FrameworkVersionEntry {
  version_label: string;
  published_date?: string;
  source_url: string;
  is_draft?: boolean;
}

interface FrameworkEntry {
  org_slug: string;
  name: string;
  short_name?: string;
  framework_family: string;
  status: string;
  notes?: string;
  versions: FrameworkVersionEntry[];
}

interface FrameworksManifest {
  version: number;
  frameworks: Record<string, FrameworkEntry>;
}

export interface PerFrameworkResult {
  frameworkKey: string; // e.g. "anthropic-rsp"
  displayName: string;
  sourceUrl: string;
  status: IngestStatus;
  contentHash: string | null;
  previousHash: string | null;
  note: string | null;
  alertDelivered: boolean;
}

export interface RefreshSummary {
  total: number;
  byStatus: Record<IngestStatus, number>;
  results: PerFrameworkResult[];
}

interface IngestLogRow {
  id: string;
  frameworkId: string;
  contentHash: string | null;
  status: IngestStatus;
  fetchedAt: string;
  notes: string | null;
}

interface VersionRow {
  id: string;
  frameworkId: string;
  versionLabel: string;
  contentHash: string;
  ingestStatus: string;
  publishedDate: string | null;
}

interface VersionsResponse {
  items: VersionRow[];
  total: number;
}

interface FrameworkRow {
  id: string;
  orgId: string;
  name: string;
  shortName: string | null;
  frameworkFamily: string;
}

interface FrameworksByEntityResponse {
  items: FrameworkRow[];
  total: number;
}

// ---------------------------------------------------------------------------
// YAML loader
// ---------------------------------------------------------------------------

const DEFAULT_MANIFEST_PATH = join(
  process.cwd(),
  'data/frameworks/frameworks.yaml',
);

export function loadFrameworksManifest(
  path: string = DEFAULT_MANIFEST_PATH,
): FrameworksManifest {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as FrameworksManifest;
  if (!parsed || typeof parsed !== 'object' || !parsed.frameworks) {
    throw new Error(`Manifest at ${path} is missing a 'frameworks' map`);
  }
  return parsed;
}

/**
 * Pick the latest version for a framework. "Latest" = the entry with the
 * most recent `published_date`. Falls back to the last entry in array order
 * when no dates are populated.
 */
export function pickLatestVersion(
  versions: FrameworkVersionEntry[],
): FrameworkVersionEntry | null {
  if (versions.length === 0) return null;
  let best = versions[0];
  let bestTs = parsePublishedTs(best.published_date);
  for (const v of versions.slice(1)) {
    const ts = parsePublishedTs(v.published_date);
    if (ts > bestTs) {
      best = v;
      bestTs = ts;
    }
  }
  return best;
}

function parsePublishedTs(date: string | undefined): number {
  if (!date) return -Infinity;
  const ts = Date.parse(date);
  return Number.isFinite(ts) ? ts : -Infinity;
}

// ---------------------------------------------------------------------------
// Wiki-server clients
// ---------------------------------------------------------------------------

async function fetchLatestLogEntry(
  frameworkId: string,
  apiRequestImpl: typeof apiRequest = apiRequest,
): Promise<IngestLogRow | null> {
  const result = await apiRequestImpl<IngestLogRow>(
    'GET',
    `/api/framework-ingest-log/latest/${encodeURIComponent(frameworkId)}`,
  );
  if (!result.ok) return null;
  return result.data;
}

async function fetchLatestVersion(
  frameworkId: string,
  apiRequestImpl: typeof apiRequest = apiRequest,
): Promise<VersionRow | null> {
  const result = await apiRequestImpl<VersionsResponse>(
    'GET',
    `/api/safety-framework-versions/all?framework_id=${encodeURIComponent(frameworkId)}&limit=1`,
  );
  if (!result.ok) return null;
  return result.data.items[0] ?? null;
}

interface ResolveOptions {
  /** Inject a wiki-server client for tests. */
  apiRequestImpl?: typeof apiRequest;
}

/**
 * Resolve `manifest-key` ("anthropic-rsp") to the wiki-server's framework
 * stableId by name. We index by `(orgId, name)` since the manifest's
 * `org_slug` is the entity id. Returns null when the framework hasn't been
 * registered server-side yet (Phase 4-A hasn't ingested it).
 */
async function resolveFrameworkStableId(
  manifestKey: string,
  entry: FrameworkEntry,
  apiRequestImpl: typeof apiRequest = apiRequest,
): Promise<string | null> {
  const result = await apiRequestImpl<FrameworksByEntityResponse>(
    'GET',
    `/api/safety-frameworks/by-entity/${encodeURIComponent(entry.org_slug)}?limit=50`,
  );
  if (!result.ok) return null;
  const match = result.data.items.find(
    (f) => f.name === entry.name || f.shortName === entry.short_name,
  );
  return match?.id ?? null;
}

// ---------------------------------------------------------------------------
// Main per-framework workflow
// ---------------------------------------------------------------------------

export interface RefreshOptions {
  /** Don't push to Wayback (faster + no external side effects). */
  skipWayback?: boolean;
  /** Don't fire the Discord webhook. */
  skipDiscord?: boolean;
  /** Skip ingest-log writes (for read-only --dry-run). */
  dryRun?: boolean;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetchFramework;
  /** Override apiRequest (tests). */
  apiRequestImpl?: typeof apiRequest;
  /** Discord options pass-through. */
  discord?: DiscordWebhookOptions;
}

export async function refreshOneFramework(
  manifestKey: string,
  entry: FrameworkEntry,
  options: RefreshOptions = {},
): Promise<PerFrameworkResult> {
  const {
    skipWayback = false,
    skipDiscord = false,
    dryRun = false,
    fetchImpl = fetchFramework,
    apiRequestImpl = apiRequest,
    discord = {},
  } = options;

  const displayName = entry.short_name
    ? `${entry.name} (${entry.short_name})`
    : entry.name;
  const latest = pickLatestVersion(entry.versions);
  if (!latest) {
    return {
      frameworkKey: manifestKey,
      displayName,
      sourceUrl: '',
      status: 'fetch_failed',
      contentHash: null,
      previousHash: null,
      note: 'No versions in manifest',
      alertDelivered: false,
    };
  }

  let fetchResult: FetchResult | null = null;
  let fetchError: string | null = null;
  try {
    fetchResult = await fetchImpl({
      url: latest.source_url,
      skipWayback,
    });
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  // Resolve the framework's PG stableId so we can hit the framework-keyed
  // endpoints. This may fail when Phase 4-A hasn't ingested the framework
  // yet — in that case we still log a fetch_failed locally but cannot
  // persist to the wiki-server.
  const frameworkId = await resolveFrameworkStableId(
    manifestKey,
    entry,
    apiRequestImpl,
  );

  let previousHash: string | null = null;
  let latestVersionLabelSeen = false;
  if (frameworkId) {
    const lastLog = await fetchLatestLogEntry(frameworkId, apiRequestImpl);
    if (lastLog && lastLog.contentHash) {
      previousHash = lastLog.contentHash;
    } else {
      const lastVersion = await fetchLatestVersion(frameworkId, apiRequestImpl);
      if (lastVersion) {
        previousHash = lastVersion.contentHash;
      }
    }
    // The re-fetch script always targets the latest known source URL. If
    // we have *any* previous hash recorded (log OR versions table), we've
    // already seen a published version of this framework — drift to a new
    // hash on the same URL = silent edit by the lab, not a fresh discovery.
    if (previousHash) {
      latestVersionLabelSeen = true;
    }
  }

  const newHash = fetchResult ? fetchResult.contentHash : null;
  const status: IngestStatus = classifyIngest(
    previousHash,
    newHash,
    latestVersionLabelSeen,
  );

  const note =
    fetchError ??
    (fetchResult?.note ?? null) ??
    null;

  // ── Persist to the ingest log ─────────────────────────────────────────
  if (!dryRun && frameworkId) {
    // Deterministic id within the same minute prevents double-insert on
    // retries. Hash + status keeps unchanged-vs-change rows distinct.
    const minuteKey = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
    const id = generateId(
      `framework-ingest-log:${frameworkId}:${newHash ?? 'null'}:${status}:${minuteKey}`,
    );
    await apiRequestImpl<{ inserted: number }>(
      'POST',
      '/api/framework-ingest-log/insert',
      {
        items: [
          {
            id,
            frameworkId,
            sourceUrl: latest.source_url,
            contentHash: newHash,
            status,
            notes: note,
          },
        ],
      },
    );
  }

  // ── Fire Discord alert on silent update ───────────────────────────────
  let alertDelivered = false;
  if (
    status === 'silent_update_detected' &&
    !skipDiscord &&
    !dryRun &&
    frameworkId &&
    newHash &&
    previousHash
  ) {
    const result = await sendSilentUpdateAlert(
      {
        frameworkLabel: displayName,
        frameworkId,
        sourceUrl: latest.source_url,
        newContentHash: newHash,
        previousContentHash: previousHash,
        latestKnownVersionId: null,
      },
      discord,
    );
    alertDelivered = result.delivered;
  }

  return {
    frameworkKey: manifestKey,
    displayName,
    sourceUrl: latest.source_url,
    status,
    contentHash: newHash,
    previousHash,
    note,
    alertDelivered,
  };
}

export async function refreshAllFrameworks(
  manifest: FrameworksManifest,
  options: RefreshOptions = {},
): Promise<RefreshSummary> {
  const results: PerFrameworkResult[] = [];
  for (const [key, entry] of Object.entries(manifest.frameworks)) {
    const result = await refreshOneFramework(key, entry, options);
    results.push(result);
  }
  const byStatus: Record<IngestStatus, number> = {
    new_version: 0,
    unchanged: 0,
    silent_update_detected: 0,
    fetch_failed: 0,
  };
  for (const r of results) byStatus[r.status]++;
  return { total: results.length, byStatus, results };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const skipWayback = args.includes('--skip-wayback');
  const skipDiscord = args.includes('--skip-discord');
  const json = args.includes('--json');

  const manifest = loadFrameworksManifest();
  const summary = await refreshAllFrameworks(manifest, {
    dryRun,
    skipWayback,
    skipDiscord,
  });

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.byStatus.fetch_failed > 0 ? 1 : 0);
  }

  // Human-readable table.
  const pad = (s: string, w: number) => truncate(s, w).padEnd(w);
  console.log(
    `\nFramework refresh — ${summary.total} frameworks${dryRun ? ' (dry-run)' : ''}\n`,
  );
  console.log(
    `  ${pad('framework', 30)} ${pad('status', 24)} ${pad('hash', 16)} ${pad('alert', 6)}`,
  );
  console.log('  ' + '─'.repeat(30 + 24 + 16 + 6 + 3));
  for (const r of summary.results) {
    const hash = truncate(r.contentHash, 15, { fallback: '—' });
    console.log(
      `  ${pad(r.frameworkKey, 30)} ${pad(r.status, 24)} ${pad(hash, 16)} ${pad(r.alertDelivered ? 'sent' : '—', 6)}`,
    );
    if (r.note) console.log(`    note: ${r.note}`);
  }
  console.log(
    `\n  Summary: unchanged=${summary.byStatus.unchanged} new_version=${summary.byStatus.new_version} silent_update=${summary.byStatus.silent_update_detected} failed=${summary.byStatus.fetch_failed}`,
  );

  process.exit(summary.byStatus.fetch_failed > 0 ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("refresh-frameworks crashed:", err);
    process.exit(1);
  });
}
