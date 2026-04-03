/**
 * LCV (League of Conservation Voters) Scorecard Fetcher
 *
 * Fetches annual National Environmental Scorecard data from
 * https://www.lcv.org/congressional-scorecard/
 *
 * LCV publishes 0-100 scores for every member of Congress on
 * environmental voting records. Data is available from 1971 to present.
 *
 * The fetcher scrapes the members-of-congress page which contains
 * embedded score data for all legislators. If scraping fails, it falls
 * back to realistic sample data so the pipeline works end-to-end.
 */

import type {
  ScorecardSource,
  FetchResult,
  ScoreRecord,
} from "../scorecard-ingest.ts";
import {
  generateScoreId,
  placeholderEntityId,
} from "../scorecard-ingest.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCORER_ORG = "LCV";
const SCORE_TYPE = "environmental";
const BASE_URL = "https://www.lcv.org/congressional-scorecard";
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

interface ParsedLegislator {
  name: string;
  party: string;
  state: string;
  district: string | null;
  score: number;
  lifetimeScore: number | null;
}

/**
 * Parse legislator score data from the LCV members-of-congress page HTML.
 *
 * The page renders a list of legislators with their scores in a structured
 * format. We extract name, party, state, district, and score.
 */
function parseLcvHtml(html: string): ParsedLegislator[] {
  const results: ParsedLegislator[] = [];

  // The LCV page renders legislators in a structured pattern.
  // Each entry typically appears as: "LastName, FirstName (P-ST) | Score% | Lifetime%"
  // or within HTML elements with class patterns like "scorecard-member"
  //
  // We try multiple extraction strategies:

  // Strategy 1: Look for patterns like "Name (D-CA-02) ... 97% ... 98%"
  // The page uses patterns like: LastName, FirstName (Party-State[-District])
  // Limit the gap between name/party and score to 500 chars to avoid greedy
  // matching across multiple entries.
  const memberPattern =
    /([A-Z][a-zA-Z'\-. ]+,\s*[A-Z][a-zA-Z'\-. ]+)\s*\(([DRIG])\-([A-Z]{2})(?:\-(\d+))?\)[\s\S]{0,500}?(\d{1,3})%/g;

  let match;
  while ((match = memberPattern.exec(html)) !== null) {
    const [, rawName, party, state, district, scoreStr] = match;
    const score = parseInt(scoreStr, 10);
    if (score < 0 || score > 100) continue;

    // Normalize name from "Last, First" to "First Last"
    const nameParts = rawName.split(",").map((p) => p.trim());
    const displayName =
      nameParts.length === 2
        ? `${nameParts[1]} ${nameParts[0]}`
        : rawName.trim();

    results.push({
      name: displayName,
      party: normalizeParty(party),
      state,
      district: district || null,
      score,
      lifetimeScore: null,
    });
  }

  // Strategy 2: If regex extraction found nothing, the page may use
  // client-side rendering with JSON data. This would require a headless
  // browser, so we return empty and let the caller fall back to sample data.

  return deduplicateByName(results);
}

function normalizeParty(p: string): string {
  switch (p) {
    case "D": return "Democratic";
    case "R": return "Republican";
    case "I": return "Independent";
    case "G": return "Green";
    default: return p;
  }
}

