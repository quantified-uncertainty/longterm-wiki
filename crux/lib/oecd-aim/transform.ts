/**
 * Transform OECD AI Incident Monitor (AIM) records into ai-incidents
 * sync-handler items.
 *
 * The OECD AIM exposes a JSON list endpoint at
 *   POST https://incidents-server.oecdai.org/api/v1/incidents/fetch-incidents
 * which returns up to 100 incidents per call. Per-incident detail (article
 * URLs) lives at
 *   GET  https://incidents-server.oecdai.org/api/v1/incidents/{id}
 *
 * LICENSE (no explicit open-data license at oecd.ai):
 *   - Conservative default: mirror metadata + link-out only.
 *   - Article body text is NOT exposed by the upstream API (the detail
 *     endpoint always returns `body: ""`); we drop the field defensively
 *     anyway when persisting `raw`, paralleling the AIID exclusion of
 *     `reports.text`.
 *
 * Pure functions only — keep this file network-free so it stays cheap to
 * unit-test. I/O lives in fetch.ts and the CLI command.
 */

import { generateId } from "../grant-import/id.ts";
import { truncate } from "../text-utils.ts";

/** OECD AIM incident shape returned by `/api/v1/incidents/fetch-incidents`. */
export interface OecdAimIncidentRaw {
  /** Format `YYYY-MM-DD-XXXX`, e.g. "2026-04-27-f686". Stable across pulls. */
  id: string;
  title: string;
  /** Always `null` in the list endpoint; populated only by the detail endpoint. */
  articles: OecdAimArticleRaw[] | null;
  n_articles: number;
  /** YYYY-MM-DD */
  date: string;
  location?: {
    location?: string | null;
    country?: string | null;
    country_code?: string | null;
  } | null;
  evidences?: string[] | null;
  summary?: string | null;
  image?: string | null;
  company?: string | null;
  concepts?: Array<{
    score?: number;
    type?: string;
    label?: { eng?: string };
  }> | null;
  properties?: {
    principles?: string[] | null;
    industries?: string[] | null;
    harmed_entities?: string[] | null;
    harm_levels?: string[] | null;
    harm_types?: string[] | null;
    most_severe_harm?: string | null;
    business_functions?: string[] | null;
    deployment_breadth?: string | null;
    ai_tasks?: string[] | null;
    autonomy_level?: string | null;
    languages?: string[] | null;
  } | null;
  /** Cross-source link: AIID incident IDs flagged as covering the same event. */
  aiid_ids?: number[] | null;
  language_counts?: Record<string, number> | null;
  is_legacy?: boolean | null;
  [key: string]: unknown;
}

/** Article shape returned by the detail endpoint. */
export interface OecdAimArticleRaw {
  title?: string | null;
  /** YYYY-MM-DD */
  date?: string | null;
  /** Always empty string `""` in upstream data — we drop it defensively. */
  body?: string;
  publisher?: string | null;
  country?: string | null;
  url?: string | null;
  image?: string | null;
  thumbImage?: string | null;
  evidences?: string[] | null;
  concepts?: Array<{
    score?: number;
    type?: string;
    label?: { eng?: string };
  }> | null;
  [key: string]: unknown;
}

