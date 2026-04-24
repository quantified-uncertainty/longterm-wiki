/**
 * Crossref → publication importer (T1, QUA-666).
 *
 * Crossref (https://api.crossref.org) is the canonical registry for scholarly
 * DOIs. Given a DOI we get deterministic bibliographic metadata: title,
 * authors, container (journal), published date, publisher, type.
 *
 * API:
 *   GET https://api.crossref.org/works/<doi>
 *   → { status: "ok", message: { ...work... } }
 *
 * Polite pool: include `?mailto=<email>` or a User-Agent with a contact
 * address. We already ship bot@quantifieduncertainty.org in the UA.
 *
 * The importer accepts one DOI per target. Multi-DOI batch is out of scope —
 * use `/works?filter=doi:X,doi:Y,...` if bulk is needed later, but the
 * per-DOI endpoint is simpler + the evidence URL is stable per work.
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
 * DOI format per https://www.doi.org/doi_handbook/2_Numbering.html:
 *   Prefix starts with "10." followed by a registrant code (digits),
 *   then "/" then a suffix (any printable chars).
 *
 * Regex rejects leading/trailing whitespace, disallowed chars, and
 * missing suffix. Not a full RFC-grade validator — just enough to refuse
 * obviously malformed CLI input.
 */
const DOI_RE = /^10\.[0-9]{4,9}\/[^\s]+$/;

export interface CrossrefTarget {
  /** Optional org slug to attach to the publication. */
  orgSlug?: string;
  /** Optional person slug (author) to attach. */
  personSlug?: string;
  /** DOI in bare form (e.g. "10.1145/3442188.3445922"). */
  doi: string;
}

export interface CrossrefOptions extends HttpOptions {
  /** Override base URL (tests inject localhost). */
  apiBase?: string;
  /** mailto for Crossref polite pool. */
  mailto?: string;
}

interface CrossrefAuthor {
  given?: string | null;
  family?: string | null;
  name?: string | null;
  ORCID?: string | null;
}

interface DateParts {
  "date-parts"?: number[][];
}

export interface CrossrefWork {
  DOI: string;
  title?: string[];
  author?: CrossrefAuthor[];
  "container-title"?: string[];
  publisher?: string | null;
  type?: string | null;
  published?: DateParts;
  "published-print"?: DateParts;
  "published-online"?: DateParts;
  issued?: DateParts;
  URL?: string | null;
  subject?: string[];
}

interface CrossrefResponse {
  status?: string;
  message?: CrossrefWork;
}

const DEFAULT_API_BASE = "https://api.crossref.org";

/** Validate a DOI string. Throws on malformed input. */
export function assertValidDoi(doi: string): void {
  if (!DOI_RE.test(doi)) {
    throw new Error(
      `invalid DOI: "${doi}" (must match /^10\\.[0-9]{4,9}\\/[^\\s]+$/)`
    );
  }
}

/**
 * Normalize a DOI: accept URL form ("https://doi.org/..."), strip,
 * validate. Returns the bare DOI. Throws if the result is invalid.
 */
export function normalizeDoi(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("DOI is empty");
  const lower = trimmed.toLowerCase();
  let bare = trimmed;
  for (const prefix of ["https://doi.org/", "http://doi.org/", "doi:"]) {
    if (lower.startsWith(prefix)) {
      bare = trimmed.slice(prefix.length);
      break;
    }
  }
  assertValidDoi(bare);
  return bare;
}

/**
 * Extract a YYYY-MM-DD date from Crossref's date-parts tuple format.
 * `date-parts` is `[[YYYY, MM?, DD?]]` — month and day optional.
 *
 * Zero-pads where necessary. Returns null if the outer array is empty OR
 * the first sub-array is missing/empty (no year).
 */
