/**
 * Ford Foundation grant import adapter.
 *
 * Source: https://www.fordfoundation.org/work/our-grants/grants-database/
 * Format: Paginated JSON API (~6K grants, ~$3.4B total, 2011-2026)
 * Endpoint: https://www.fordfoundation.org/grant-api/grants
 * Pagination: `page` (1-indexed) and `per_page` (max 100)
 * Fields: grant_id, grantee_name, grantee_website_url, grant_amount,
 *         total_amount, description, approval_date, start_date, end_date,
 *         fiscal_year_of_approval, locations[], programs[], subjects[], regions[], types[]
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { matchGrantee } from "../entity-matcher.ts";
import { matchProgram } from "../program-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

const API_BASE = "https://www.fordfoundation.org/grant-api/grants";
const JSON_PATH = "/tmp/ford-foundation-grants.json";
const PER_PAGE = 100;

interface FordGrant {
  grant_id: string;
  grantee_name: string;
  grantee_website_url?: string;
  grant_amount: number;
  total_amount?: number;
  description?: string;
  approval_date?: string;
  start_date?: string;
  end_date?: string;
  fiscal_year_of_approval?: number;
  locations?: Array<{ location_name?: string }>;
  programs?: Array<{ program_name?: string }>;
  subjects?: Array<{ subject_name?: string }>;
  regions?: Array<{ region_name?: string }>;
  types?: Array<{ type_name?: string }>;
}

interface FordApiResponse {
  grants: FordGrant[];
  total?: number;
  page?: number;
  per_page?: number;
}

async function fetchAllPages(): Promise<FordGrant[]> {
  const allGrants: FordGrant[] = [];
  let page = 1;
  let totalFetched = 0;
  let hasMore = true;

  console.log("Fetching Ford Foundation grants from API...");

  while (hasMore) {
    const url = `${API_BASE}?page=${page}&per_page=${PER_PAGE}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Ford Foundation API returned ${response.status} on page ${page}: ${response.statusText}`
      );
    }

    const data = (await response.json()) as FordApiResponse;
    const grants = data.grants || [];

    if (grants.length === 0) {
      hasMore = false;
    } else {
      allGrants.push(...grants);
      totalFetched += grants.length;

      if (page % 10 === 0 || grants.length < PER_PAGE) {
        console.log(`  → Page ${page}: ${totalFetched} grants so far`);
      }

      if (grants.length < PER_PAGE) {
        hasMore = false;
      } else {
        page++;
      }
    }
  }

  console.log(`  → Total: ${allGrants.length} grants fetched`);
  return allGrants;
}

export const source: GrantSource = {
  id: "ford-foundation",
  name: "Ford Foundation",
  sourceUrl: "https://www.fordfoundation.org/work/our-grants/grants-database/",

  async ensureData() {
    if (existsSync(JSON_PATH)) {
      try {
        const content = readFileSync(JSON_PATH, "utf8");
        const parsed = JSON.parse(content) as FordGrant[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log(
            `Using cached Ford Foundation data (${parsed.length} grants) at ${JSON_PATH}`
          );
          return;
        }
      } catch {
        // Corrupted or invalid JSON — re-fetch
      }
    }

    const grants = await fetchAllPages();
    writeFileSync(JSON_PATH, JSON.stringify(grants, null, 2));
    console.log(
      `  → Saved ${grants.length} grants to ${JSON_PATH} (${(readFileSync(JSON_PATH).length / 1024 / 1024).toFixed(1)} MB)`
    );
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    const raw = JSON.parse(readFileSync(JSON_PATH, "utf8")) as FordGrant[];
    const grants: RawGrant[] = [];

    for (const g of raw) {
      if (!g.grantee_name || !g.grant_id) continue;

      const granteeName = g.grantee_name.trim();
      const granteeId = matchGrantee(granteeName, matcher);

      // Extract YYYY-MM from approval_date (format: "2024-01-15")
      let isoDate: string | null = null;
      if (g.approval_date) {
        const match = g.approval_date.match(/^(\d{4}-\d{2})/);
        if (match) {
          isoDate = match[1];
        }
      }

      const amount = typeof g.grant_amount === "number" ? g.grant_amount : null;

      // Join program names for focusArea
      const programNames = (g.programs || [])
        .map((p) => p.program_name)
        .filter(Boolean) as string[];
      const focusArea =
        programNames.length > 0 ? programNames.join(", ") : null;

      // Build description from description + subjects + regions
      const descParts: string[] = [];
      if (g.description) {
        descParts.push(g.description.trim());
      }
      const subjectNames = (g.subjects || [])
        .map((s) => s.subject_name)
        .filter(Boolean) as string[];
      if (subjectNames.length > 0) {
        descParts.push(`Subjects: ${subjectNames.join(", ")}`);
      }
      const regionNames = (g.regions || [])
        .map((r) => r.region_name)
        .filter(Boolean) as string[];
      if (regionNames.length > 0) {
        descParts.push(`Regions: ${regionNames.join(", ")}`);
      }
      const description =
        descParts.length > 0
          ? descParts.join("; ").substring(0, 4000)
          : null;

      const name = g.description
        ? g.description.trim().substring(0, 500)
        : `Grant to ${granteeName}`.substring(0, 500);

      const programId = matchProgram({
        source: "ford-foundation",
        funderId: FUNDER_IDS.FORD_FOUNDATION,
        focusArea,
        name,
        description,
      });

      grants.push({
        source: "ford-foundation",
        funderId: FUNDER_IDS.FORD_FOUNDATION,
        granteeName,
        granteeId,
        name,
        amount,
        date: isoDate,
        focusArea,
        description,
        programId,
      });
    }

    return grants;
  },

  printAnalysis(grants: RawGrant[]) {
    const byProgram = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const program = g.focusArea || "Unknown";
      const entry = byProgram.get(program) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byProgram.set(program, entry);
    }
    console.log("\nBy program area:");
    const sorted = [...byProgram.entries()].sort(
      (a, b) => b[1].total - a[1].total
    );
    for (const [program, data] of sorted.slice(0, 20)) {
      console.log(
        `  ${data.count.toString().padStart(5)} grants  $${(data.total / 1e6).toFixed(1)}M  ${program}`
      );
    }
  },
};
