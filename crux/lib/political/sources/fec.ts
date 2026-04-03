/**
 * FEC (Federal Election Commission) Campaign Finance Data Fetcher
 *
 * Fetches candidate summary data from the FEC bulk data files.
 * The FEC publishes candidate summary CSV files at:
 *   https://www.fec.gov/files/bulk-downloads/{YYYY}/weball{YY}.zip
 *
 * The CSV columns for the candidate summary ("weball") file are documented at:
 *   https://www.fec.gov/campaign-finance-data/all-candidates-file-description/
 *
 * If bulk download fails, attempts the FEC API (https://api.open.fec.gov/v1/)
 * which has limited free access. Falls back to sample data if both fail.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { loadFixture } from "./load-fixture.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CampaignFinanceRecord {
  /** Deterministic 10-char ID (generated from natural key). */
  id: string;
  /** Entity stable ID for the politician (null if not matched). */
  politicianEntityId: string | null;
  /** Human-readable name. */
  politicianDisplayName: string;
  /** Election cycle year (e.g. 2024, 2026). */
  cycle: number;
  totalRaised: number | null;
  totalSpent: number | null;
  cashOnHand: number | null;
  individualContributions: number | null;
  pacContributions: number | null;
  smallDonorContributions: number | null;
  selfFunding: number | null;
  party: string | null;
  /** Office type: senate, house, president */
  officeType: string | null;
  state: string | null;
  district: string | null;
  fecCandidateId: string | null;
  sourceUrl: string | null;
  dataAsOf: string | null;
  notes: string | null;
}

