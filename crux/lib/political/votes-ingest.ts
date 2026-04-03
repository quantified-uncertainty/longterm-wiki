/**
 * Congressional Voting Records Ingest Module
 *
 * Builds vote records for tracked legislation and syncs to the
 * political_votes PG table via the wiki-server API.
 *
 * Includes:
 *   - Sample vote data for tracked US federal legislation
 *   - Congress.gov API fetcher stub (basic endpoints require no API key)
 *   - Batch sync to wiki-server
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  apiRequest,
  getServerUrl,
  type ApiResult,
} from "../wiki-server/client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single vote record ready for wiki-server sync. */
export interface VoteRecord {
  /** Deterministic 10-char ID (generated from natural key). */
  id: string;
  /** Entity stable ID for the politician. */
  politicianEntityId: string | null;
  /** Human-readable name. */
  politicianDisplayName: string;
  /** Legislation entity slug in responses.yaml. */
  legislationEntityId: string;
  /** Title of the legislation. */
  legislationTitle: string;
  /** Vote: yea, nay, abstain, not_voting, present. */
  vote: "yea" | "nay" | "abstain" | "not_voting" | "present";
  /** Date of the vote (YYYY-MM-DD). */
  voteDate: string | null;
  /** Chamber: senate, house, state_senate, state_assembly. */
  chamber: string;
  /** Roll call number. */
  rollCallNumber: number | null;
  /** Congress number (e.g. 118). */
  congressNumber: number | null;
  /** Session (1 or 2). */
  session: number | null;
  /** Source URL. */
  sourceUrl: string | null;
  /** Notes. */
  notes: string | null;
}

/** Result from building vote data. */
export interface VoteIngestResult {
  records: VoteRecord[];
  warnings: string[];
  legislationCount: number;
  politicianCount: number;
}

/** Congress.gov API vote response (stub types). */
interface CongressGovVote {
  member: {
    bioguideId: string;
    fullName: string;
    party: string;
    state: string;
  };
  votePosition: string;
}

