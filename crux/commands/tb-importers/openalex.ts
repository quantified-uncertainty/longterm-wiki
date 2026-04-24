/**
 * OpenAlex works → publications importer (T1, QUA-666).
 *
 * OpenAlex (https://openalex.org) is a free, open index of ~200M scholarly
 * works with structured metadata. For an AI safety org like Anthropic
 * (institution id I4210125762), the works-by-institution endpoint returns
 * deterministic paper metadata: DOI, title, authors, venue, published date,
 * type (journal-article | preprint | report | book-chapter | …).
 *
 * API:
 *   GET https://api.openalex.org/works
 *     ?filter=authorships.institutions.id:I<N>
 *     &per-page=<≤200>&cursor=<token>
 *     &select=id,doi,title,publication_date,publication_year,type,authorships,primary_location
 *
 * Cursor pagination is required past the first 10,000 results; start with
 * `cursor=*` and follow `meta.next_cursor` until null.
 *
 * Polite pool: include `mailto=<email>` in query or User-Agent for higher
 * rate limits. OpenAlex is otherwise free + unauth.
 */

import { createHash } from "crypto";
import {
  submitBatch,
  printBatchSummary,
  type ProposeClientOptions,
} from "./propose-client.ts";
import { getFetch, getUserAgent, type HttpOptions } from "./http-utils.ts";
import { T1_SOURCE_PREFIXES } from "./allowlist.ts";
import type { CommandResult } from "../../lib/command-types.ts";
import type { EnrichmentProposal } from "./types.ts";

/**
 * OpenAlex institution IDs are `I` followed by 1+ digits. No leading zeros
 * (OpenAlex never emits them).
 */
const INSTITUTION_ID_RE = /^I[1-9]\d*$/;

export interface OpenAlexTarget {
  /** Org slug from data/entities/organizations.yaml */
  orgSlug: string;
  /** Display name for the org */
  orgName: string;
  /** OpenAlex institution ID (e.g., "I4210125762" for Anthropic). */
  institutionId: string;
}

export interface OpenAlexOptions extends HttpOptions {
  /** Override base URL (tests inject localhost). */
  apiBase?: string;
  /** Page size (max 200 per OpenAlex docs). */
  perPage?: number;
  /** Hard cap on total works fetched per target (defaults to 500). */
  maxWorks?: number;
  /** mailto for the OpenAlex polite pool. */
  mailto?: string;
  /** If set, only return works published on or after this YYYY-MM-DD. */
  sinceDate?: string;
}

export interface OpenAlexAuthorship {
  author?: { id?: string | null; display_name?: string | null };
  institutions?: Array<{ id?: string | null; display_name?: string | null }>;
  raw_author_name?: string | null;
}

export interface OpenAlexWork {
  id: string; // "https://openalex.org/Wxxx"
  doi?: string | null;
  title?: string | null;
  publication_date?: string | null;
  publication_year?: number | null;
  type?: string | null;
  authorships?: OpenAlexAuthorship[];
  primary_location?: {
    source?: { display_name?: string | null; type?: string | null } | null;
    landing_page_url?: string | null;
  } | null;
}

interface WorksResponse {
  meta?: { count?: number; next_cursor?: string | null };
  results?: OpenAlexWork[];
}

const DEFAULT_API_BASE = "https://api.openalex.org";
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_WORKS = 500;
const MAX_PER_PAGE = 200;

/** Validate an OpenAlex institution ID. Throws on malformed input. */
export function assertValidInstitutionId(id: string): void {
  if (!INSTITUTION_ID_RE.test(id)) {
    throw new Error(
      `invalid OpenAlex institution id: "${id}" (must match /^I[1-9]\\d*$/)`
    );
  }
}