export function extractDate(parts: DateParts | undefined): string | null {
  const arr = parts?.["date-parts"];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0];
  if (!Array.isArray(first) || first.length === 0) return null;
  const [y, m, d] = first;
  if (typeof y !== "number" || y < 1800) return null;
  const mo = typeof m === "number" && m >= 1 && m <= 12 ? String(m).padStart(2, "0") : "01";
  const day = typeof d === "number" && d >= 1 && d <= 31 ? String(d).padStart(2, "0") : "01";
  return `${y}-${mo}-${day}`;
}

/**
 * Pick the earliest date available across `issued`, `published`,
 * `published-print`, `published-online`. Crossref sometimes populates one
 * but not others; `issued` is the most commonly present.
 */
export function pickPublishedDate(work: CrossrefWork): string | null {
  const candidates = [work.issued, work.published, work["published-print"], work["published-online"]];
  let earliest: string | null = null;
  for (const p of candidates) {
    const d = extractDate(p);
    if (d && (!earliest || d < earliest)) earliest = d;
  }
  return earliest;
}

/**
 * Format a Crossref author to "Given Family" or fall back to `name`
 * (organizational author) or drop it.
 */
export function formatAuthor(a: CrossrefAuthor): string | null {
  if (a.name) return a.name.trim() || null;
  const given = a.given?.trim() ?? "";
  const family = a.family?.trim() ?? "";
  if (given && family) return `${given} ${family}`;
  if (family) return family;
  if (given) return given;
  return null;
}

/**
 * Map Crossref type → our publication type enum. Crossref's `type` values are
 * controlled: https://api.crossref.org/types
 */
export function mapPublicationType(crossrefType: string | null | undefined): string {
  if (!crossrefType) return "paper";
  switch (crossrefType) {
    case "journal-article":
      return "paper";
    case "posted-content":
      return "preprint";
    case "book":
    case "book-section":
    case "book-chapter":
      return "book";
    case "dissertation":
      return "thesis";
    case "report":
    case "report-component":
      return "report";
    case "proceedings-article":
      return "paper";
    default:
      return "paper";
  }
}

