/**
 * Transform AIID snapshot records into ai-incidents sync-handler items.
 *
 * The MIT AI Incident Database (AIID) snapshot is a MongoDB dump that also
 * ships JSON + CSV. We parse the JSON into the shape our POST /api/ai-incidents/sync
 * handler expects.
 *
 * LICENSE (CC-BY-SA 4.0, with exclusions):
 *   - `submissions` collection: NOT persisted — excluded from CC-BY-SA.
 *   - `reports.text` / `reports.plain_text` field: NOT persisted — excluded
 *     from CC-BY-SA. We store URL, title, publisher, published_at, language.
 *
 * Pure functions only — keep this file network-free so it stays cheap to
 * unit-test. I/O lives in fetch.ts and the CLI command.
 */

import { generateId } from "../grant-import/id.ts";
import { truncate } from "../text-utils.ts";

/** AIID "incidents" collection row (subset we consume). */
export interface AiidIncidentRaw {
  incident_id: number;
  title: string;
  /** YYYY-MM-DD */
  date?: string | null;
  description?: string | null;
  /** AIID entity IDs (string slugs like "openai"). */
  "Alleged deployer of AI system"?: string[];
  "Alleged developer of AI system"?: string[];
  "Alleged harmed or nearly harmed parties"?: string[];
  /** Report numbers that back this incident. */
  reports?: number[];
  editors?: string[];
  nlp_similar_incidents?: Array<{
    incident_id: number;
    similarity: number;
  }>;
  /** Optional classifications; not a load-bearing field — kept in `raw`. */
  [key: string]: unknown;
}

/** AIID "reports" collection row (subset we consume). */
export interface AiidReportRaw {
  report_number: number;
  url: string;
  title?: string | null;
  source_domain?: string | null;
  /** YYYY-MM-DD */
  date_published?: string | null;
  language?: string | null;
  /** FIELD EXCLUDED FROM CC-BY-SA — must not be persisted. */
  plain_text?: string;
  /** Same exclusion. */
  text?: string;
  [key: string]: unknown;
}

/** AIID "entities" collection row. */
export interface AiidEntityRaw {
  entity_id: string;
  name: string;
  created_at?: string;
  [key: string]: unknown;
}

/** Output item — matches SyncAiIncidentItemSchema in ai-incidents.ts. */
export interface AiIncidentSyncItem {
  id: string;
  source: "mit-aiid";
  sourceIncidentId: string;
  reportedDate: string | null;
  incidentDate: string | null;
  severity: string | null;
  upstreamSeverity: string | null;
  title: string;
  summary: string;
  fullReportUrl: string | null;
  aiModelId: string | null;
  orgId: string | null;
  developerOrgId: string | null;
  attributionConfidence: number | null;
  tags: string[];
  raw: Record<string, unknown>;
  upstreamFetchedAt: string;
  reports: Array<{
    url: string;
    title: string | null;
    publisher: string | null;
    publishedAt: string | null;
    language: string | null;
  }>;
}

/**
 * Max chars before summary is truncated. The route's Zod schema caps
 * `summary` at this same bound — keep them equal. The route declares its
 * own literal `MAX_SUMMARY_CHARS` (rather than importing this constant)
 * to avoid a cross-package dependency from wiki-server into crux; the
 * test in `transform.test.ts` reads the route as text and asserts the
 * two values match so they cannot silently drift.
 */
export const SUMMARY_MAX_CHARS = 4000;

/**
 * Confidence assigned when AIID's own `entities` collection produces a
 * deterministic case-insensitive name match against our entities catalog.
 * Future LLM-based attribution should produce strictly lower values; the
 * route's docstring describes a 0.7 threshold below which FKs must NOT
 * be populated.
 */
export const DETERMINISTIC_MATCH_CONFIDENCE = 1.0;

/**
 * Fields on AIID `reports` that carry the excluded full article body.
 * Stripped from the `raw` copy we persist for auditability.
 */
export const EXCLUDED_REPORT_BODY_FIELDS = ["plain_text", "text", "cloudinary_id"] as const;

/** AIID's incident permalink pattern. */
function incidentPermalink(incidentId: number): string {
  return `https://incidentdatabase.ai/cite/${incidentId}/`;
}

/**
 * Generate a deterministic 10-char incident ID from the upstream identifier.
 * The seed locks in "aiid:<N>" so re-ingesting the same snapshot always
 * produces the same IDs.
 */
export function generateIncidentId(sourceIncidentId: string): string {
  return generateId(`aiid:${sourceIncidentId}`);
}

/**
 * Build a case-insensitive name → stableId lookup from our entities catalog.
 * The caller supplies `(name, stableId, aliases?)` rows pulled from the
 * wiki-server entities table; we normalize keys to lowercase + trim.
 *
 * `aliases` populate the same map under each alias key so AIID's display
 * name match against any one of them resolves the entity. First-wins on
 * collision (across primary names and aliases alike).
 */
