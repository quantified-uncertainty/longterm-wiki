/**
 * Council for a Livable World Scorecard Fetcher
 *
 * Fetches endorsement and scorecard data from
 * https://livableworld.org
 *
 * The Council for a Livable World focuses on nuclear arms control,
 * non-proliferation, and responsible Pentagon spending. They endorse
 * congressional candidates and publish legislative analysis.
 *
 * Unlike LCV and Humane World, the Council does not publish a structured
 * numerical scorecard. Their primary public data is their endorsement
 * list. Endorsed candidates receive a binary "endorsed" designation
 * rather than a percentage score.
 *
 * We model endorsements as score=1, maxScore=1 (binary) with
 * scoreType="nuclear" to distinguish from percentage-based scorecards.
 *
 * The website does not expose structured data via API or downloadable
 * files, so this fetcher attempts to scrape the candidates page.
 * If scraping fails, realistic sample data is used.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const SCORER_ORG = "Council for a Livable World";
const SCORE_TYPE = "nuclear";
const BASE_URL = "https://livableworld.org";
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

interface ParsedCandidate {
  name: string;
  state: string;
  chamber: string;
  status: string;
}

/**
 * Parse endorsed candidates from the CLW candidates page.
 *
 * The page lists endorsed Senate and House candidates with their
 * state and election outcome.
 */
function parseCandidatesHtml(html: string): ParsedCandidate[] {
  const results: ParsedCandidate[] = [];

  // Look for candidate name patterns in the HTML
  // CLW pages typically list candidates like "Name (State)" or in list items

  // Strategy 1: Look for links to candidate-specific pages
  // Pattern: /meet-the-candidates/name-state/
  const candidateUrlPattern =
    /\/meet-the-candidates\/([a-z-]+)\/?\s*"[^>]*>([^<]+)/gi;
  let match;
  while ((match = candidateUrlPattern.exec(html)) !== null) {
    const [, slug, text] = match;
    const name = text.trim();
    if (!name || name.length < 3 || name.length > 100) continue;

    // Try to extract state from slug
    const slugParts = slug.split("-");
    const lastPart = slugParts[slugParts.length - 1];
    const state =
      lastPart && lastPart.length === 2
        ? lastPart.toUpperCase()
        : "US";

    results.push({
      name,
      state,
      chamber: "Unknown",
      status: "endorsed",
    });
  }

  // Strategy 2: Look for structured list items with candidate names
  const listPattern =
    /(?:Senate|House)[^]*?<li[^>]*>([^<]+(?:,\s*[A-Z]{2}))/gi;
  while ((match = listPattern.exec(html)) !== null) {
    const text = match[1].trim();
    const parts = text.split(",").map((p) => p.trim());
    if (parts.length >= 2) {
      results.push({
        name: parts[0],
        state: parts[1].substring(0, 2),
        chamber: /Senate/i.test(match[0]) ? "Senate" : "House",
        status: "endorsed",
      });
    }
  }

  return deduplicateByName(results);
}

function deduplicateByName(
  candidates: ParsedCandidate[],
): ParsedCandidate[] {
  const seen = new Map<string, ParsedCandidate>();
  for (const c of candidates) {
    const key = c.name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, c);
    }
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Fetch from CLW website
// ---------------------------------------------------------------------------

async function fetchCandidatesPage(): Promise<string | null> {
  const urls = [
    `${BASE_URL}/meet-the-candidates/`,
    `${BASE_URL}/meet-the-candidates/our-legacy-in-congress-who-weve-helped-elect/`,
  ];

  for (const url of urls) {
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

      if (response.ok) {
        return await response.text();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  CLW fetch failed for ${url}: ${msg}`);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sample data (fallback)
// ---------------------------------------------------------------------------

function getSampleData(year: number): ScoreRecord[] {
  // Realistic sample data based on Council for a Livable World endorsements.
  // These are historically endorsed legislators known for arms control stances.
  const dir = dirname(fileURLToPath(import.meta.url));
  const samples: Array<{
    name: string;
    party: string;
    state: string;
    chamber: string;
  }> = JSON.parse(readFileSync(join(dir, "fixtures/council-livable-world-sample.json"), "utf-8"));

  return samples.map((s) => ({
    id: generateScoreId(SCORER_ORG, s.name, year),
    politicianEntityId: placeholderEntityId(s.name),
    politicianDisplayName: s.name,
    scorerOrg: SCORER_ORG,
    scorerEntityId: null,
    score: 1,
    maxScore: 1,
    year,
    scoreType: SCORE_TYPE,
    sourceUrl: `${BASE_URL}/meet-the-candidates/`,
    notes: `${s.party}, ${s.state} - ${s.chamber} - Endorsed`,
  }));
}

// ---------------------------------------------------------------------------
// Convert parsed data to ScoreRecords
// ---------------------------------------------------------------------------

function toScoreRecords(
  candidates: ParsedCandidate[],
  year: number,
): ScoreRecord[] {
  return candidates.map((c) => ({
    id: generateScoreId(SCORER_ORG, c.name, year),
    politicianEntityId: placeholderEntityId(c.name),
    politicianDisplayName: c.name,
    scorerOrg: SCORER_ORG,
    scorerEntityId: null,
    score: 1,
    maxScore: 1,
    year,
    scoreType: SCORE_TYPE,
    sourceUrl: `${BASE_URL}/meet-the-candidates/`,
    notes: `${c.state} - ${c.chamber} - ${c.status}`,
  }));
}

// ---------------------------------------------------------------------------
// Source implementation
// ---------------------------------------------------------------------------

export const councilLivableWorldSource: ScorecardSource = {
  id: "council-livable-world",
  name: "Council for a Livable World Endorsements",

  async fetch(year: number): Promise<FetchResult> {
    const warnings: string[] = [];

    warnings.push(
      "Note: Council for a Livable World publishes endorsements (binary) " +
      "rather than percentage scores. Scores are recorded as 1/1 (endorsed).",
    );

    // Try to fetch real data
    const html = await fetchCandidatesPage();

    if (html) {
      const parsed = parseCandidatesHtml(html);

      if (parsed.length > 0) {
        return {
          source: "council-livable-world",
          year,
          records: toScoreRecords(parsed, year),
          warnings,
          usedSampleData: false,
        };
      }

      warnings.push(
        "CLW page fetched but no candidates could be parsed from HTML. " +
        "Falling back to sample data.",
      );
    } else {
      warnings.push(
        "Could not fetch CLW candidates page. Falling back to sample data.",
      );
    }

    return {
      source: "council-livable-world",
      year,
      records: getSampleData(year),
      warnings,
      usedSampleData: true,
    };
  },
};
