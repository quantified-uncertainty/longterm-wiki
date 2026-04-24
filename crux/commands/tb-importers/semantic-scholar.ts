/**
 * Semantic Scholar → publications importer (T1, QUA-666).
 *
 * The Semantic Scholar Academic Graph (https://api.semanticscholar.org)
 * exposes author IDs plus a deterministic `author/<id>/papers` endpoint.
 * Given an author resolution (personSlug ↔ S2 authorId) we emit one
 * `publication` proposal per paper.
 *
 * The ticket calls this "author resolution" — our interpretation: the
 * importer accepts pre-resolved author IDs as input (from a prior matching
 * pass) and emits deterministic paper metadata. We do NOT do fuzzy name
 * search here: that's a T2/T3 concern with non-deterministic output.
 *
 * API:
 *   GET https://api.semanticscholar.org/graph/v1/author/<authorId>/papers
 *     ?fields=paperId,externalIds,title,venue,year,publicationDate,publicationTypes,url,abstract
 *     &limit=<≤100>&offset=<n>
 *
 * Offset-based pagination up to 10,000 total records; beyond that the API
 * returns 400 — reasonable cap for a single author.
 *
 * Auth: optional API key via `x-api-key` header (env var
 * `SEMANTIC_SCHOLAR_API_KEY`). Unauth is rate-limited at 1 req/sec shared
 * across the internet, which is usually fine for a seeding importer but
 * you'll want a key for bursts.
 */

import { createHash } from "crypto";
import {
  submitBatch,
  printBatchSummary,
  type ProposeClientOptions,
} from "./propose-client.ts";
import { getFetch, getUserAgent, type HttpOptions } from "./http-utils.ts";
import { T1_SOURCE_PREFIXES } from "./allowlist.ts";
import { mapPublicationType as mapOpenAlexType } from "./openalex.ts";
import type { CommandResult } from "../../lib/command-types.ts";
import type { EnrichmentProposal } from "./types.ts";

/**
 * Semantic Scholar author IDs are numeric strings. Historically 1–10 digits.
 */
const AUTHOR_ID_RE = /^\d+$/;

export interface SemanticScholarTarget {
  /** Personnel slug from data/entities or the personnel table. */
  personSlug: string;
  /** Display name for the person */
  personName: string;
  /** Semantic Scholar author ID (e.g. "1712334" for a real author). */
  authorId: string;
}

export interface SemanticScholarOptions extends HttpOptions {
  /** Override base URL (tests inject localhost). */
  apiBase?: string;
  /** Page size (max 100 per S2 docs). */
  limit?: number;
  /** Hard cap on total papers fetched per target (defaults to 500). */
  maxPapers?: number;
  /** `x-api-key` header value. Stripped of CR/LF before send. */
  apiKey?: string;
}

export interface SemanticScholarPaper {
  paperId: string;
  externalIds?: {
    DOI?: string | null;
    ArXiv?: string | null;
    CorpusId?: number | null;
  } | null;
  title?: string | null;
  venue?: string | null;
  year?: number | null;
  publicationDate?: string | null;
  publicationTypes?: string[] | null;
  url?: string | null;
}

interface PapersResponse {
  offset?: number;
  next?: number | null;
  total?: number;
  data?: SemanticScholarPaper[];
}

const DEFAULT_API_BASE = "https://api.semanticscholar.org/graph/v1";
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_PAPERS = 500;
const MAX_LIMIT = 100;
const S2_API_OFFSET_CAP = 10_000;

/** Validate an S2 author ID. */
export function assertValidAuthorId(id: string): void {
  if (!AUTHOR_ID_RE.test(id)) {
    throw new Error(
      `invalid Semantic Scholar author id: "${id}" (must match /^\\d+$/)`
    );
  }
}