/** Output item — shape must match SyncAiIncidentItemSchema in ai-incidents.ts. */
export interface AiIncidentSyncItem {
  id: string;
  source: "oecd-aim";
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
 * Max chars for `summary`. Mirrors `SUMMARY_MAX_CHARS` in
 * `crux/lib/aiid/transform.ts` — both feed the same route Zod schema.
 */
export const SUMMARY_MAX_CHARS = 4000;

/**
 * Max title length the route accepts (Zod `z.string().max(1000)`).
 */
export const TITLE_MAX_CHARS = 1000;

/**
 * Hard cap on number of tags per incident. Must stay <= the route's Zod
 * `tags.max(50)` limit. AIM has rich classifications (industries, harm types,
 * AI tasks, autonomy level, principles) — we union into a tag set with
 * type-prefixed keys so it's clear which OECD facet each tag came from.
 */
export const MAX_TAGS_PER_INCIDENT = 50;

/**
 * Per-tag length must stay under the route's Zod `z.string().max(64)` cap.
 * Long classification names from AIM occasionally exceed this; we truncate
 * preserving the prefix.
 */
const TAG_MAX_CHARS = 64;

/**
 * Article body fields stripped before we persist a sanitized `raw` copy.
 * The list endpoint never includes `body`/article content, but the detail
 * endpoint *does* expose a `body` field (always empty in observed data).
 * Strip defensively in case upstream populates it later. Also strip image
 * URLs whose copyright we don't know.
 */
export const EXCLUDED_ARTICLE_BODY_FIELDS = ["body", "thumbImage"] as const;

/**
 * AIM permalink. Verified to return 200 — used as `fullReportUrl` when no
 * better article URL is known.
 */
export function aimPermalink(incidentId: string): string {
  return `https://oecd.ai/en/incidents/${incidentId}`;
}

/**
 * Generate a deterministic 10-char incident ID from the AIM identifier.
 * Seed locks in `oecd-aim:<id>` so re-ingesting always produces the same IDs.
 */
export function generateIncidentId(sourceIncidentId: string): string {
  return generateId(`oecd-aim:${sourceIncidentId}`);
}

/** Tighten a free-form summary into the column budget without hard-breaking words. */
export function truncateSummary(text: string, max = SUMMARY_MAX_CHARS): string {
  return truncate(text, max, { wordBoundary: true, ellipsis: "..." });
}

/**
 * Build the tags array from AIM's classification fields. We type-prefix each
 * tag so consumers can filter by facet (e.g. `industry:` vs `principle:`).
 * Sorted lex + truncated to MAX_TAGS_PER_INCIDENT.
 */
function buildTags(inc: OecdAimIncidentRaw): string[] {
  const tags = new Set<string>();
  const push = (prefix: string, values: string[] | null | undefined) => {
    if (!values) return;
    for (const v of values) {
      if (typeof v !== "string") continue;
      const trimmed = v.trim();
      if (!trimmed) continue;
      tags.add(`${prefix}${trimmed}`.slice(0, TAG_MAX_CHARS));
    }
  };
  const props = inc.properties ?? {};
  push("aim-industry:", props.industries ?? null);
  push("aim-harm-type:", props.harm_types ?? null);
  push("aim-harm-level:", props.harm_levels ?? null);
  push("aim-principle:", props.principles ?? null);
  push("aim-business-function:", props.business_functions ?? null);
  push("aim-ai-task:", props.ai_tasks ?? null);
  push("aim-harmed-entity:", props.harmed_entities ?? null);
  if (props.autonomy_level) {
    push("aim-autonomy:", [props.autonomy_level]);
  }
  // Country is a single-valued field on `location`; keep it as a tag for filterability.
  if (inc.location?.country_code) {
    push("aim-country:", [inc.location.country_code]);
  }
  return Array.from(tags).sort().slice(0, MAX_TAGS_PER_INCIDENT);
}

/**
 * Combine OECD AIM `harm_levels` into a single human-readable string for
 * `upstream_severity`. AIM does NOT supply a numeric/ordinal severity ladder
 * (low/medium/high/critical) — `most_severe_harm` is null for all sampled
 * incidents and `harm_levels` carries categorical tags like
 * "AI incident" / "AI hazard". We preserve this raw signal in
 * `upstreamSeverity` and leave `severity` null until a downstream pass
 * derives one.
 */
export function deriveUpstreamSeverity(
  inc: OecdAimIncidentRaw,
): string | null {
  const props = inc.properties ?? {};
  if (props.most_severe_harm && props.most_severe_harm.trim()) {
    return props.most_severe_harm.trim().slice(0, 64);
  }
  const levels = (props.harm_levels ?? [])
    .map((l) => l?.trim())
    .filter((l): l is string => !!l);
  if (levels.length === 0) return null;
  // Stable order: lex-sorted, "+" joined, capped at column budget.
  const joined = Array.from(new Set(levels)).sort().join("+");
  return joined.slice(0, 64);
}

/**
 * Strip article fields whose body content / non-licensed images we don't
 * persist. Mirrors `sanitizeRawReport()` in the AIID transform.
 */
export function sanitizeRawArticle(
  article: OecdAimArticleRaw,
): Omit<OecdAimArticleRaw, (typeof EXCLUDED_ARTICLE_BODY_FIELDS)[number]> {
  const copy: Record<string, unknown> = { ...article };
  for (const key of EXCLUDED_ARTICLE_BODY_FIELDS) delete copy[key];
  return copy as Omit<
    OecdAimArticleRaw,
    (typeof EXCLUDED_ARTICLE_BODY_FIELDS)[number]
  >;
}

/**
 * Pick the most-recently-published article URL for `full_report_url`.
 * Fallback: the OECD AIM permalink for the incident.
 */
function pickPrimaryReportUrl(
  articles: OecdAimArticleRaw[],
  incidentId: string,
): string {
  const withUrls = articles
    .filter(
      (a): a is OecdAimArticleRaw & { url: string } =>
        typeof a.url === "string" && a.url.trim().length > 0,
    )
    .map((a) => ({ ...a, url: a.url.trim() }));
  if (withUrls.length === 0) return aimPermalink(incidentId);
  const sorted = [...withUrls].sort((a, b) => {
    const da = a.date ?? "";
    const db = b.date ?? "";
    if (da === db) return 0;
    return da < db ? 1 : -1;
  });
  return sorted[0]?.url ?? aimPermalink(incidentId);
}

export interface TransformOptions {
  /** ISO8601 timestamp of the upstream fetch. */
  upstreamFetchedAt: string;
}

/**
 * Transform one AIM incident (with optional resolved articles) into a sync
 * item.
 *
 * Attribution (org_id / developer_org_id / ai_model_id) is intentionally NOT
 * resolved from AIM's `concepts[]`/`company` fields here: per the QUA-696
 * scope, attribution requires an LLM pass and is out of scope for this
 * ingest. All FKs are emitted as null and `attributionConfidence` is null.
 */
export function transformIncident(
  inc: OecdAimIncidentRaw,
  articles: OecdAimArticleRaw[],
  opts: TransformOptions,
): AiIncidentSyncItem {
  const sourceIncidentId = inc.id;
  const rawTitle = (inc.title ?? "").trim();
  const title = (rawTitle || `OECD AIM Incident ${sourceIncidentId}`).slice(
    0,
    TITLE_MAX_CHARS,
  );
  const rawSummary = (inc.summary ?? "").trim();
  const summary = truncateSummary(
    rawSummary || `OECD AIM incident ${sourceIncidentId}`,
  );

  const sanitizedArticles = articles.map(sanitizeRawArticle);
  // Defensive: also strip body/thumbImage from the inline articles[] on the
  // raw incident record before we persist it. Upstream embeds them only on
  // the detail endpoint, but if the caller hands us a detail-shaped record
  // we don't want body text leaking into `raw`.
  const sanitizedInlineArticles = inc.articles
    ? inc.articles.map(sanitizeRawArticle)
    : null;
  const rawIncident: Record<string, unknown> = {
    ...inc,
    articles: sanitizedInlineArticles,
  };

  return {
    id: generateIncidentId(sourceIncidentId),
    source: "oecd-aim",
    sourceIncidentId,
    reportedDate: inc.date ?? null,
    incidentDate: inc.date ?? null,
    severity: null,
    upstreamSeverity: deriveUpstreamSeverity(inc),
    title,
    summary,
    fullReportUrl: pickPrimaryReportUrl(articles, sourceIncidentId),
    aiModelId: null,
    orgId: null,
    developerOrgId: null,
    attributionConfidence: null,
    tags: buildTags(inc),
    raw: {
      incident: rawIncident,
      articles: sanitizedArticles,
    },
    upstreamFetchedAt: opts.upstreamFetchedAt,
    reports: articles
      .filter(
        (a): a is OecdAimArticleRaw & { url: string } =>
          typeof a.url === "string" && a.url.trim().length > 0,
      )
      .map((a) => ({
        url: a.url.trim(),
        title: a.title?.trim() ? a.title.trim().slice(0, 1000) : null,
        publisher: a.publisher?.trim() ? a.publisher.trim().slice(0, 500) : null,
        publishedAt: a.date ?? null,
        // AIM doesn't tag per-article language; use language_counts at the
        // incident level for the dominant language if present.
        language: dominantLanguage(inc) ?? null,
      })),
  };
}

/**
 * Pick the dominant per-incident language from `language_counts`. Returns
 * the 3-letter ISO 639 code with the highest count, or null. Used to back
 * each report row's `language` since AIM doesn't tag per-article language.
 */
function dominantLanguage(inc: OecdAimIncidentRaw): string | null {
  const counts = inc.language_counts;
  if (!counts) return null;
  let best: string | null = null;
  let bestCount = -1;
  for (const [lang, count] of Object.entries(counts)) {
    if (typeof count !== "number") continue;
    if (count > bestCount) {
      bestCount = count;
      best = lang;
    }
  }
  // Column is varchar(8), so 3-letter ISO 639-3 codes fit easily.
  return best?.slice(0, 8) ?? null;
}