/** Fetch one DOI's work metadata. Throws on non-2xx or non-ok payload. */
export async function fetchDoiWork(
  doi: string,
  opts: CrossrefOptions = {}
): Promise<CrossrefWork> {
  assertValidDoi(doi);
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  // Crossref's /works/{doi} expects a URL-encoded DOI in the path.
  const url =
    `${apiBase}/works/${encodeURIComponent(doi)}` +
    (opts.mailto ? `?mailto=${encodeURIComponent(opts.mailto)}` : "");
  const resp = await getFetch(opts)(url, {
    headers: {
      "User-Agent": getUserAgent(opts),
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    throw new Error(`Crossref HTTP ${resp.status} for DOI ${doi}`);
  }
  const data = (await resp.json()) as CrossrefResponse;
  if (data?.status !== "ok" || !data.message) {
    throw new Error(
      `Crossref response status=${data?.status ?? "unknown"} for DOI ${doi}`
    );
  }
  return data.message;
}

/**
 * Build one publication proposal from a Crossref work.
 *
 * Returns null when the work is undatable or missing a title — we don't
 * emit half-populated proposals.
 */
export function buildProposal(
  target: CrossrefTarget,
  work: CrossrefWork
): EnrichmentProposal | null {
  const title = work.title?.[0]?.trim();
  if (!title) return null;
  const date = pickPublishedDate(work);
  if (!date) return null;
  const venue = work["container-title"]?.[0]?.trim() || null;
  const authors = (work.author ?? [])
    .map(formatAuthor)
    .filter((a): a is string => a !== null);
  const url = work.URL ?? `https://doi.org/${target.doi}`;
  const canonical = JSON.stringify({
    doi: target.doi,
    title,
    date,
  });
  const responseHash = createHash("sha256").update(canonical).digest("hex");
  const sourceUrl = `https://doi.org/${target.doi}`;

  // entityRefs: prefer the org, then the person, never both without an org
  // (the propose endpoint links authorships separately — this is just the
  // primary owner for the publication row).
  const entityRefs: EnrichmentProposal["entityRefs"] = {};
  if (target.orgSlug) entityRefs.organization = target.orgSlug;
  if (target.personSlug) entityRefs.person = target.personSlug;

  return {
    tier: "T1",
    source: `${T1_SOURCE_PREFIXES.crossref}${target.doi}`,
    sourceUrl,
    responseHash,
    recordType: "publication",
    record: {
      title,
      doi: target.doi,
      publishedDate: date,
      venue,
      authors,
      publicationType: mapPublicationType(work.type ?? undefined),
      publisher: work.publisher?.trim() ?? null,
      url,
      notes: `Crossref DOI ${target.doi}${work.subject?.length ? ` (subjects: ${work.subject.slice(0, 3).join(", ")})` : ""}`,
    },
    entityRefs,
  };
}

/** End-to-end for one target: fetch + build proposal. */
export async function importTarget(
  target: CrossrefTarget,
  opts: CrossrefOptions = {}
): Promise<{ proposal: EnrichmentProposal | null }> {
  const work = await fetchDoiWork(target.doi, opts);
  return { proposal: buildProposal(target, work) };
}

/** CLI entry — `crux tb crossref --target=doi:10.xxx/yyy`. */
export async function cliMain(args: string[]): Promise<CommandResult> {
  const submit = args.includes("--submit");
  const targets = parseTargetsArg(args);
  if (targets.length === 0) {
    return {
      exitCode: 2,
      output:
        "No targets specified. Pass --target=doi:10.xxx/yyy (optionally with :org=slug or :person=slug)",
    };
  }
  const all: EnrichmentProposal[] = [];
  let totalFailures = 0;
  let totalSkipped = 0;
  for (const t of targets) {
    console.log(`[crossref] fetching ${t.doi}...`);
    try {
      const { proposal } = await importTarget(t);
      if (proposal) {
        console.log(`[crossref]   → 1 publication proposal`);
        all.push(proposal);
      } else {
        console.warn(
          `[crossref]   → skipped ${t.doi} (missing title or undatable)`
        );
        totalSkipped++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[crossref] target ${t.doi} failed: ${msg}`);
      totalFailures++;
    }
  }
  const clientOpts: ProposeClientOptions = { submit };
  const results = await submitBatch(all, clientOpts);
  printBatchSummary(results, "crossref");
  if (totalFailures > 0 || totalSkipped > 0) {
    console.warn(
      `[crossref] ${totalFailures} target failure(s), ${totalSkipped} skipped`
    );
  }
  return { exitCode: 0, output: "" };
}

/**
 * Parse `--target=doi:10.x/y` — and optional `org=<slug>` / `person=<slug>`
 * suffixes in the form `--target=doi:10.x/y|org=anthropic|person=jane-smith`.
 * We pick `|` as the attribute separator because DOIs can legally contain
 * colons, commas, and semicolons; `|` is not a valid DOI character.
 */
export function parseTargetsArg(args: readonly string[]): CrossrefTarget[] {
  const out: CrossrefTarget[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--target=")) continue;
    const value = arg.slice("--target=".length);
    const segments = value.split("|");
    const head = segments[0];
    if (!head.startsWith("doi:")) {
      throw new Error(
        `--target must start with "doi:", got "${value}" (expected "doi:10.xxx/yyy[|org=slug][|person=slug]")`
      );
    }
    const doi = normalizeDoi(head.slice("doi:".length));
    const target: CrossrefTarget = { doi };
    for (const seg of segments.slice(1)) {
      const eq = seg.indexOf("=");
      if (eq === -1) {
        throw new Error(
          `--target attribute must be key=value, got "${seg}"`
        );
      }
      const key = seg.slice(0, eq);
      const val = seg.slice(eq + 1);
      if (!val) {
        throw new Error(`--target attribute "${key}" has empty value`);
      }
      if (key === "org") target.orgSlug = val;
      else if (key === "person") target.personSlug = val;
      else throw new Error(`--target unknown attribute "${key}" (expected "org" or "person")`);
    }
    out.push(target);
  }
  return out;
}