export function buildEntityNameIndex(
  rows: Array<{
    name: string;
    stableId: string | null;
    aliases?: string[] | null;
  }>,
): Map<string, string> {
  const idx = new Map<string, string>();
  const tryAdd = (raw: string | undefined | null, stableId: string) => {
    if (!raw) return;
    const key = raw.trim().toLowerCase();
    if (!key) return;
    if (!idx.has(key)) idx.set(key, stableId);
  };
  for (const r of rows) {
    if (!r.stableId) continue;
    tryAdd(r.name, r.stableId);
    for (const alias of r.aliases ?? []) tryAdd(alias, r.stableId);
  }
  return idx;
}

/**
 * Resolve an AIID entity ID (slug) to one of our entity stableIds.
 *
 * AIID entity IDs are slugs like "openai" or "google". We look them up in
 * AIID's `entities` collection to get the display name, then match that
 * name (case-insensitive) against our entities catalog.
 *
 * Returns null when the AIID entity isn't known, or when no match is found
 * in our catalog. Attribution is best-effort — NULL is correct when ambiguous.
 */
export function resolveAiidEntity(
  aiidEntityId: string,
  aiidEntityNames: Map<string, string>,
  ourEntityIndex: Map<string, string>,
): { stableId: string; name: string } | null {
  const name = aiidEntityNames.get(aiidEntityId);
  if (!name) return null;
  const stableId = ourEntityIndex.get(name.trim().toLowerCase());
  if (!stableId) return null;
  return { stableId, name };
}

/** Pick the first item of the array, or null. Defensive against AIID's mixed arrays. */
function firstOr<T>(arr: T[] | undefined | null): T | null {
  if (!arr || arr.length === 0) return null;
  return arr[0] ?? null;
}

/**
 * Pick the most-recently-published report URL for `full_report_url`.
 * Fallback: the AIID incident permalink.
 */
function pickPrimaryReportUrl(
  reports: AiidReportRaw[],
  incidentId: number,
): string {
  if (reports.length === 0) return incidentPermalink(incidentId);
  const sorted = [...reports].sort((a, b) => {
    const da = a.date_published ?? "";
    const db = b.date_published ?? "";
    if (da === db) return 0;
    return da < db ? 1 : -1;
  });
  return sorted[0]?.url ?? incidentPermalink(incidentId);
}

/**
 * Strip the CC-BY-SA-excluded fields before we persist the AIID record as
 * `raw`. Report-body text never touches our DB.
 */
export function sanitizeRawReport(
  report: AiidReportRaw,
): Omit<AiidReportRaw, (typeof EXCLUDED_REPORT_BODY_FIELDS)[number]> {
  const copy: Record<string, unknown> = { ...report };
  for (const key of EXCLUDED_REPORT_BODY_FIELDS) delete copy[key];
  return copy as Omit<AiidReportRaw, (typeof EXCLUDED_REPORT_BODY_FIELDS)[number]>;
}

/**
 * Hard cap on number of tags per incident. Must stay <= the route's Zod
 * `tags.max(50)` limit; if AIID has a pathological incident with more
 * entities than this, we truncate (sorted lex) rather than exceed and
 * fail validation.
 */
export const MAX_TAGS_PER_INCIDENT = 50;

/**
 * Build tags by capturing AIID's classification-adjacent fields: alleged
 * deployers, developers, and harmed parties. These become free-text tags
 * for now — a follow-up attribution pass turns the strong matches into
 * proper entity FKs.
 */
/**
 * Per-tag length must stay under the route's Zod `z.string().max(64)` cap
 * (see `apps/wiki-server/src/routes/tablebase/ai-incidents.ts`). With the
 * 12-char `aiid-entity:` prefix, that leaves 52 chars for the entity name.
 * AIID has long government / NGO display names that exceed this, so we
 * truncate rather than drop — preserves the prefix-driven uniqueness even
 * for the long tail.
 */
const TAG_MAX_CHARS = 64;
const TAG_PREFIX = "aiid-entity:";

function buildTags(
  inc: AiidIncidentRaw,
  aiidEntityNames: Map<string, string>,
): string[] {
  const tags = new Set<string>();
  const push = (arr: string[] | undefined) => {
    if (!arr) return;
    for (const id of arr) {
      const name = aiidEntityNames.get(id);
      if (!name) continue;
      const tag = `${TAG_PREFIX}${name}`.slice(0, TAG_MAX_CHARS);
      tags.add(tag);
    }
  };
  push(inc["Alleged deployer of AI system"]);
  push(inc["Alleged developer of AI system"]);
  push(inc["Alleged harmed or nearly harmed parties"]);
  return Array.from(tags).sort().slice(0, MAX_TAGS_PER_INCIDENT);
}

