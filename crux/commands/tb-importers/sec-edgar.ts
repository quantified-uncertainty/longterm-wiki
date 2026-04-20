/**
 * SEC EDGAR Form D importer (T1, QUA-640).
 *
 * Form D = notice of exempt offering of securities. US private offerings
 * (Anthropic, OpenAI, Runway, Character.AI, Inflection, xAI, Cohere, etc.)
 * file these. The data is structured XML with deterministic fields:
 * IssuerName, FilingDate, TotalAmountSold, MinimumInvestmentAccepted, etc.
 *
 * Source documentation: https://www.sec.gov/forms (Form D)
 * EDGAR submissions API: https://data.sec.gov/submissions/CIK<10-digit>.json
 *   (returns recent.form[] / recent.accessionNumber[] / recent.filingDate[])
 * Form D XML index: https://www.sec.gov/Archives/edgar/data/<cik>/<accession-no-dashes>/<accession-with-dashes>-index.json
 *
 * The XML parser is deliberately regex-based but tolerant of:
 *   - namespace prefixes (`<ns1:totalAmountSold>`)
 *   - element attributes (`<entityName xml:lang="en">`)
 *   - HTML entity references (`&amp;`, `&lt;`, `&#39;`, `&#x27;`)
 * If you encounter Form D XML this can't parse, swap in `fast-xml-parser`
 * here — the rest of the importer is parser-agnostic.
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

export interface SecEdgarTarget {
  /** Org slug from data/entities/organizations.yaml */
  orgSlug: string;
  /** Display name for the org (used in funding_round.companyDisplayName) */
  orgName: string;
  /** SEC Central Index Key (CIK), zero-padded to 10 digits */
  cik: string;
}

export interface SecEdgarOptions extends HttpOptions {
  /** Limit on filings fetched per target (paginated APIs return many). */
  maxFilingsPerTarget?: number;
}

/** Shape of `https://data.sec.gov/submissions/CIK<n>.json`. Partial — only fields we use. */
interface SubmissionsResponse {
  cik: string;
  name: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      form?: string[];
      filingDate?: string[];
      primaryDocument?: string[];
    };
  };
}

/** One Form D filing summary, after filtering & dedup of submissions response. */
export interface FormDFiling {
  accessionNumber: string;
  filingDate: string;
  primaryDocument: string;
  /** Convenience: accession number with dashes stripped (used in URL paths). */
  accessionNoDashes: string;
}

/** Selected fields extracted from a Form D XML payload. */
export interface FormDExtract {
  /** Total amount raised in this offering, in USD. */
  totalAmountSold: number | null;
  /** Number of investors in this offering. */
  totalNumberAlreadyInvested: number | null;
  /** Issuer entity name from the Form D primary document. */
  issuerName: string | null;
  /** First sale date if present (YYYY-MM-DD). */
  firstSaleDate: string | null;
}

const DEFAULT_MAX_FILINGS = 50;

/** SEC requires CIK zero-padded to 10 digits in URL paths. */
export function padCik(cik: string): string {
  const digits = cik.replace(/\D/g, "");
  if (digits.length === 0) {
    throw new Error(`invalid CIK: "${cik}"`);
  }
  return digits.padStart(10, "0");
}

/**
 * Fetch all Form D filings for one CIK from the EDGAR submissions index.
 *
 * The submissions endpoint returns parallel arrays under filings.recent.
 * If the arrays disagree on length, take the shortest to avoid undefined
 * destructuring downstream.
 */
