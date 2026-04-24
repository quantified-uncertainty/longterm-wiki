/**
 * Wikidata SPARQL → organization-fact importer (T1, QUA-666).
 *
 * Fetches structured facts for an org by Q-number from the Wikidata SPARQL
 * endpoint. Each SPARQL binding yields one or more `organization-fact`
 * proposals (property, value, valueType) routed through the propose endpoint.
 *
 * This is STRUCTURALLY DIFFERENT from `crux fb wikidata-enrich` (which writes
 * FactBase YAML for entity-level facts). That command pre-dates the proposal
 * pipeline and writes directly to YAML. This one emits EnrichmentProposal
 * payloads for the QUA-632 propose endpoint, so facts land in TableBase with
 * proper evidence + verdict rows.
 *
 * API: https://query.wikidata.org/sparql
 *   Query via `?query=<url-encoded SPARQL>` GET request.
 *   Accept: application/sparql-results+json
 *   Rate limit: ~1 req/sec is courteous (WDQS enforces 60/min hard cap).
 *
 * Property set mirrors the existing wikidata-enrich command for consistency:
 *   P571 foundedDate, P159 HQ, P17 country, P856 website, P169 CEO,
 *   P1128 employees, P2139 revenue, P749 parentOrg, P112 founder,
 *   P1454 legalForm.
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
 * QID regex — `Q` followed by 1+ digits. Wikidata item IDs never carry
 * leading zeros, so `Q0...` is explicitly rejected.
 */
const QID_RE = /^Q[1-9]\d*$/;

export interface WikidataTarget {
  /** Org slug from data/entities/organizations.yaml */
  orgSlug: string;
  /** Display name for the org (preserved into notes) */
  orgName: string;
  /** Wikidata item ID (e.g., "Q108542504" for Anthropic) */
  qid: string;
}

export interface WikidataOptions extends HttpOptions {
  /** SPARQL endpoint override (tests point this at a mock URL). */
  sparqlEndpoint?: string;
}

/**
 * One SPARQL binding → one FactBase property. Each binding produces one
 * proposal; bindings that come back null are silently skipped.
 *
 * `valueType` is how the propose endpoint decides how to store the value:
 *   - "date" (YYYY-MM or YYYY-MM-DD)
 *   - "string" (labels, free text)
 *   - "number" (counts, amounts)
 *   - "url"    (website URL)
 */
export interface WikidataPropertyBinding {
  /** Wikidata property ID, e.g. "P571" — used in `source` suffix. */
  wikidataProperty: string;
  /** SPARQL variable name returned in the binding. */
  sparqlVariable: string;
  /** Target record property, e.g. "founded-date". */
  property: string;
  /** Expected value type for the target property. */
  valueType: "date" | "string" | "number" | "url";
  /** Optional value extractor — defaults to returning the raw SPARQL value. */
  extractValue?: (raw: string) => string | number | null;
}

/**
 * Wikidata property set — kept small & intentional. Matches the fact set
 * already in use by `crux fb wikidata-enrich` so the two pipelines produce
 * comparable facts when run against the same org.
 */
export const WIKIDATA_PROPERTY_BINDINGS: readonly WikidataPropertyBinding[] = [
  {
    wikidataProperty: "P571",
    sparqlVariable: "foundedDate",
    property: "founded-date",
    valueType: "date",
    // Wikidata dates are like "2015-12-11T00:00:00Z" — truncate to YYYY-MM.
    extractValue: (raw: string) => {
      const m = /^(\d{4}-\d{2})/.exec(raw);
      return m ? m[1] : null;
    },
  },
  {
    wikidataProperty: "P159",
    sparqlVariable: "headquartersLabel",
    property: "headquarters",
    valueType: "string",
  },
  {
    wikidataProperty: "P17",
    sparqlVariable: "countryLabel",
    property: "country",
    valueType: "string",
  },
  {
    wikidataProperty: "P856",
    sparqlVariable: "website",
    property: "website",
    valueType: "url",
  },
  {
    wikidataProperty: "P169",
    sparqlVariable: "ceoLabel",
    property: "ceo-name",
    valueType: "string",
  },
  {
    wikidataProperty: "P1128",
    sparqlVariable: "employees",
    property: "headcount",
    valueType: "number",
    extractValue: (raw: string) => {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    },
  },
  {
    wikidataProperty: "P2139",
    sparqlVariable: "revenue",
    property: "revenue",
    valueType: "number",
    extractValue: (raw: string) => {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    },
  },
  {
    wikidataProperty: "P749",
    sparqlVariable: "parentOrgLabel",
    property: "parent-organization",
    valueType: "string",
  },
  {
    wikidataProperty: "P112",
    sparqlVariable: "founderLabel",
    property: "founded-by-name",
    valueType: "string",
  },
  {
    wikidataProperty: "P1454",
    sparqlVariable: "legalFormLabel",
    property: "legal-structure",
    valueType: "string",
  },
] as const;