/**
 * Map S2 publicationTypes[] → our publication type. S2 returns an ARRAY
 * like ["JournalArticle"], ["Conference", "JournalArticle"], or null.
 *
 * We pick the most specific element: Book > Dataset > Review >
 * JournalArticle > Conference > anything else → "paper". Preprints show up
 * as JournalArticle with a `arXiv` externalId; callers who want that
 * granularity can inspect `externalIds`.
 */
export function mapPublicationType(types: string[] | null | undefined): string {
  if (!types || types.length === 0) return "paper";
  if (types.includes("Book")) return "book";
  if (types.includes("Review")) return "paper";
  if (types.includes("Dataset")) return "paper";
  if (types.includes("JournalArticle")) return "paper";
  if (types.includes("Conference")) return "paper";
  // Fallback via the shared OpenAlex mapper; unknown → "paper".
  return mapOpenAlexType(types[0]);
}

/**
 * Normalize a DOI to bare form. Mirrors the OpenAlex helper.
 * Returns null for empty input.
 */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const lower = trimmed.toLowerCase();
  for (const prefix of ["https://doi.org/", "http://doi.org/", "doi:"]) {
    if (lower.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return trimmed;
}

/**
 * Fetch all papers for an author via offset pagination. Respects maxPapers
 * and the S2-imposed offset cap.
 */
export async function fetchAuthorPapers(
  authorId: string,
  opts: SemanticScholarOptions = {}
): Promise<SemanticScholarPaper[]> {
  assertValidAuthorId(authorId);
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const maxPapers = opts.maxPapers ?? DEFAULT_MAX_PAPERS;
  const fetchImpl = getFetch(opts);
  const headers: Record<string, string> = {
    "User-Agent": getUserAgent(opts),
    Accept: "application/json",
  };
  if (opts.apiKey) {
    // Strip CR/LF from user-supplied key — same header-injection guard as User-Agent.
    headers["x-api-key"] = opts.apiKey.replace(/[\r\n]/g, "").trim();
  }

  const papers: SemanticScholarPaper[] = [];
  let offset = 0;
  while (papers.length < maxPapers && offset < S2_API_OFFSET_CAP) {
    const params = new URLSearchParams({
      fields:
        "paperId,externalIds,title,venue,year,publicationDate,publicationTypes,url",
      limit: String(limit),
      offset: String(offset),
    });
    const url = `${apiBase}/author/${encodeURIComponent(authorId)}/papers?${params.toString()}`;
    const resp = await fetchImpl(url, { headers });
    if (!resp.ok) {
      throw new Error(
        `Semantic Scholar papers HTTP ${resp.status} for author ${authorId}`
      );
    }
    const data = (await resp.json()) as PapersResponse;
    const batch = data?.data;
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const p of batch) {
      papers.push(p);
      if (papers.length >= maxPapers) break;
    }
    const next = data?.next;
    if (typeof next !== "number" || next <= offset) break;
    offset = next;
  }
  return papers;
}

/**
 * Build one publication proposal from one S2 paper.
 *
 * Skips papers with no title, no date, or a nonsensical year (S2 has some
 * year=0 rows for undated preprints).
 *
 * entityRefs.person points to the target person slug; the propose endpoint
 * will link the paper-author relationship.
 */
export function buildProposal(
  target: SemanticScholarTarget,
  paper: SemanticScholarPaper
): EnrichmentProposal | null {
  const title = paper.title?.trim();
  if (!title) return null;
  const date = paper.publicationDate
    ?? (paper.year && paper.year > 1800 ? `${paper.year}-01-01` : null);
  if (!date) return null;
  const doi = normalizeDoi(paper.externalIds?.DOI);
  const arxiv = paper.externalIds?.ArXiv ?? null;
  const venue = paper.venue?.trim() || null;
  const url = paper.url
    ?? (doi ? `https://doi.org/${doi}` : `https://www.semanticscholar.org/paper/${paper.paperId}`);

  const canonical = JSON.stringify({
    paperId: paper.paperId,
    doi,
    arxiv,
    title,
    date,
  });
  const responseHash = createHash("sha256").update(canonical).digest("hex");
  const sourceUrl = `https://www.semanticscholar.org/paper/${paper.paperId}`;

  const notesParts: string[] = [
    `Semantic Scholar paper ${paper.paperId}`,
    `author ${target.authorId} (${target.personName})`,
  ];
  if (arxiv) notesParts.push(`arXiv:${arxiv}`);

  return {
    tier: "T1",
    source: `${T1_SOURCE_PREFIXES.semanticScholar}${paper.paperId}`,
    sourceUrl,
    responseHash,
    recordType: "publication",
    record: {
      title,
      doi,
      arxivId: arxiv,
      publishedDate: date,
      venue,
      publicationType: mapPublicationType(paper.publicationTypes ?? undefined),
      url,
      notes: notesParts.join(" — "),
    },
    entityRefs: { person: target.personSlug },
  };
}