interface CongressGovRollCall {
  rollNumber: number;
  congress: number;
  session: number;
  chamber: string;
  date: string;
  question: string;
  votes: CongressGovVote[];
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic 10-char alphanumeric ID from a natural key.
 *
 * The natural key for a political vote is:
 *   `{legislationId}:{politicianName}:{rollCallNumber}:{congressNumber}`
 */
export function generateVoteId(
  legislationId: string,
  politicianName: string,
  rollCallNumber: number | null,
  congressNumber: number | null,
): string {
  const input = `political-vote:${legislationId}:${politicianName}:${rollCallNumber ?? 0}:${congressNumber ?? 0}`;
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
// Congress.gov API fetcher (stub)
// ---------------------------------------------------------------------------

const CONGRESS_API_BASE = "https://api.congress.gov/v3";
const CONGRESS_API_TIMEOUT = 30_000;

/**
 * Fetch roll call votes from Congress.gov API.
 *
 * The Congress.gov API (api.congress.gov) provides roll call vote data.
 * Basic endpoints can be accessed with an API key from api.congress.gov.
 * The key should be passed as a query parameter: ?api_key=YOUR_KEY
 *
 * This is a stub that returns null — real implementation requires an API key
 * obtainable free from https://api.congress.gov/sign-up/
 */
export async function fetchCongressGovRollCall(
  congress: number,
  chamber: "senate" | "house",
  rollCallNumber: number,
  apiKey?: string,
): Promise<CongressGovRollCall | null> {
  if (!apiKey) {
    return null;
  }

  const chamberPath = chamber === "senate" ? "senate" : "house";
  const url = `${CONGRESS_API_BASE}/roll-call-vote/${congress}/${chamberPath}/${rollCallNumber}?api_key=${apiKey}&format=json`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(CONGRESS_API_TIMEOUT),
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data as CongressGovRollCall;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface LegislationEntity {
  id: string;
  stableId?: string;
  title: string;
  billNumber?: string;
  jurisdiction?: string;
  scope?: string;
  policyStatus?: string;
}

interface PoliticianEntity {
  id: string;
  stableId?: string;
  title: string;
  tags?: string[];
  description?: string;
}

function loadLegislation(dataDir: string): LegislationEntity[] {
  const responsesPath = join(dataDir, "entities", "responses.yaml");
  const raw = readFileSync(responsesPath, "utf-8");
  const all = parseYaml(raw) as LegislationEntity[];
  // Filter to legislation with bill numbers (most likely to have roll call votes)
  return all.filter((e) => e.billNumber);
}

function loadPoliticians(dataDir: string): PoliticianEntity[] {
  const peoplePath = join(dataDir, "entities", "people.yaml");
  const raw = readFileSync(peoplePath, "utf-8");
  const all = parseYaml(raw) as PoliticianEntity[];
  return all.filter(
    (p) => p.tags && p.tags.includes("politics") && p.stableId
  );
}

// ---------------------------------------------------------------------------
// Sample vote data builder
// ---------------------------------------------------------------------------

/**
 * Categorize a politician's likely chamber from their description.
 */
function inferChamber(description: string): "senate" | "house" | null {
  const lower = description.toLowerCase();
  if (lower.includes("senator") || lower.includes("u.s. senator")) return "senate";
  if (lower.includes("representative") || lower.includes("u.s. representative")) return "house";
  if (lower.includes("state senator")) return "senate";
  if (lower.includes("assemblymember") || lower.includes("assembly member")) return "house";
  return null;
}

/**
 * Infer whether a politician is a supporter or opponent of AI regulation
 * based on their description. Returns a bias toward yea/nay.
 */
function inferVoteBias(description: string): "supportive" | "opposed" | "neutral" {
  const lower = description.toLowerCase();
  if (
    lower.includes("author") ||
    lower.includes("sponsor") ||
    lower.includes("advocate") ||
    lower.includes("supported") ||
    lower.includes("progressive")
  ) {
    return "supportive";
  }
  if (
    lower.includes("opposed") ||
    lower.includes("anti-regulation") ||
    lower.includes("deregulat")
  ) {
    return "opposed";
  }
  return "neutral";
}

/** Deterministic pseudo-random based on a seed string. */
function seededRandom(seed: string): number {
  const hash = createHash("md5").update(seed).digest();
  return (hash[0] + hash[1] * 256) / 65536;
}

/**
 * Build realistic sample vote data for tracked legislation.
 *
 * For each piece of US federal legislation with a bill number, generate
 * sample votes from tracked politicians whose inferred chamber matches.
 *
 * @param dataDir - Root data directory (containing entities/)
 * @param legislationFilter - Optional legislation entity ID to limit results
 */
export function buildSampleVotes(
  dataDir: string,
  legislationFilter?: string,
): VoteIngestResult {
  const warnings: string[] = [];

  let legislation = loadLegislation(dataDir);
  const politicians = loadPoliticians(dataDir);

  if (legislationFilter) {
    legislation = legislation.filter((l) => l.id === legislationFilter);
    if (legislation.length === 0) {
      warnings.push(`No legislation found with id "${legislationFilter}"`);
    }
  }

  // Only generate votes for US federal legislation
  const federalLegislation = legislation.filter((l) => {
    const scope = l.scope ?? "";
    const jur = l.jurisdiction ?? "";
    return (
      scope === "Federal" ||
      scope === "National" ||
      jur === "United States"
    );
  });

  // Also include state legislation
  const stateLegislation = legislation.filter((l) => {
    const scope = l.scope ?? "";
    return scope === "State";
  });

  const records: VoteRecord[] = [];
  const seenPoliticians = new Set<string>();

  // Federal legislation: pair with federal politicians
  const federalPoliticians = politicians.filter((p) => {
    const desc = (p.description ?? "").toLowerCase();
    return (
      desc.includes("u.s. senator") ||
      desc.includes("u.s. representative") ||
      desc.includes("senator from") ||
      desc.includes("representative for")
    );
  });

  for (const leg of federalLegislation) {
    const rollCall = deterministicRollCall(leg.id);

    for (const pol of federalPoliticians) {
      const polChamber = inferChamber(pol.description ?? "");
      // Assign a roll call chamber based on bill number
      const legChamber = inferLegislationChamber(leg.billNumber ?? "");

      // Only include votes from matching chamber
      if (polChamber && legChamber && polChamber !== legChamber) continue;

      const vote = generateSampleVote(pol, leg);
      const voteDate = generateVoteDate(leg);
      const chamber = polChamber ?? legChamber ?? "senate";

      seenPoliticians.add(pol.id);

      records.push({
        id: generateVoteId(leg.id, pol.title, rollCall, 119),
        politicianEntityId: pol.stableId ?? null,
        politicianDisplayName: pol.title,
        legislationEntityId: leg.id,
        legislationTitle: leg.title,
        vote,
        voteDate,
        chamber,
        rollCallNumber: rollCall,
        congressNumber: 119,
        session: 1,
        sourceUrl: `https://www.congress.gov/bill/119th-congress/${legChamber === "house" ? "house-bill" : "senate-bill"}`,
        notes: "Sample data — replace with real Congress.gov data",
      });
    }
  }

  // State legislation: pair with state-level politicians
  for (const leg of stateLegislation) {
    const stateJur = leg.jurisdiction ?? "";
    const rollCall = deterministicRollCall(leg.id);

    const statePols = politicians.filter((p) => {
      const desc = (p.description ?? "").toLowerCase();
      return desc.includes(stateJur.toLowerCase());
    });

    for (const pol of statePols) {
      const polChamber = inferChamber(pol.description ?? "");
      const chamber = polChamber === "senate" ? "state_senate" : "state_assembly";
      const vote = generateSampleVote(pol, leg);
      const voteDate = generateVoteDate(leg);

      seenPoliticians.add(pol.id);

      records.push({
        id: generateVoteId(leg.id, pol.title, rollCall, null),
        politicianEntityId: pol.stableId ?? null,
        politicianDisplayName: pol.title,
        legislationEntityId: leg.id,
        legislationTitle: leg.title,
        vote,
        voteDate,
        chamber,
        rollCallNumber: rollCall,
        congressNumber: null,
        session: null,
        sourceUrl: null,
        notes: "Sample data — replace with real state legislative data",
      });
    }
  }

  return {
    records,
    warnings,
    legislationCount: federalLegislation.length + stateLegislation.length,
    politicianCount: seenPoliticians.size,
  };
}

/** Infer which chamber a bill originated in from its bill number. */
function inferLegislationChamber(billNumber: string): "senate" | "house" | null {
  const bn = billNumber.toUpperCase();
  if (bn.startsWith("S.") || bn.startsWith("S ") || bn.startsWith("SB")) return "senate";
  if (bn.startsWith("H.R.") || bn.startsWith("H.R ") || bn.startsWith("HB")) return "house";
  return null;
}

/** Generate a deterministic roll call number from the legislation ID. */
function deterministicRollCall(legislationId: string): number {
  const hash = createHash("md5").update(`rollcall:${legislationId}`).digest();
  return (hash[0] + hash[1] * 256) % 500 + 1;
}

/** Generate a realistic vote for a politician on legislation. */
function generateSampleVote(
  pol: PoliticianEntity,
  leg: LegislationEntity,
): VoteRecord["vote"] {
  const bias = inferVoteBias(pol.description ?? "");
  const rand = seededRandom(`${pol.id}:${leg.id}:vote`);

  // Base probabilities by bias
  if (bias === "supportive") {
    if (rand < 0.75) return "yea";
    if (rand < 0.90) return "nay";
    if (rand < 0.95) return "not_voting";
    return "abstain";
  }
  if (bias === "opposed") {
    if (rand < 0.70) return "nay";
    if (rand < 0.85) return "yea";
    if (rand < 0.93) return "not_voting";
    return "abstain";
  }
  // Neutral
  if (rand < 0.45) return "yea";
  if (rand < 0.85) return "nay";
  if (rand < 0.93) return "not_voting";
  return "abstain";
}

/** Generate a plausible vote date based on legislation data. */
function generateVoteDate(leg: LegislationEntity): string {
  // Use policyStatus to determine a plausible date range
  const status = leg.policyStatus ?? "";
  if (status === "vetoed") return "2024-09-15";
  if (status === "signed" || status === "enacted" || status === "active") return "2025-03-15";
  // Default: recent
  return "2025-06-15";
}

// ---------------------------------------------------------------------------
// Sync to wiki-server
// ---------------------------------------------------------------------------

const SYNC_BATCH_SIZE = 200;

interface SyncResult {
  totalRecords: number;
  upserted: number;
  batches: number;
  errors: string[];
}

/**
 * Sync vote records to the wiki-server in batches.
 */
export async function syncVotesToServer(
  records: VoteRecord[],
): Promise<SyncResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return {
      totalRecords: records.length,
      upserted: 0,
      batches: 0,
      errors: ["LONGTERMWIKI_SERVER_URL not configured — cannot sync"],
    };
  }

  const result: SyncResult = {
    totalRecords: records.length,
    upserted: 0,
    batches: 0,
    errors: [],
  };

  for (let i = 0; i < records.length; i += SYNC_BATCH_SIZE) {
    const batch = records.slice(i, i + SYNC_BATCH_SIZE);
    result.batches++;

    const syncItems = batch.map((r) => ({
      id: r.id,
      politicianEntityId: r.politicianEntityId,
      politicianDisplayName: r.politicianDisplayName,
      legislationEntityId: r.legislationEntityId,
      legislationTitle: r.legislationTitle,
      vote: r.vote,
      voteDate: r.voteDate,
      chamber: r.chamber,
      rollCallNumber: r.rollCallNumber,
      congressNumber: r.congressNumber,
      session: r.session,
      sourceUrl: r.sourceUrl,
      notes: r.notes,
    }));

    const apiResult: ApiResult<{ upserted: number }> = await apiRequest(
      "POST",
      "/api/political-votes/sync",
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