/** Minimal SPARQL binding shape. */
export interface SparqlBinding {
  [key: string]: { type: string; value: string; datatype?: string } | undefined;
}

export interface SparqlResults {
  results: { bindings: SparqlBinding[] };
}

const DEFAULT_SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

/**
 * Build the SPARQL query covering all bindings. Uses OPTIONAL for every
 * clause so a missing triple yields a null binding rather than an empty
 * overall result set.
 */
export function buildSparqlQuery(qid: string): string {
  assertValidQid(qid);
  const optionals = WIKIDATA_PROPERTY_BINDINGS.map((b) => {
    // `?xLabel` variables come from the wikibase:label service, which binds
    // them from `?x` triples automatically. For website + date we want the
    // raw bound value instead.
    const isLabel = b.sparqlVariable.endsWith("Label");
    const baseVar = isLabel
      ? b.sparqlVariable.slice(0, -"Label".length)
      : b.sparqlVariable;
    return `  OPTIONAL { wd:${qid} wdt:${b.wikidataProperty} ?${baseVar}. }`;
  }).join("\n");
  // Select the full variable list with label suffix where needed.
  const selectVars = WIKIDATA_PROPERTY_BINDINGS.map((b) => `?${b.sparqlVariable}`).join(" ");
  return `SELECT ${selectVars} WHERE {
${optionals}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 1`;
}

/**
 * Validate a Wikidata Q-number. Rejects empty, non-Q-prefixed, leading-zero,
 * or non-numeric QIDs. Throws — not returns null — because invalid QIDs
 * would produce malformed SPARQL or trivially-empty results.
 */
export function assertValidQid(qid: string): void {
  if (!QID_RE.test(qid)) {
    throw new Error(
      `invalid Wikidata QID: "${qid}" (must match /^Q[1-9]\\d*$/)`
    );
  }
}

/**
 * Fetch SPARQL results for one QID. Throws on non-2xx.
 * Returns the raw bindings (array; usually 1 element since LIMIT 1).
 */