/** End-to-end for one target: fetch + build proposals. */
export async function importTarget(
  target: SemanticScholarTarget,
  opts: SemanticScholarOptions = {}
): Promise<{ proposals: EnrichmentProposal[]; skipped: number }> {
  const papers = await fetchAuthorPapers(target.authorId, opts);
  const proposals: EnrichmentProposal[] = [];
  let skipped = 0;
  for (const p of papers) {
    const proposal = buildProposal(target, p);
    if (proposal) proposals.push(proposal);
    else skipped++;
  }
  return { proposals, skipped };
}

/** CLI entry — `crux tb semantic-scholar --target=slug:name:authorId`. */
export async function cliMain(args: string[]): Promise<CommandResult> {
  const submit = args.includes("--submit");
  const targets = parseTargetsArg(args);
  if (targets.length === 0) {
    return {
      exitCode: 2,
      output:
        "No targets specified. Pass --target=personSlug:displayName:authorId (repeatable)",
    };
  }
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const all: EnrichmentProposal[] = [];
  let totalFailures = 0;
  let totalSkipped = 0;
  for (const t of targets) {
    console.log(
      `[semantic-scholar] fetching ${t.personSlug} (author ${t.authorId})...`
    );
    try {
      const { proposals, skipped } = await importTarget(t, { apiKey });
      console.log(
        `[semantic-scholar]   → ${proposals.length} publication proposals, ${skipped} skipped (missing title/date)`
      );
      all.push(...proposals);
      totalSkipped += skipped;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[semantic-scholar] target ${t.personSlug} failed: ${msg}`
      );
      totalFailures++;
    }
  }
  const clientOpts: ProposeClientOptions = { submit };
  const results = await submitBatch(all, clientOpts);
  printBatchSummary(results, "semantic-scholar");
  if (totalFailures > 0 || totalSkipped > 0) {
    console.warn(
      `[semantic-scholar] ${totalFailures} target failure(s), ${totalSkipped} paper(s) skipped`
    );
  }
  return { exitCode: 0, output: "" };
}

/**
 * Parse `--target=personSlug:displayName:authorId`. displayName may contain
 * colons (we split on the first two only).
 */
export function parseTargetsArg(args: readonly string[]): SemanticScholarTarget[] {
  const out: SemanticScholarTarget[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--target=")) continue;
    const value = arg.slice("--target=".length);
    // First colon separates slug from the rest; last colon separates
    // authorId from displayName. displayName is anything in between.
    const firstColon = value.indexOf(":");
    const lastColon = value.lastIndexOf(":");
    if (firstColon === -1 || lastColon === -1 || firstColon === lastColon) {
      throw new Error(
        `--target must be personSlug:displayName:authorId (at least two colons), got "${value}"`
      );
    }
    const personSlug = value.slice(0, firstColon);
    const personName = value.slice(firstColon + 1, lastColon);
    const authorId = value.slice(lastColon + 1);
    if (!personSlug || !personName || !authorId) {
      throw new Error(`--target has empty segment(s): "${value}"`);
    }
    assertValidAuthorId(authorId);
    out.push({ personSlug, personName, authorId });
  }
  return out;
}
