/**
 * Frontier safety framework registry loader (QUA-707 Phase 4-A).
 *
 * Reads + validates `data/frameworks/frameworks.yaml` — the source-of-truth
 * manifest of the ~12 published frontier-safety frameworks. Used by the
 * `seed` and `ingest` orchestration commands to know which (orgId, name,
 * versionLabel, sourceUrl) tuples to materialize.
 *
 * Pure: no network calls. Cached after first load.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { generateId } from '../lib/grant-import/id.ts';

export const VALID_STATUS = ['active', 'archived', 'superseded', 'draft'] as const;
export type FrameworkStatus = (typeof VALID_STATUS)[number];

export interface RegistryVersion {
  versionLabel: string;
  publishedDate: string; // ISO date
  sourceUrl: string;
  isDraft: boolean;
  /** Monotonic position within the framework, 1-indexed by published_date asc. */
  versionSortOrder: number;
}

export interface RegistryFramework {
  /** YAML map key, e.g. "anthropic-rsp". */
  key: string;
  /** Deterministic stableId-shaped 10-char id. Stored as `safety_frameworks.id`. */
  frameworkId: string;
  /** Org slug — wiki-server FK validation accepts slug OR stableId. */
  orgId: string;
  name: string;
  shortName: string | null;
  frameworkFamily: string | null;
  status: FrameworkStatus;
  notes: string | null;
  versions: RegistryVersion[];
}

interface RawVersion {
  version_label?: unknown;
  published_date?: unknown;
  source_url?: unknown;
  is_draft?: unknown;
}

interface RawFramework {
  org_slug?: unknown;
  name?: unknown;
  short_name?: unknown;
  framework_family?: unknown;
  status?: unknown;
  notes?: unknown;
  versions?: unknown;
}

interface RawRegistry {
  version?: unknown;
  frameworks?: Record<string, RawFramework>;
}

const SUPPORTED_REGISTRY_VERSION = 1;

const _cache = new Map<string, RegistryFramework[]>();

function asString(v: unknown, max = 2000): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function asBool(v: unknown): boolean {
  return v === true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Compute a deterministic, stableId-shaped framework id from the registry key.
 * Used so re-runs of `seed` upsert in place rather than creating new rows.
 */
export function frameworkIdFromKey(key: string): string {
  return generateId(`framework:${key}`);
}

/**
 * Compute a deterministic version id. The `(frameworkId, contentHash)` pair
 * is the natural key on `safety_framework_versions`, so the hash must be
 * the canonical normalized content hash from `fetchFramework()` — NOT the
 * raw-text hash from extract.ts (different hashing strategies).
 */
export function versionIdFromHash(
  frameworkId: string,
  versionLabel: string,
  contentHash: string,
): string {
  return generateId(`framework-version:${frameworkId}:${versionLabel}:${contentHash}`);
}

function parseVersion(
  raw: RawVersion,
  index: number,
  frameworkKey: string,
): RegistryVersion {
  const label = asString((raw as RawVersion).version_label, 100);
  if (!label) {
    throw new Error(
      `frameworks.yaml: framework "${frameworkKey}" version[${index}] missing version_label`,
    );
  }
  const date = asString((raw as RawVersion).published_date, 20);
  if (!date) {
    throw new Error(
      `frameworks.yaml: framework "${frameworkKey}" version[${index}] missing published_date`,
    );
  }
  const url = asString((raw as RawVersion).source_url, 2000);
  if (!url) {
    throw new Error(
      `frameworks.yaml: framework "${frameworkKey}" version[${index}] missing source_url`,
    );
  }
  return {
    versionLabel: label,
    publishedDate: date,
    sourceUrl: url,
    isDraft: asBool((raw as RawVersion).is_draft),
    versionSortOrder: 0, // filled in below after sort
  };
}

function parseFramework(key: string, raw: RawFramework): RegistryFramework {
  const orgId = asString(raw.org_slug, 200);
  if (!orgId) {
    throw new Error(`frameworks.yaml: framework "${key}" missing org_slug`);
  }
  const name = asString(raw.name, 500);
  if (!name) {
    throw new Error(`frameworks.yaml: framework "${key}" missing name`);
  }
  const status = asString(raw.status, 50) ?? 'active';
  if (!(VALID_STATUS as readonly string[]).includes(status)) {
    throw new Error(
      `frameworks.yaml: framework "${key}" has invalid status "${status}"`,
    );
  }

  const rawVersions = Array.isArray(raw.versions) ? raw.versions : [];
  if (rawVersions.length === 0) {
    throw new Error(
      `frameworks.yaml: framework "${key}" must declare at least one version`,
    );
  }

  const versions = rawVersions.map((rv, idx) => {
    if (!isRecord(rv)) {
      throw new Error(
        `frameworks.yaml: framework "${key}" version[${idx}] is not an object`,
      );
    }
    return parseVersion(rv as RawVersion, idx, key);
  });

  // Stable sort by publishedDate asc, then versionLabel as tiebreaker.
  versions.sort((a, b) => {
    if (a.publishedDate !== b.publishedDate) {
      return a.publishedDate < b.publishedDate ? -1 : 1;
    }
    return a.versionLabel < b.versionLabel ? -1 : 1;
  });
  versions.forEach((v, i) => {
    v.versionSortOrder = i + 1;
  });

  return {
    key,
    frameworkId: frameworkIdFromKey(key),
    orgId,
    name,
    shortName: asString(raw.short_name, 100),
    frameworkFamily: asString(raw.framework_family, 200),
    status: status as FrameworkStatus,
    notes: asString(raw.notes, 10_000),
    versions,
  };
}

export function parseRegistry(rawText: string): RegistryFramework[] {
  const parsed = yaml.load(rawText, { schema: yaml.JSON_SCHEMA }) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('frameworks.yaml: top-level must be a mapping');
  }
  const reg = parsed as RawRegistry;
  if (typeof reg.version === 'number' && reg.version !== SUPPORTED_REGISTRY_VERSION) {
    throw new Error(
      `frameworks.yaml: unsupported registry version ${reg.version} (expected ${SUPPORTED_REGISTRY_VERSION})`,
    );
  }
  const frameworks = isRecord(reg.frameworks) ? reg.frameworks : {};
  const out: RegistryFramework[] = [];
  for (const [key, value] of Object.entries(frameworks)) {
    if (!isRecord(value)) {
      throw new Error(`frameworks.yaml: framework "${key}" is not an object`);
    }
    out.push(parseFramework(key, value as RawFramework));
  }
  // Stable sort by key for deterministic ordering.
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** Default path resolver for `data/frameworks/frameworks.yaml`. */
export function defaultRegistryPath(rootDir = process.cwd()): string {
  return path.join(rootDir, 'data', 'frameworks', 'frameworks.yaml');
}

export function loadRegistry(filePath?: string): RegistryFramework[] {
  const fp = filePath ?? defaultRegistryPath();
  // Key by resolved path so loadRegistry('/A') followed by loadRegistry('/B')
  // returns each file's data — the previous shared singleton silently returned
  // A's data on the second call (only the test suite's beforeEach saved it).
  const cached = _cache.get(fp);
  if (cached) return cached;
  const raw = fs.readFileSync(fp, 'utf-8');
  const parsed = parseRegistry(raw);
  _cache.set(fp, parsed);
  return parsed;
}

/** Test-only: clear the cache so subsequent loads re-read the file. */
export function _resetRegistryCache(): void {
  _cache.clear();
}
