/**
 * Server-side data fetchers for the /frontier-safety-frameworks pages.
 * Pulls from wiki-server PG via the existing Hono routes (QUA-691 schema,
 * QUA-707 ingest). All fetches are ISR-cached at 5 min.
 *
 * Hand-typed response shapes — keep narrow to fields rendered. The full
 * Hono RPC types are not exported in a way that imports cleanly into the
 * web app for these routes (mount-registry uses `any` parameterization).
 */

import { fetchDetailed } from "@lib/wiki-server";
import type { CanonicalRiskDomain } from "./risk-domain-constants";

export interface FrameworkRow {
  id: string;
  orgId: string;
  orgDisplayName: string | null;
  name: string;
  shortName: string | null;
  latestVersionId: string | null;
  firstPublishedDate: string | null;
  currentStatus: string | null;
  frameworkFamily: string | null;
  notes: string | null;
  org: {
    id: string;
    slug: string | null;
    title: string | null;
    displayName: string;
  };
}

export interface FrameworkVersionRow {
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
  contentLengthChars: number | null;
  summary: string | null;
  isDraft: boolean;
  supersededByVersionId: string | null;
  ingestStatus: string;
}

export interface ThresholdRow {
  id: string;
  versionId: string;
  riskDomainCanonical: CanonicalRiskDomain;
  riskDomainLabel: string;
  tierLabel: string;
  tierSortOrder: number;
  triggerDescription: string;
  sourceQuote: string;
  sourcePageHint: string | null;
  commitmentLanguage: string | null;
  humanReviewed: boolean;
}

export interface DiffRow {
  id: string;
  fromVersionId: string;
  toVersionId: string;
  changeSummary: string;
  weakeningFlagged: boolean;
  strengtheningFlagged: boolean;
  neutralChangesCount: number | null;
  overallDirection: string | null;
  humanReviewed: boolean;
  reviewVerdict: string;
  reviewNotes: string | null;
}

export interface DiffItemRow {
  id: string;
  diffId: string;
  changeType: string;
  riskDomainCanonical: string | null;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown> | null;
  severity: number | null;
  classifierTag: string | null;
  rationale: string | null;
}

const REVALIDATE_SECONDS = 300;
const PAGE_SIZE = 200;

/**
 * Fetches all framework rows with org join. Returns empty array on failure
 * so the UI degrades to a "no data yet" state instead of throwing.
 */
export async function fetchAllFrameworks(): Promise<{
  ok: boolean;
  items: FrameworkRow[];
}> {
  const items: FrameworkRow[] = [];
  let offset = 0;
  while (true) {
    const res = await fetchDetailed<{ items: FrameworkRow[]; total: number }>(
      `/api/safety-frameworks/all?limit=${PAGE_SIZE}&offset=${offset}`,
      { revalidate: REVALIDATE_SECONDS },
    );
    if (!res.ok) return { ok: false, items };
    items.push(...res.data.items);
    if (
      res.data.items.length < PAGE_SIZE ||
      items.length >= res.data.total
    ) {
      break;
    }
    offset += PAGE_SIZE;
    // Defensive: 12 frameworks expected; bail if we ever see >500.
    if (offset > 500) break;
  }
  return { ok: true, items };
}

/**
 * Fetches a single framework. Tries by `id` (sid_ prefixed) first, then
 * resolves by slug-style shortName scan. Returns null if neither matches.
 */
export async function fetchFramework(slug: string): Promise<FrameworkRow | null> {
  // Try direct ID lookup first (sid_-prefixed slugs hit this path).
  if (slug.startsWith("sid_")) {
    const res = await fetchDetailed<FrameworkRow>(
      `/api/safety-frameworks/${encodeURIComponent(slug)}`,
      { revalidate: REVALIDATE_SECONDS },
    );
    if (res.ok) return res.data;
    return null;
  }
  // Otherwise scan all frameworks and match by friendly slug.
  const all = await fetchAllFrameworks();
  if (!all.ok) return null;
  const wanted = slug.toLowerCase();
  return (
    all.items.find((f) => frameworkSlug(f) === wanted) ?? null
  );
}

/**
 * Builds a stable URL slug for a framework: prefer `shortName` (lowercased,
 * non-alphanumeric → `-`), fall back to the org slug + framework name, and
 * finally to the framework id.
 */
export function frameworkSlug(f: FrameworkRow): string {
  if (f.shortName) {
    const base = f.shortName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (base) return base;
  }
  if (f.org.slug) {
    const orgPart = f.org.slug.toLowerCase();
    const namePart = f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (namePart) return `${orgPart}-${namePart}`;
  }
  return f.id;
}

export async function fetchVersionsForFramework(
  frameworkId: string,
  publishedOnly = false,
): Promise<FrameworkVersionRow[]> {
  const res = await fetchDetailed<{
    items: FrameworkVersionRow[];
    total: number;
  }>(
    `/api/safety-framework-versions/by-framework/${encodeURIComponent(
      frameworkId,
    )}?limit=200&offset=0`,
    { revalidate: REVALIDATE_SECONDS },
  );
  if (!res.ok) return [];
  return publishedOnly
    ? res.data.items.filter((v) => v.ingestStatus === "published")
    : res.data.items;
}

export async function fetchThresholdsForVersion(
  versionId: string,
): Promise<ThresholdRow[]> {
  const res = await fetchDetailed<{ items: ThresholdRow[]; total: number }>(
    `/api/framework-capability-thresholds/by-version/${encodeURIComponent(
      versionId,
    )}?limit=500&offset=0`,
    { revalidate: REVALIDATE_SECONDS },
  );
  if (!res.ok) return [];
  return res.data.items;
}

export async function fetchDiffsForVersion(
  toVersionId: string,
): Promise<DiffRow[]> {
  const res = await fetchDetailed<{ items: DiffRow[]; total: number }>(
    `/api/framework-diffs/all?to_version_id=${encodeURIComponent(
      toVersionId,
    )}&limit=200&offset=0`,
    { revalidate: REVALIDATE_SECONDS },
  );
  if (!res.ok) return [];
  return res.data.items;
}

export async function fetchAllPublishedVersions(
  limit = 500,
): Promise<FrameworkVersionRow[]> {
  const res = await fetchDetailed<{
    items: FrameworkVersionRow[];
    total: number;
  }>(
    `/api/safety-framework-versions/all?ingest_status=published&limit=${limit}&offset=0`,
    { revalidate: REVALIDATE_SECONDS },
  );
  if (!res.ok) return [];
  return res.data.items;
}

export async function fetchDiffItemsForDiff(
  diffId: string,
): Promise<DiffItemRow[]> {
  const res = await fetchDetailed<{ items: DiffItemRow[]; total: number }>(
    `/api/framework-diff-items/by-diff/${encodeURIComponent(
      diffId,
    )}?limit=500&offset=0`,
    { revalidate: REVALIDATE_SECONDS },
  );
  if (!res.ok) return [];
  return res.data.items;
}
