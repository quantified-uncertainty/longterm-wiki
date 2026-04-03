/**
 * Humane World Action Fund Scorecard Fetcher
 *
 * Fetches the Humane Scorecard data from
 * https://humaneaction.org/humane-scorecard/
 *
 * The Humane World Action Fund (formerly Humane Society Legislative Fund)
 * publishes annual scores for every federal legislator on animal protection
 * votes covering farm animal welfare, wildlife protection, animal cruelty,
 * and puppy mills.
 *
 * The scorecard data is stored in a Google Sheet and loaded dynamically.
 * We attempt to fetch from the public Google Sheets CSV export endpoint.
 * If that fails, we use realistic sample data.
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

import { loadFixture } from "./load-fixture.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCORER_ORG = "Humane World Action Fund";
const SCORE_TYPE = "animal_welfare";
const SOURCE_URL = "https://humaneaction.org/humane-scorecard/";
const FETCH_TIMEOUT_MS = 30_000;

// Google Sheet ID discovered from the scorecard page's embedded JavaScript.
// The sheet has tabs including "hundreds" (100+ Club) and "zeroes" (Total Zeroes).
const GOOGLE_SHEET_ID = "1jCieSZVB__h85hTesYaLYCX7S7lFCNEBfjj469RTV_M";

// ---------------------------------------------------------------------------
// Google Sheets CSV fetch
// ---------------------------------------------------------------------------

interface ParsedMember {
  name: string;
  party: string;
  state: string;
  district: string | null;
}

/**
 * Attempt to fetch the "100+ Club" and "Total Zeroes" tabs from the
 * public Google Sheets CSV export.
 *
 * The 100+ Club members are assigned a score of 100 (perfect).
 * The Total Zeroes members are assigned a score of 0.
 *
 * This is an approximation: the actual scorecard has granular numeric
 * scores, but the publicly accessible tabs only expose the extremes.
 */
async function fetchGoogleSheetTab(
  tab: string,
): Promise<ParsedMember[] | null> {
  const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${tab}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "LongtermWiki-ScorecardIngest/1.0",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const csv = await response.text();
    return parseCsv(csv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Humane World Google Sheet fetch failed (${tab}): ${msg}`);
    return null;
  }
}

/**
 * Parse CSV from Google Sheets export.
 *
 * Expected columns: Name, Party, State, District (+ possibly empty columns).
 * Values are quoted with double quotes.
 */
function parseCsv(csv: string): ParsedMember[] {
  const lines = csv.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  const results: ParsedMember[] = [];

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 3) continue;

    const name = fields[0].trim();
    const party = fields[1].trim();
    const state = fields[2].trim();
    const district = fields.length > 3 ? fields[3].trim() || null : null;

    if (!name || !party || !state) continue;

    // Normalize name from "Last, First M." to "First Last"
    const nameParts = name.split(",").map((p) => p.trim());
    const displayName =
      nameParts.length >= 2
        ? `${nameParts[1].split(" ")[0]} ${nameParts[0]}`
        : name;

    results.push({
      name: displayName,
      party: normalizeParty(party),
      state,
      district: district && district !== "At Large" ? `${state}-${district}` : null,
    });
  }

  return results;
}

/** Parse a single CSV line, handling quoted fields with commas. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function normalizeParty(p: string): string {
  const lower = p.toLowerCase().trim();
  if (lower === "d" || lower.startsWith("dem")) return "Democratic";
  if (lower === "r" || lower.startsWith("rep")) return "Republican";
  if (lower === "i" || lower.startsWith("ind")) return "Independent";
  return p;
}

// ---------------------------------------------------------------------------
// Sample data (fallback)
// ---------------------------------------------------------------------------

function getSampleData(year: number): ScoreRecord[] {
  // Realistic sample data based on the 2025 Humane Scorecard "100+ Club"
  // and "Total Zeroes" lists.
  const samples = loadFixture<Array<{
    name: string;
    party: string;
    state: string;
    score: number;
    notes: string;
  }>>(import.meta.url, "humane-world-sample.json");

  return samples.map((s) => ({
    id: generateScoreId(SCORER_ORG, s.name, year),
    politicianEntityId: placeholderEntityId(s.name),
    politicianDisplayName: s.name,
    scorerOrg: SCORER_ORG,
    scorerEntityId: null,
    score: s.score,
    maxScore: 100,
    year,
    scoreType: SCORE_TYPE,
    sourceUrl: SOURCE_URL,
    notes: `${s.party}, ${s.state} - ${s.notes}`,
  }));
}

// ---------------------------------------------------------------------------
// Convert parsed data to ScoreRecords
// ---------------------------------------------------------------------------

function toScoreRecords(
  members: ParsedMember[],
  score: number,
  year: number,
  listName: string,
): ScoreRecord[] {
  return members.map((m) => ({
    id: generateScoreId(SCORER_ORG, m.name, year),
    politicianEntityId: placeholderEntityId(m.name),
    politicianDisplayName: m.name,
    scorerOrg: SCORER_ORG,
    scorerEntityId: null,
    score,
    maxScore: 100,
    year,
    scoreType: SCORE_TYPE,
    sourceUrl: SOURCE_URL,
    notes: `${m.party}, ${m.state}${m.district ? ` (${m.district})` : ""} - ${listName}`,
  }));
}

// ---------------------------------------------------------------------------
// Source implementation
// ---------------------------------------------------------------------------

export const humaneWorldSource: ScorecardSource = {
  id: "humane-world",
  name: "Humane World Action Fund Humane Scorecard",

  async fetch(year: number): Promise<FetchResult> {
    const warnings: string[] = [];
    const allRecords: ScoreRecord[] = [];

    // Fetch "100+ Club" (score = 100)
    const hundredsMembers = await fetchGoogleSheetTab("hundreds");
    if (hundredsMembers && hundredsMembers.length > 0) {
      allRecords.push(...toScoreRecords(hundredsMembers, 100, year, "100+ Club"));
    } else {
      warnings.push("Could not fetch '100+ Club' tab from Google Sheet.");
    }

    // Fetch "Total Zeroes" (score = 0)
    const zeroesMembers = await fetchGoogleSheetTab("zeroes");
    if (zeroesMembers && zeroesMembers.length > 0) {
      allRecords.push(...toScoreRecords(zeroesMembers, 0, year, "Total Zeroes"));
    } else {
      warnings.push("Could not fetch 'Total Zeroes' tab from Google Sheet.");
    }

    if (allRecords.length > 0) {
      warnings.push(
        "Note: Only '100+ Club' (score=100) and 'Total Zeroes' (score=0) " +
        "lists are publicly accessible. Legislators with intermediate scores " +
        "are not included in this import.",
      );
      return {
        source: "humane-world",
        year,
        records: allRecords,
        warnings,
        usedSampleData: false,
      };
    }

    // Fall back to sample data
    warnings.push("Falling back to sample data.");
    return {
      source: "humane-world",
      year,
      records: getSampleData(year),
      warnings,
      usedSampleData: true,
    };
  },
};