/** Tighten a free-form summary into the column budget without hard-breaking words. */
export function truncateSummary(text: string, max = SUMMARY_MAX_CHARS): string {
  return truncate(text, max, { wordBoundary: true, ellipsis: "..." });
}

export interface TransformOptions {
  /** ISO8601 timestamp of the upstream fetch. */
  upstreamFetchedAt: string;
  /** Lookup: AIID entity_id → display name. */
  aiidEntityNames: Map<string, string>;
  /** Lookup: lowercase name → our entity stableId. */
  ourEntityIndex: Map<string, string>;
}

/**
 * Transform one AIID incident + its reports into a sync item.
 *
 * Attribution (org_id / developer_org_id) is resolved deterministically here
 * using AIID's own entity_id → name lookup matched against our entities
 * catalog. Confidence is fixed at 1.0 for successful deterministic matches
 * — an LLM pass in a follow-up PR raises resolution on the long tail at a
 * lower confidence that gates FK population.
 */
export function transformIncident(
  inc: AiidIncidentRaw,
  reports: AiidReportRaw[],
  opts: TransformOptions,
): AiIncidentSyncItem {
  const sourceIncidentId = String(inc.incident_id);
  const title = (inc.title ?? "").trim() || `AIID Incident ${sourceIncidentId}`;
  const summary = truncateSummary(
    (inc.description ?? "").trim() || `AIID incident ${sourceIncidentId}`,
  );

  // Attribution: first entry in each array is the canonical one in AIID's
  // schema. Subsequent entries are alternates — capture them in tags.
  const deployerId = firstOr(inc["Alleged deployer of AI system"]);
  const developerId = firstOr(inc["Alleged developer of AI system"]);

  const deployerMatch = deployerId
    ? resolveAiidEntity(
        deployerId,
        opts.aiidEntityNames,
        opts.ourEntityIndex,
      )
    : null;
  const developerMatch = developerId
    ? resolveAiidEntity(
        developerId,
        opts.aiidEntityNames,
        opts.ourEntityIndex,
      )
    : null;

  const hasAttribution = deployerMatch != null || developerMatch != null;

  return {
    id: generateIncidentId(sourceIncidentId),
    source: "mit-aiid",
    sourceIncidentId,
    reportedDate: inc.date ?? null,
    incidentDate: inc.date ?? null,
    severity: null, // AIID doesn't supply a structured severity field
    upstreamSeverity: null,
    title: title.slice(0, 1000),
    summary,
    fullReportUrl: pickPrimaryReportUrl(reports, inc.incident_id),
    aiModelId: null,
    orgId: deployerMatch?.stableId ?? null,
    developerOrgId: developerMatch?.stableId ?? null,
    attributionConfidence: hasAttribution ? DETERMINISTIC_MATCH_CONFIDENCE : null,
    tags: buildTags(inc, opts.aiidEntityNames),
    // Store the full upstream incident + sanitized reports for future
    // attribution passes. Report bodies are stripped.
    raw: {
      incident: inc,
      reports: reports.map(sanitizeRawReport),
    },
    upstreamFetchedAt: opts.upstreamFetchedAt,
    reports: reports.map((r) => ({
      url: r.url,
      title: r.title ?? null,
      publisher: r.source_domain ?? null,
      publishedAt: r.date_published ?? null,
      language: r.language ?? null,
    })),
  };
}

/**
 * Build a lookup from AIID's entities.json into a simple
 * `entity_id → name` Map.
 */
export function buildAiidEntityNameMap(
  entities: AiidEntityRaw[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entities) {
    if (e.entity_id && e.name) m.set(e.entity_id, e.name);
  }
  return m;
}

/**
 * Index reports by `report_number` for O(1) lookup per incident.
 */
export function indexReportsByNumber(
  reports: AiidReportRaw[],
): Map<number, AiidReportRaw> {
  const m = new Map<number, AiidReportRaw>();
  for (const r of reports) {
    if (typeof r.report_number === "number") m.set(r.report_number, r);
  }
  return m;
}

/**
 * Resolve the reports for an incident by looking up each `report_number`
 * in the index. Missing reports are silently dropped — AIID sometimes has
 * orphan references in old incidents.
 */
export function resolveIncidentReports(
  inc: AiidIncidentRaw,
  reportIndex: Map<number, AiidReportRaw>,
): AiidReportRaw[] {
  if (!inc.reports || inc.reports.length === 0) return [];
  const out: AiidReportRaw[] = [];
  for (const n of inc.reports) {
    const r = reportIndex.get(n);
    if (r) out.push(r);
  }
  return out;
}