export async function fetchFormDFilings(
  cik: string,
  opts: SecEdgarOptions = {}
): Promise<FormDFiling[]> {
  const padded = padCik(cik);
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  const resp = await getFetch(opts)(url, {
    headers: { "User-Agent": getUserAgent(opts), Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`SEC EDGAR submissions HTTP ${resp.status} for CIK ${padded}`);
  }
  const data = (await resp.json()) as SubmissionsResponse;
  const recent = data.filings?.recent;
  if (!recent?.form || !recent.accessionNumber || !recent.filingDate) {
    return [];
  }

  const max = opts.maxFilingsPerTarget ?? DEFAULT_MAX_FILINGS;
  // Defensive: take the shortest parallel array to avoid out-of-bounds reads.
  const len = Math.min(
    recent.form.length,
    recent.accessionNumber.length,
    recent.filingDate.length
  );
  const out: FormDFiling[] = [];
  for (let i = 0; i < len && out.length < max; i++) {
    if (recent.form[i] !== "D" && recent.form[i] !== "D/A") continue;
    const accession = recent.accessionNumber[i];
    const filingDate = recent.filingDate[i];
    const primaryDoc = recent.primaryDocument?.[i] ?? "primary_doc.xml";
    out.push({
      accessionNumber: accession,
      filingDate,
      primaryDocument: primaryDoc,
      accessionNoDashes: accession.replace(/-/g, ""),
    });
  }
  return out;
}

/**
 * Build the canonical URL for a Form D primary document XML.
 * EDGAR archive URLs use the dashed accession number for the path
 * but a leading-zero-stripped CIK for the directory segment.
 *
 * If the CIK is all zeros after stripping, EDGAR has no entity at /data/0/
 * and we throw — better to fail fast than 404 on every filing.
 */
export function buildFormDUrl(
  cik: string,
  filing: FormDFiling
): string {
  const padded = padCik(cik);
  const dirCik = padded.replace(/^0+/, "");
  if (dirCik.length === 0) {
    throw new Error(`CIK is all zeros after stripping: "${cik}"`);
  }
  return `https://www.sec.gov/Archives/edgar/data/${dirCik}/${filing.accessionNoDashes}/${filing.primaryDocument}`;
}

/**
 * Decode the small set of XML entities Form D filings use in practice.
 * Form D doesn't carry CDATA blocks of significance in the fields we care
 * about, so this covers `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`,
 * `&#NN;` (decimal), and `&#xHH;` (hex).
 */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // keep last so &amp;lt; → &lt;, not <
}

/**
 * Parse a Form D XML payload. Form D has a fixed schema; we extract a small
 * fixed subset.
 *
 * Tolerates: optional namespace prefix (`ns1:`), optional attributes,
 * `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&#N;` `&#xH;` entities.
 *
 * Doesn't handle: CDATA sections, nested elements with the same name,
 * elements split across the buffer (Form D filings are single-file, small).
 */
export function parseFormDXml(xml: string): FormDExtract {
  const text = (tag: string): string | null => {
    // Optional namespace prefix, optional attributes, leaf element only.
    const re = new RegExp(
      `<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${tag}>`
    );
    const m = re.exec(xml);
    return m ? decodeXmlEntities(m[1].trim()) : null;
  };
  const num = (tag: string): number | null => {
    const v = text(tag);
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    totalAmountSold: num("totalAmountSold"),
    totalNumberAlreadyInvested: num("totalNumberAlreadyInvested"),
    issuerName: text("entityName"),
    firstSaleDate: text("dateOfFirstSale"),
  };
}

/** Fetch + parse the Form D XML for one filing. */
export async function fetchAndParseFormD(
  cik: string,
  filing: FormDFiling,
  opts: SecEdgarOptions = {}
): Promise<{ extract: FormDExtract; rawXml: string; sourceUrl: string }> {
  const sourceUrl = buildFormDUrl(cik, filing);
  const resp = await getFetch(opts)(sourceUrl, {
    headers: { "User-Agent": getUserAgent(opts) },
  });
  if (!resp.ok) {
    throw new Error(`SEC EDGAR Form D XML HTTP ${resp.status} for ${sourceUrl}`);
  }
  const rawXml = await resp.text();
  return { extract: parseFormDXml(rawXml), rawXml, sourceUrl };
}

/**
 * Build the proposal payload from one Form D extract.
 *
 * We prefer `extract.firstSaleDate` for the funding-round date when present
 * (more precise than the filing date, which can lag the actual sale by
 * weeks), and fall back to the filing date from the index. The issuer name
 * from the XML is stored in `notes` for evidence — the propose endpoint can
 * verify it matches the requested target before accepting the row.
 */