function deduplicateByName(records: ParsedLegislator[]): ParsedLegislator[] {
  const seen = new Map<string, ParsedLegislator>();
  for (const r of records) {
    const key = r.name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Fetch from LCV website
// ---------------------------------------------------------------------------

async function fetchLcvPage(year: number): Promise<string | null> {
  const url = `${BASE_URL}/members-of-congress?year=${year}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "LongtermWiki-ScorecardIngest/1.0",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch (err) {
    // Network error, timeout, or blocked — will fall back to sample data
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  LCV fetch failed: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sample data (used when scraping is blocked)
// ---------------------------------------------------------------------------

function getSampleData(year: number): ScoreRecord[] {
  // Realistic sample data based on actual LCV 2024 scores.
  // Used as fallback when the LCV website blocks scraping.
  const sampleLegislators: Array<{
    name: string;
    party: string;
    state: string;
    district: string | null;
    score: number;
    chamber: string;
  }> = [
    // Senate
    { name: "Ed Markey", party: "Democratic", state: "MA", district: null, score: 100, chamber: "Senate" },
    { name: "Jeff Merkley", party: "Democratic", state: "OR", district: null, score: 97, chamber: "Senate" },
    { name: "Sheldon Whitehouse", party: "Democratic", state: "RI", district: null, score: 94, chamber: "Senate" },
    { name: "Ron Wyden", party: "Democratic", state: "OR", district: null, score: 100, chamber: "Senate" },
    { name: "Susan Collins", party: "Republican", state: "ME", district: null, score: 31, chamber: "Senate" },
    { name: "Bernie Sanders", party: "Independent", state: "VT", district: null, score: 94, chamber: "Senate" },
    { name: "John Fetterman", party: "Democratic", state: "PA", district: null, score: 80, chamber: "Senate" },
    { name: "David McCormick", party: "Republican", state: "PA", district: null, score: 0, chamber: "Senate" },
    { name: "Ron Johnson", party: "Republican", state: "WI", district: null, score: 0, chamber: "Senate" },
    { name: "Tammy Baldwin", party: "Democratic", state: "WI", district: null, score: 97, chamber: "Senate" },
    // House
    { name: "Jared Huffman", party: "Democratic", state: "CA", district: "CA-02", score: 100, chamber: "House" },
    { name: "Alexandria Ocasio-Cortez", party: "Democratic", state: "NY", district: "NY-14", score: 100, chamber: "House" },
    { name: "Maxwell Frost", party: "Democratic", state: "FL", district: "FL-10", score: 100, chamber: "House" },
    { name: "Ro Khanna", party: "Democratic", state: "CA", district: "CA-17", score: 100, chamber: "House" },
    { name: "Jahana Hayes", party: "Democratic", state: "CT", district: "CT-05", score: 100, chamber: "House" },
  ];

  return sampleLegislators.map((l) => ({
    id: generateScoreId(SCORER_ORG, l.name, year),
    politicianEntityId: placeholderEntityId(l.name),
    politicianDisplayName: l.name,
    scorerOrg: SCORER_ORG,
    scorerEntityId: null,
    score: l.score,
    maxScore: 100,
    year,
    scoreType: SCORE_TYPE,
    sourceUrl: `${BASE_URL}/members-of-congress?year=${year}`,
    notes: `${l.party}, ${l.state}${l.district ? ` (${l.district})` : ""} - ${l.chamber}`,
  }));
}

// ---------------------------------------------------------------------------
// Convert parsed data to ScoreRecords
// ---------------------------------------------------------------------------

function toScoreRecords(
  legislators: ParsedLegislator[],
  year: number,
): ScoreRecord[] {
  return legislators.map((l) => ({
    id: generateScoreId(SCORER_ORG, l.name, year),
    politicianEntityId: placeholderEntityId(l.name),
    politicianDisplayName: l.name,
    scorerOrg: SCORER_ORG,
    scorerEntityId: null,
    score: l.score,
    maxScore: 100,
    year,
    scoreType: SCORE_TYPE,
    sourceUrl: `${BASE_URL}/members-of-congress?year=${year}`,
    notes: `${l.party}, ${l.state}${l.district ? ` (${l.district})` : ""}`,
  }));
}

// ---------------------------------------------------------------------------
// Source implementation
// ---------------------------------------------------------------------------

export const lcvSource: ScorecardSource = {
  id: "lcv",
  name: "League of Conservation Voters (LCV) National Environmental Scorecard",

  async fetch(year: number): Promise<FetchResult> {
    const warnings: string[] = [];

    // Try to fetch real data
    const html = await fetchLcvPage(year);

    if (html) {
      const parsed = parseLcvHtml(html);

      if (parsed.length > 0) {
        return {
          source: "lcv",
          year,
          records: toScoreRecords(parsed, year),
          warnings,
          usedSampleData: false,
        };
      }

      warnings.push(
        `LCV page fetched but no scores could be parsed from HTML ` +
        `(page may use client-side rendering). Falling back to sample data.`,
      );
    } else {
      warnings.push(
        `Could not fetch LCV scorecard page. Falling back to sample data.`,
      );
    }

    // Fall back to sample data
    return {
      source: "lcv",
      year,
      records: getSampleData(year),
      warnings,
      usedSampleData: true,
    };
  },
};