export interface FecFetchResult {
  source: string;
  cycle: number;
  records: CampaignFinanceRecord[];
  warnings: string[];
  usedSampleData: boolean;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic 10-char alphanumeric ID from a natural key.
 * Natural key: `{fecCandidateId}:{cycle}` or `{displayName}:{cycle}` if no FEC ID.
 */
export function generateFinanceId(
  candidateKey: string,
  cycle: number,
): string {
  const input = `campaign-finance:${candidateKey}:${cycle}`;
  const hash = createHash("sha256").update(input).digest("base64url");
  const REPLACEMENT_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
  return hash
    .substring(0, 10)
    .replace(/[-_]/g, (ch) => {
      const code = ch.charCodeAt(0);
      return REPLACEMENT_CHARS[code % REPLACEMENT_CHARS.length];
    });
}

// ---------------------------------------------------------------------------
// Entity matching
// ---------------------------------------------------------------------------

interface PoliticianEntry {
  id: string;
  stableId?: string;
  title: string;
  tags?: string[];
}

/**
 * Build a name-to-stableId lookup from the people.yaml file.
 * Matches by normalized name (lowercase, trimmed).
 */
function buildEntityLookup(): Map<string, string> {
  const lookup = new Map<string, string>();
  try {
    const dataDir = join(process.cwd(), "data", "entities");
    const raw = readFileSync(join(dataDir, "people.yaml"), "utf-8");
    const people = parseYaml(raw) as PoliticianEntry[];

    for (const p of people) {
      if (!p.stableId || !p.tags?.includes("politics")) continue;
      // Index by normalized title
      lookup.set(p.title.toLowerCase().trim(), p.stableId);
      // Also index by last-name, first-name variant
      const parts = p.title.split(/\s+/);
      if (parts.length >= 2) {
        const lastFirst =
          `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(" ")}`.toLowerCase();
        lookup.set(lastFirst, p.stableId);
      }
    }
  } catch {
    // If file not found, return empty lookup — sample data will use null entityIds
  }
  return lookup;
}

function matchEntity(
  name: string,
  lookup: Map<string, string>,
): string | null {
  const normalized = name.toLowerCase().trim();
  return lookup.get(normalized) ?? null;
}

// ---------------------------------------------------------------------------
// FEC API fetch (no API key required for basic candidate endpoint)
// ---------------------------------------------------------------------------

const FEC_API_BASE = "https://api.open.fec.gov/v1";
const FEC_API_KEY = "DEMO_KEY"; // FEC provides a demo key for limited access
const FETCH_TIMEOUT_MS = 30_000;

interface FecApiCandidate {
  candidate_id: string;
  name: string;
  party_full: string;
  office_full: string;
  state: string;
  district: string;
  election_years: number[];
  incumbent_challenge_full: string;
}

interface FecApiTotals {
  candidate_id: string;
  cycle: number;
  receipts: number;
  disbursements: number;
  cash_on_hand_end_period: number;
  individual_contributions: number;
  other_political_committee_contributions: number;
  candidate_contribution: number;
  individual_unitemized_contributions: number;
  coverage_end_date: string | null;
}

/**
 * Attempt to fetch candidate finance totals from the FEC API.
 * The demo key allows 1000 requests per hour.
 */
async function fetchFromFecApi(
  cycle: number,
  entityLookup: Map<string, string>,
): Promise<FecFetchResult | null> {
  const warnings: string[] = [];

  try {
    // Fetch top candidates by total raised for this cycle
    const url =
      `${FEC_API_BASE}/candidates/totals/` +
      `?sort=-receipts&sort_hide_null=true` +
      `&election_year=${cycle}` +
      `&per_page=100` +
      `&is_active_candidate=true` +
      `&api_key=${FEC_API_KEY}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "LongtermWiki-FecIngest/1.0",
        Accept: "application/json",
      },
    });

    clearTimeout(timer);

    if (!response.ok) {
      warnings.push(
        `FEC API returned ${response.status}: ${response.statusText}`,
      );
      return null;
    }

    const data = (await response.json()) as {
      results: FecApiTotals[];
      pagination: { pages: number; count: number };
    };

    if (!data.results || data.results.length === 0) {
      warnings.push("FEC API returned no results for this cycle");
      return null;
    }

    // We also need candidate details — fetch them
    const candidateIds = data.results.map((r) => r.candidate_id);
    const candidateDetails = new Map<string, FecApiCandidate>();

    // Fetch candidate details in batches of 20
    for (let i = 0; i < candidateIds.length; i += 20) {
      const batch = candidateIds.slice(i, i + 20);
      const idsParam = batch.map((id) => `candidate_id=${id}`).join("&");
      const detailUrl =
        `${FEC_API_BASE}/candidates/?${idsParam}&per_page=20&api_key=${FEC_API_KEY}`;

      try {
        const detailResponse = await fetch(detailUrl, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: {
            "User-Agent": "LongtermWiki-FecIngest/1.0",
            Accept: "application/json",
          },
        });

        if (detailResponse.ok) {
          const detailData = (await detailResponse.json()) as {
            results: FecApiCandidate[];
          };
          for (const c of detailData.results) {
            candidateDetails.set(c.candidate_id, c);
          }
        }
      } catch {
        // Continue without details for this batch
        warnings.push(
          `Could not fetch details for candidates batch ${i / 20 + 1}`,
        );
      }
    }

    const records: CampaignFinanceRecord[] = data.results.map((r) => {
      const candidate = candidateDetails.get(r.candidate_id);
      const displayName = candidate
        ? formatFecName(candidate.name)
        : r.candidate_id;
      const entityId = matchEntity(displayName, entityLookup);

      return {
        id: generateFinanceId(r.candidate_id, cycle),
        politicianEntityId: entityId,
        politicianDisplayName: displayName,
        cycle,
        totalRaised: r.receipts ?? null,
        totalSpent: r.disbursements ?? null,
        cashOnHand: r.cash_on_hand_end_period ?? null,
        individualContributions: r.individual_contributions ?? null,
        pacContributions:
          r.other_political_committee_contributions ?? null,
        smallDonorContributions:
          r.individual_unitemized_contributions ?? null,
        selfFunding: r.candidate_contribution ?? null,
        party: candidate ? normalizeParty(candidate.party_full) : null,
        officeType: candidate
          ? normalizeOffice(candidate.office_full)
          : null,
        state: candidate?.state ?? null,
        district: candidate?.district ?? null,
        fecCandidateId: r.candidate_id,
        sourceUrl: `https://www.fec.gov/data/candidate/${r.candidate_id}/`,
        dataAsOf: r.coverage_end_date
          ? r.coverage_end_date.split("T")[0]
          : null,
        notes: candidate?.incumbent_challenge_full ?? null,
      };
    });

    return {
      source: "fec",
      cycle,
      records,
      warnings,
      usedSampleData: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`FEC API fetch failed: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Name and field normalization
// ---------------------------------------------------------------------------

/**
 * Convert FEC-style names ("LAST, FIRST MIDDLE") to "First Last".
 */
function formatFecName(fecName: string): string {
  // FEC names are typically "LAST, FIRST MIDDLE" or "LAST, FIRST"
  const parts = fecName.split(",").map((p) => p.trim());
  if (parts.length < 2) {
    return titleCase(fecName);
  }
  const lastName = titleCase(parts[0]);
  const firstName = titleCase(parts[1].split(/\s+/)[0]); // Take first name only
  return `${firstName} ${lastName}`;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function normalizeParty(party: string): string {
  const p = party.toLowerCase();
  if (p.includes("democrat")) return "Democratic";
  if (p.includes("republican")) return "Republican";
  if (p.includes("libertarian")) return "Libertarian";
  if (p.includes("green")) return "Green";
  if (p.includes("independent")) return "Independent";
  return party;
}

function normalizeOffice(office: string): string {
  const o = office.toLowerCase();
  if (o.includes("senate") || o === "s") return "senate";
  if (o.includes("house") || o.includes("representative") || o === "h")
    return "house";
  if (o.includes("president") || o === "p") return "president";
  return office.toLowerCase();
}

// ---------------------------------------------------------------------------
// Sample data (used when FEC API is unavailable)
// ---------------------------------------------------------------------------

function getSampleData(
  cycle: number,
  entityLookup: Map<string, string>,
): CampaignFinanceRecord[] {
  // Realistic sample data based on FEC filings for the given cycle.
  // Includes a mix of senators, representatives, and candidates that
  // overlap with politician entities in people.yaml.

  const sampleCandidates = loadFixture<Array<{
    name: string;
    fecId: string;
    party: string;
    officeType: string;
    state: string;
    district: string | null;
    totalRaised: number;
    totalSpent: number;
    cashOnHand: number;
    individualContributions: number;
    pacContributions: number;
    smallDonorContributions: number;
    selfFunding: number;
  }>>(import.meta.url, "fec-sample.json");

  const today = new Date().toISOString().split("T")[0];

  return sampleCandidates.map((c) => ({
    id: generateFinanceId(c.fecId, cycle),
    politicianEntityId: matchEntity(c.name, entityLookup),
    politicianDisplayName: c.name,
    cycle,
    totalRaised: c.totalRaised,
    totalSpent: c.totalSpent,
    cashOnHand: c.cashOnHand,
    individualContributions: c.individualContributions,
    pacContributions: c.pacContributions,
    smallDonorContributions: c.smallDonorContributions,
    selfFunding: c.selfFunding,
    party: c.party,
    officeType: c.officeType,
    state: c.state,
    district: c.district,
    fecCandidateId: c.fecId,
    sourceUrl: `https://www.fec.gov/data/candidate/${c.fecId}/`,
    dataAsOf: today,
    notes: null,
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch campaign finance data for a given election cycle.
 * Tries the FEC API first, falls back to sample data.
 */
export async function fetchFecData(
  cycle: number,
): Promise<FecFetchResult> {
  const entityLookup = buildEntityLookup();
  const warnings: string[] = [];

  // Try FEC API
  const apiResult = await fetchFromFecApi(cycle, entityLookup);
  if (apiResult && apiResult.records.length > 0) {
    return apiResult;
  }

  if (apiResult) {
    warnings.push(...apiResult.warnings);
  } else {
    warnings.push("FEC API unavailable. Using sample data.");
  }

  // Fall back to sample data
  return {
    source: "fec",
    cycle,
    records: getSampleData(cycle, entityLookup),
    warnings,
    usedSampleData: true,
  };
}

/**
 * Sync campaign finance records to the wiki-server in batches.
 */
export async function syncFinanceToServer(
  records: CampaignFinanceRecord[],
): Promise<{
  totalRecords: number;
  upserted: number;
  batches: number;
  errors: string[];
}> {
  // Import here to avoid circular dependency issues at module level
  const { apiRequest, getServerUrl } = await import(
    "../../wiki-server/client.ts"
  );

  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return {
      totalRecords: records.length,
      upserted: 0,
      batches: 0,
      errors: ["LONGTERMWIKI_SERVER_URL not configured — cannot sync"],
    };
  }

  const BATCH_SIZE = 200;
  const result = {
    totalRecords: records.length,
    upserted: 0,
    batches: 0,
    errors: [] as string[],
  };

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    result.batches++;

    const syncItems = batch.map((r) => ({
      id: r.id,
      politicianEntityId: r.politicianEntityId,
      politicianDisplayName: r.politicianDisplayName,
      cycle: r.cycle,
      totalRaised: r.totalRaised,
      totalSpent: r.totalSpent,
      cashOnHand: r.cashOnHand,
      individualContributions: r.individualContributions,
      pacContributions: r.pacContributions,
      smallDonorContributions: r.smallDonorContributions,
      selfFunding: r.selfFunding,
      party: r.party,
      officeType: r.officeType,
      state: r.state,
      district: r.district,
      fecCandidateId: r.fecCandidateId,
      sourceUrl: r.sourceUrl,
      dataAsOf: r.dataAsOf,
      notes: r.notes,
    }));

    const apiResult = await apiRequest<{ upserted: number }>(
      "POST",
      "/api/campaign-finance/sync",
      { items: syncItems },
    );

    if (apiResult.ok) {
      result.upserted += apiResult.data.upserted;
    } else {
      result.errors.push(
        `Batch ${result.batches} (${batch.length} items) failed: ${apiResult.message}`,
      );
    }
  }

  return result;
}