export function buildProposal(
  target: SecEdgarTarget,
  filing: FormDFiling,
  extract: FormDExtract,
  rawXml: string,
  sourceUrl: string
): EnrichmentProposal {
  const responseHash = createHash("sha256").update(rawXml).digest("hex");
  const date = extract.firstSaleDate || filing.filingDate;
  const investorNote = extract.totalNumberAlreadyInvested != null
    ? `${extract.totalNumberAlreadyInvested} investors per Form D`
    : null;
  const issuerNote = extract.issuerName
    ? `Issuer per Form D: ${extract.issuerName}`
    : null;
  const notes = [investorNote, issuerNote].filter(Boolean).join(" — ") || null;

  return {
    tier: "T1",
    source: `${T1_SOURCE_PREFIXES.secEdgar}${filing.accessionNumber}`,
    sourceUrl,
    responseHash,
    recordType: "funding-round",
    record: {
      // Form D doesn't tell us the round name directly — use filing date as fallback.
      name: `Form D filing ${filing.filingDate}`,
      date,
      raised: extract.totalAmountSold,
      // Form D explicitly labels these as "exempt offering" — instrument unknown
      // without external context. Leave null rather than guessing.
      instrument: null,
      source: sourceUrl,
      notes,
      companyDisplayName: target.orgName,
    },
    entityRefs: { organization: target.orgSlug },
  };
}

/**
 * End-to-end import for a single target — fetch index, fetch each Form D,
 * build proposals.
 *
 * Returns both the proposals AND a `failures` count for the caller —
 * silent partial success is dangerous for T1 importers (one target with
 * 49/50 broken filings shouldn't look like a successful import).
 */
export async function importTarget(
  target: SecEdgarTarget,
  opts: SecEdgarOptions = {}
): Promise<{ proposals: EnrichmentProposal[]; failures: number }> {
  const filings = await fetchFormDFilings(target.cik, opts);
  const proposals: EnrichmentProposal[] = [];
  let failures = 0;
  for (const filing of filings) {
    try {
      const { extract, rawXml, sourceUrl } = await fetchAndParseFormD(
        target.cik,
        filing,
        opts
      );
      proposals.push(
        buildProposal(target, filing, extract, rawXml, sourceUrl)
      );
    } catch (e) {
      failures++;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[sec-edgar] skipping ${target.orgSlug} filing ${filing.accessionNumber}: ${msg}`
      );
    }
  }
  return { proposals, failures };
}

/** CLI entry point — `crux tb sec-edgar [--submit]`. */
export async function cliMain(
  args: string[],
  options: { dryRun?: boolean } = {}
): Promise<CommandResult> {
  const submit = args.includes("--submit") && options.dryRun !== true;
  const targets = parseTargetsArg(args);
  if (targets.length === 0) {
    return {
      exitCode: 2,
      output:
        "No targets specified. Pass --target=slug:cik (repeatable) or --targets-file=path.json",
    };
  }

  const allProposals: EnrichmentProposal[] = [];
  let totalFailures = 0;
  for (const t of targets) {
    console.log(`[sec-edgar] fetching ${t.orgSlug} (CIK ${t.cik})...`);
    try {
      const { proposals, failures } = await importTarget(t);
      console.log(
        `[sec-edgar]   → ${proposals.length} proposals, ${failures} per-filing failures`
      );
      allProposals.push(...proposals);
      totalFailures += failures;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[sec-edgar] target ${t.orgSlug} failed entirely: ${msg}`);
      totalFailures++;
    }
  }

  const clientOpts: ProposeClientOptions = { submit };
  const results = await submitBatch(allProposals, clientOpts);
  printBatchSummary(results, "sec-edgar");
  if (totalFailures > 0) {
    console.warn(`[sec-edgar] ${totalFailures} per-filing/per-target failures`);
  }
  return { exitCode: 0, output: "" };
}

/**
 * Parse `--target=anthropic:0001234567` flags from argv.
 * Strict: rejects extra colons, empty parts, malformed CIK input.
 */
export function parseTargetsArg(args: readonly string[]): SecEdgarTarget[] {
  const out: SecEdgarTarget[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--target=")) continue;
    const value = arg.slice("--target=".length);
    const parts = value.split(":");
    if (parts.length !== 2) {
      throw new Error(`--target must be slug:cik (exactly one colon), got "${value}"`);
    }
    const [orgSlug, cik] = parts;
    if (!orgSlug || !cik) {
      throw new Error(`--target slug and cik must both be non-empty, got "${value}"`);
    }
    // Validate CIK is numeric early so that downstream URL building doesn't
    // produce a malformed request URL.
    if (!/^\d{1,10}$/.test(cik)) {
      throw new Error(`--target cik must be 1-10 digits, got "${cik}"`);
    }
    out.push({ orgSlug, orgName: orgSlug, cik });
  }
  return out;
}