/**
 * OpenAlex publishes DOIs in two shapes: bare ("10.1145/...") and URL form
 * ("https://doi.org/10.1145/..."). Normalize to bare for record storage;
 * the URL form is derivable on demand.
 *
 * Returns null for empty input rather than throwing, because many works
 * legitimately have no DOI (preprints, reports, internal papers).
 */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const lower = trimmed.toLowerCase();
  // Strip common URL prefixes
  for (const prefix of ["https://doi.org/", "http://doi.org/", "doi:"]) {
    if (lower.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return trimmed;
}

/** Strip the OpenAlex URL-prefix from a work ID to get the bare `Wnnn`. */
export function workShortId(id: string): string {
  return id.replace(/^https?:\/\/openalex\.org\//, "");
}

/**
 * Map OpenAlex work `type` → our publicationType enum. Keeps the set small
 * (matches `VALID_PUBLICATION_TYPES` in apps/wiki-server/src/routes/tablebase/publications.ts).
 * Unknown types → "paper" as a neutral default.
 */
export function mapPublicationType(openalexType: string | null | undefined): string {
  if (!openalexType) return "paper";
  switch (openalexType) {
    case "journal-article":
    case "article":
      return "paper";
    case "preprint":
      return "preprint";
    case "book-chapter":
    case "book":
      return "book";
    case "dissertation":
      return "thesis";
    case "report":
      return "report";
    default:
      return "paper";
  }
}

/**
 * Fetch all works for an institution via cursor pagination.
 * Respects `maxWorks` — stops early when the cap is hit OR when the cursor
 * runs out, whichever comes first.
 */
export async function fetchInstitutionWorks(
  institutionId: string,
  opts: OpenAlexOptions = {}
): Promise<OpenAlexWork[]> {
  assertValidInstitutionId(institutionId);
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const perPage = Math.min(opts.perPage ?? DEFAULT_PER_PAGE, MAX_PER_PAGE);
  const maxWorks = opts.maxWorks ?? DEFAULT_MAX_WORKS;
  const fetchImpl = getFetch(opts);
  const headers: Record<string, string> = {
    "User-Agent": getUserAgent(opts),
    Accept: "application/json",
  };

  const works: OpenAlexWork[] = [];
  let cursor: string | null = "*";
  let loops = 0;
  const MAX_LOOPS = 1000; // hard guard against runaway loops
  while (cursor && works.length < maxWorks && loops < MAX_LOOPS) {
    loops++;
    const params = new URLSearchParams({
      filter: `authorships.institutions.id:${institutionId}` +
        (opts.sinceDate ? `,from_publication_date:${opts.sinceDate}` : ""),
      "per-page": String(perPage),
      cursor,
      select:
        "id,doi,title,publication_date,publication_year,type,authorships,primary_location",
    });
    if (opts.mailto) params.set("mailto", opts.mailto);
    const url = `${apiBase}/works?${params.toString()}`;
    const resp = await fetchImpl(url, { headers });
    if (!resp.ok) {
      throw new Error(`OpenAlex works HTTP ${resp.status} for ${institutionId}`);
    }
    const data = (await resp.json()) as WorksResponse;
    const results = data?.results;
    if (!Array.isArray(results) || results.length === 0) break;
    for (const w of results) {
      works.push(w);
      if (works.length >= maxWorks) break;
    }
    cursor = data?.meta?.next_cursor ?? null;
  }
  return works;
}

/**
 * Build one publication proposal from one OpenAlex work.
 *
 * Policy:
 *  - Skip works with no title (junk rows we can't usefully store)
 *  - Skip works with no `publication_date` AND no `publication_year`
 *    (undatable works violate PG `publications.published_date` NOT NULL
 *    downstream — fail early at the importer)
 *  - DOI is optional — preprints and internal reports often lack one
 *  - `entityRefs.organization` = target orgSlug (author→institution comes
 *    via authorship; we emit one proposal per work, scoped to this target
 *    org's institution id in the filter)
 */
export function buildProposal(
  target: OpenAlexTarget,
  work: OpenAlexWork
): EnrichmentProposal | null {
  const title = work.title?.trim();
  if (!title) return null;
  const date = work.publication_date
    ?? (work.publication_year ? `${work.publication_year}-01-01` : null);
  if (!date) return null;
  const doi = normalizeDoi(work.doi);
  const shortId = workShortId(work.id);
  const venue = work.primary_location?.source?.display_name?.trim() || null;
  // Authors: `display_name` is the canonical field; fall back to `raw_author_name`
  // when OpenAlex hasn't resolved the authorship. Deduped preserving order.
  const seenAuthors = new Set<string>();
  const authors: string[] = [];
  for (const a of work.authorships ?? []) {
    // Use || (not ??) so an empty-string display_name falls through to raw_author_name.
    const name = (a.author?.display_name || a.raw_author_name || "").trim();
    if (!name || seenAuthors.has(name)) continue;
    seenAuthors.add(name);
    authors.push(name);
  }
  const url = work.primary_location?.landing_page_url
    ?? (doi ? `https://doi.org/${doi}` : `https://openalex.org/${shortId}`);

  // Canonicalize on (openalex id, doi, title, date) — these are the fields
  // the server will actually persist. Stable hashes survive minor changes
  // in author list ordering on re-fetch.
  const canonical = JSON.stringify({ id: work.id, doi, title, date });
  const responseHash = createHash("sha256").update(canonical).digest("hex");
  const sourceUrl = `https://openalex.org/${shortId}`;

  return {
    tier: "T1",
    source: `${T1_SOURCE_PREFIXES.openalex}${shortId}`,
    sourceUrl,
    responseHash,
    recordType: "publication",
    record: {
      title,
      doi,
      publishedDate: date,
      venue,
      authors,
      publicationType: mapPublicationType(work.type),
      url,
      notes: `OpenAlex work ${shortId} (institution ${target.orgSlug})`,
      orgDisplayName: target.orgName,
    },
    entityRefs: { organization: target.orgSlug },
  };
}

/** End-to-end for one target: fetch + build proposals. */
export async function importTarget(
  target: OpenAlexTarget,
  opts: OpenAlexOptions = {}
): Promise<{ proposals: EnrichmentProposal[]; skipped: number }> {
  const works = await fetchInstitutionWorks(target.institutionId, opts);
  const proposals: EnrichmentProposal[] = [];
  let skipped = 0;
  for (const w of works) {
    const p = buildProposal(target, w);
    if (p) proposals.push(p);
    else skipped++;
  }
  return { proposals, skipped };
}

/** CLI entry — `crux tb openalex --target=slug:Innn`. */
export async function cliMain(args: string[]): Promise<CommandResult> {
  const submit = args.includes("--submit");
  const targets = parseTargetsArg(args);
  if (targets.length === 0) {
    return {
      exitCode: 2,
      output:
        "No targets specified. Pass --target=slug:Iinstitution_id (repeatable)",
    };
  }
  const all: EnrichmentProposal[] = [];
  let totalFailures = 0;
  let totalSkipped = 0;
  for (const t of targets) {
    console.log(`[openalex] fetching ${t.orgSlug} (${t.institutionId})...`);
    try {
      const { proposals, skipped } = await importTarget(t);
      console.log(
        `[openalex]   → ${proposals.length} publication proposals, ${skipped} skipped (missing title/date)`
      );
      all.push(...proposals);
      totalSkipped += skipped;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[openalex] target ${t.orgSlug} failed: ${msg}`);
      totalFailures++;
    }
  }
  const clientOpts: ProposeClientOptions = { submit };
  const results = await submitBatch(all, clientOpts);
  printBatchSummary(results, "openalex");
  if (totalFailures > 0 || totalSkipped > 0) {
    console.warn(
      `[openalex] ${totalFailures} target failure(s), ${totalSkipped} work(s) skipped`
    );
  }
  return { exitCode: 0, output: "" };
}

/** Parse `--target=slug:Ixxx`. Strict colon count + institution ID format. */
export function parseTargetsArg(args: readonly string[]): OpenAlexTarget[] {
  const out: OpenAlexTarget[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--target=")) continue;
    const value = arg.slice("--target=".length);
    const parts = value.split(":");
    if (parts.length !== 2) {
      throw new Error(
        `--target must be slug:Iinstitution_id (exactly one colon), got "${value}"`
      );
    }
    const [orgSlug, institutionId] = parts;
    if (!orgSlug || !institutionId) {
      throw new Error(`--target slug and institution_id must both be non-empty, got "${value}"`);
    }
    assertValidInstitutionId(institutionId);
    out.push({ orgSlug, orgName: orgSlug, institutionId });
  }
  return out;
}
