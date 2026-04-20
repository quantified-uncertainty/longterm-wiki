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
 * SEC requires a User-Agent identifying the requester. We send
 * "longterm-wiki <ozzie@quantifieduncertainty.org>".
 */

import { createHash } from "crypto";
import {
  submitBatch,
  printBatchSummary,
  type ProposeClientOptions,
} from "./propose-client.ts";
import type { EnrichmentProposal } from "./types.ts";

const USER_AGENT = "longterm-wiki <ozzie@quantifieduncertainty.org>";

export interface SecEdgarTarget {
  /** Org slug from data/entities/organizations.yaml */
  orgSlug: string;
  /** Display name for the org (used in funding_round.companyDisplayName) */
  orgName: string;
  /** SEC Central Index Key (CIK), zero-padded to 10 digits */
  cik: string;
}

export interface SecEdgarOptions {
  /** Override the global fetch — used by tests to inject responses. */
  fetchImpl?: typeof fetch;
  /** Override the User-Agent — keep default in production. */
  userAgent?: string;
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
  /** Filing date (YYYY-MM-DD). */
  filingDate: string;
  /** Issuer entity name from the Form D primary document. */
  issuerName: string;
  /** First sale date if present (YYYY-MM-DD). */
  firstSaleDate: string | null;
}

const DEFAULT_MAX_FILINGS = 50;

function getFetch(opts: SecEdgarOptions): typeof fetch {
  return opts.fetchImpl ?? globalThis.fetch;
}

function getUserAgent(opts: SecEdgarOptions): string {
  return opts.userAgent ?? USER_AGENT;
}

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
 * The submissions endpoint returns parallel arrays under filings.recent —
 * we zip them, filter to Form D, and dedup.
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
  const out: FormDFiling[] = [];
  for (let i = 0; i < recent.form.length && out.length < max; i++) {
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
 * but the un-dashed form for the directory.
 */
export function buildFormDUrl(
  cik: string,
  filing: FormDFiling
): string {
  const padded = padCik(cik);
  // EDGAR strips leading zeros for the directory segment
  const dirCik = String(parseInt(padded, 10));
  return `https://www.sec.gov/Archives/edgar/data/${dirCik}/${filing.accessionNoDashes}/${filing.primaryDocument}`;
}

/**
 * Parse a Form D XML payload. Form D has a fixed schema; we extract a small
 * fixed subset. Tag names are case-sensitive in EDGAR XML.
 *
 * This intentionally uses regex rather than a full XML parser — Form D
 * payloads are small and the fields we want are leaf elements with no
 * attribute interactions or nested duplicates.
 */
export function parseFormDXml(xml: string): FormDExtract {
  const text = (tag: string): string | null => {
    const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
    const m = re.exec(xml);
    return m ? m[1].trim() : null;
  };
  const num = (tag: string): number | null => {
    const v = text(tag);
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const filingDate = text("dateOfFirstSale") ?? text("filingDate") ?? "";
  return {
    totalAmountSold: num("totalAmountSold"),
    totalNumberAlreadyInvested: num("totalNumberAlreadyInvested"),
    filingDate: filingDate || "",
    issuerName: text("entityName") ?? "",
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

/** Build the proposal payload from one Form D extract. */
export function buildProposal(
  target: SecEdgarTarget,
  filing: FormDFiling,
  extract: FormDExtract,
  rawXml: string,
  sourceUrl: string
): EnrichmentProposal {
  const responseHash = createHash("sha256").update(rawXml).digest("hex");
  return {
    tier: "T1",
    source: `sec-edgar:${filing.accessionNumber}`,
    sourceUrl,
    responseHash,
    recordType: "funding-round",
    record: {
      // Form D doesn't tell us the round name directly — use filing date as fallback.
      name: `Form D filing ${filing.filingDate}`,
      date: filing.filingDate,
      raised: extract.totalAmountSold,
      // Form D explicitly labels these as "exempt offering" — instrument unknown
      // without external context. Leave null rather than guessing.
      instrument: null,
      source: sourceUrl,
      notes: extract.totalNumberAlreadyInvested != null
        ? `${extract.totalNumberAlreadyInvested} investors per Form D`
        : null,
      companyDisplayName: target.orgName,
    },
    entityRefs: { organization: target.orgSlug },
  };
}

/**
 * End-to-end import for a single target — fetch index, fetch each Form D,
 * build proposals. Errors on individual filings are logged + skipped.
 */
export async function importTarget(
  target: SecEdgarTarget,
  opts: SecEdgarOptions = {}
): Promise<EnrichmentProposal[]> {
  const filings = await fetchFormDFilings(target.cik, opts);
  const proposals: EnrichmentProposal[] = [];
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
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[sec-edgar] skipping ${target.orgSlug} filing ${filing.accessionNumber}: ${msg}`
      );
    }
  }
  return proposals;
}

/** CLI entry point — `crux tb sec-edgar [--submit]`. */
export async function cliMain(
  args: string[],
  options: { dryRun?: boolean } = {}
): Promise<{ exitCode: number; output: string }> {
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
  for (const t of targets) {
    console.log(`[sec-edgar] fetching ${t.orgSlug} (CIK ${t.cik})...`);
    const proposals = await importTarget(t);
    console.log(`[sec-edgar]   → ${proposals.length} Form D proposals`);
    allProposals.push(...proposals);
  }

  const clientOpts: ProposeClientOptions = { submit };
  const results = await submitBatch(allProposals, clientOpts);
  printBatchSummary(results, "sec-edgar");
  return { exitCode: 0, output: "" };
}

/** Parse `--target=anthropic:0001234567` flags from argv. */
export function parseTargetsArg(args: readonly string[]): SecEdgarTarget[] {
  const out: SecEdgarTarget[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--target=")) continue;
    const value = arg.slice("--target=".length);
    const [orgSlug, cik] = value.split(":");
    if (!orgSlug || !cik) {
      throw new Error(`--target must be slug:cik, got "${value}"`);
    }
    out.push({ orgSlug, orgName: orgSlug, cik });
  }
  return out;
}