export async function fetchSparqlBindings(
  qid: string,
  opts: WikidataOptions = {}
): Promise<{ bindings: SparqlBinding[]; rawResponse: string; sourceUrl: string }> {
  const sparql = buildSparqlQuery(qid);
  const endpoint = opts.sparqlEndpoint ?? DEFAULT_SPARQL_ENDPOINT;
  const url = `${endpoint}?query=${encodeURIComponent(sparql)}`;
  const resp = await getFetch(opts)(url, {
    headers: {
      "User-Agent": getUserAgent(opts),
      Accept: "application/sparql-results+json",
    },
  });
  if (!resp.ok) {
    throw new Error(`Wikidata SPARQL HTTP ${resp.status} for ${qid}`);
  }
  const rawResponse = await resp.text();
  let data: SparqlResults;
  try {
    data = JSON.parse(rawResponse) as SparqlResults;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Wikidata SPARQL response is not valid JSON: ${msg}`);
  }
  const bindings = data?.results?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error(`Wikidata SPARQL response missing results.bindings`);
  }
  // The canonical wiki page URL — used as evidence source, NOT the raw
  // SPARQL URL (which is huge and caching-hostile).
  const sourceUrl = `https://www.wikidata.org/wiki/${qid}`;
  return { bindings, rawResponse, sourceUrl };
}

/**
 * Extract one typed value from a single binding row.
 * Returns null for missing/invalid values so the caller can skip without
 * emitting a broken proposal.
 */
export function extractBindingValue(
  binding: SparqlBinding,
  propBinding: WikidataPropertyBinding
): string | number | null {
  const raw = binding[propBinding.sparqlVariable]?.value;
  if (raw == null || raw === "") return null;
  if (propBinding.extractValue) return propBinding.extractValue(raw);
  return raw;
}

/**
 * Build per-property proposals from SPARQL result bindings.
 *
 * One binding row can yield up to N proposals (one per property that's
 * present and passes extraction). If the query returned zero binding rows,
 * returns an empty array.
 */
export function buildProposals(
  target: WikidataTarget,
  bindings: readonly SparqlBinding[],
  rawResponse: string,
  sourceUrl: string
): EnrichmentProposal[] {
  if (bindings.length === 0) return [];
  const row = bindings[0]; // LIMIT 1 ⇒ at most one row
  const proposals: EnrichmentProposal[] = [];
  for (const b of WIKIDATA_PROPERTY_BINDINGS) {
    const value = extractBindingValue(row, b);
    if (value === null) continue;
    // Hash the (qid, property, value) triple so retries produce identical
    // response hashes even if the SPARQL response JSON ordering shifts.
    const canonical = JSON.stringify({
      qid: target.qid,
      wikidataProperty: b.wikidataProperty,
      value,
    });
    const responseHash = createHash("sha256").update(canonical).digest("hex");
    proposals.push({
      tier: "T1",
      source: `${T1_SOURCE_PREFIXES.wikidata}${target.qid}:${b.wikidataProperty}`,
      sourceUrl,
      responseHash,
      recordType: "organization-fact",
      record: {
        property: b.property,
        value,
        valueType: b.valueType,
        source: sourceUrl,
        notes: `From Wikidata ${target.qid} (${b.wikidataProperty}); SPARQL response SHA-256: ${createHash("sha256").update(rawResponse).digest("hex").slice(0, 12)}`,
        orgDisplayName: target.orgName,
      },
      entityRefs: { organization: target.orgSlug },
    });
  }
  return proposals;
}

/** End-to-end import for one target. */
export async function importTarget(
  target: WikidataTarget,
  opts: WikidataOptions = {}
): Promise<{ proposals: EnrichmentProposal[] }> {
  const { bindings, rawResponse, sourceUrl } = await fetchSparqlBindings(
    target.qid,
    opts
  );
  return { proposals: buildProposals(target, bindings, rawResponse, sourceUrl) };
}

/** CLI entry — `crux tb wikidata --target=slug:Q12345 [--submit]`. */
export async function cliMain(args: string[]): Promise<CommandResult> {
  const submit = args.includes("--submit");
  const targets = parseTargetsArg(args);
  if (targets.length === 0) {
    return {
      exitCode: 2,
      output: "No targets specified. Pass --target=slug:Q12345 (repeatable)",
    };
  }
  const all: EnrichmentProposal[] = [];
  let totalFailures = 0;
  for (const t of targets) {
    console.log(`[wikidata] fetching ${t.orgSlug} (${t.qid})...`);
    try {
      const { proposals } = await importTarget(t);
      console.log(`[wikidata]   → ${proposals.length} fact proposals`);
      all.push(...proposals);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[wikidata] target ${t.orgSlug} failed: ${msg}`);
      totalFailures++;
    }
  }
  const clientOpts: ProposeClientOptions = { submit };
  const results = await submitBatch(all, clientOpts);
  printBatchSummary(results, "wikidata");
  if (totalFailures > 0) {
    console.warn(`[wikidata] ${totalFailures} target failures`);
  }
  return { exitCode: 0, output: "" };
}

/**
 * Parse `--target=slug:Qnumber`. Strict on colons (exactly one) and QID
 * format to guard against malformed SPARQL.
 */
export function parseTargetsArg(args: readonly string[]): WikidataTarget[] {
  const out: WikidataTarget[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--target=")) continue;
    const value = arg.slice("--target=".length);
    const parts = value.split(":");
    if (parts.length !== 2) {
      throw new Error(
        `--target must be slug:Qnumber (exactly one colon), got "${value}"`
      );
    }
    const [orgSlug, qid] = parts;
    if (!orgSlug || !qid) {
      throw new Error(`--target slug and qid must both be non-empty, got "${value}"`);
    }
    assertValidQid(qid);
    out.push({ orgSlug, orgName: orgSlug, qid });
  }
  return out;
}
