import { readFileSync, existsSync } from "fs";
import { parseCSVLine, reassembleCSVRows } from "../csv.ts";
import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

/**
 * GiveWell publishes grants data via an Airtable view:
 *   https://airtable.com/appaVhon0jdLt1rVs/shrixNMUWCSC5v1lh/tblykYPizxzYj3U1L/viwJ3DyqAUsL654Rm
 *
 * Since Airtable doesn't offer a direct CSV export for shared views,
 * the user must manually export the data:
 *   1. Open the Airtable link above
 *   2. Click "..." menu → "Download CSV"
 *   3. Save as /tmp/givewell-grants.csv
 *
 * Expected CSV columns (based on the Airtable schema):
 *   Grant, Organization, Amount, Date, Topic, Funder
 */
const GIVEWELL_CSV_PATH = "/tmp/givewell-grants.csv";

/**
 * Parse an amount string that may contain "$", commas, or "M"/"K" suffixes.
 * Examples: "$2,500,000", "$2.5M", "$500K", "2500000"
 */
export function parseGiveWellAmount(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;

  const mMatch = cleaned.match(/^([\d.]+)[Mm]$/);
  if (mMatch) return parseFloat(mMatch[1]) * 1_000_000;

  const kMatch = cleaned.match(/^([\d.]+)[Kk]$/);
  if (kMatch) return parseFloat(kMatch[1]) * 1_000;

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Parse a date string in various formats GiveWell might use.
 * Returns ISO date string (YYYY-MM-DD, YYYY-MM, or YYYY).
 */
export function parseGiveWellDate(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Already ISO format: "2023-05-15" or "2023-05"
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(trimmed)) return trimmed;

  // "YYYY" alone
  if (/^\d{4}$/.test(trimmed)) return trimmed;

  // "Month YYYY" e.g. "November 2021"
  const monthYearMatch = trimmed.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/
  );
  if (monthYearMatch) {
    const months: Record<string, string> = {
      January: "01", February: "02", March: "03", April: "04",
      May: "05", June: "06", July: "07", August: "08",
      September: "09", October: "10", November: "11", December: "12",
    };
    return `${monthYearMatch[2]}-${months[monthYearMatch[1]]}`;
  }

  // "MM/DD/YYYY" or "M/D/YYYY"
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const month = slashMatch[1].padStart(2, "0");
    const day = slashMatch[2].padStart(2, "0");
    return `${slashMatch[3]}-${month}-${day}`;
  }

  return null;
}

export const source: GrantSource = {
  id: "givewell",
  name: "GiveWell",
  sourceUrl: "https://www.givewell.org/research/all-grants/August-2022-version",

  ensureData() {
    if (!existsSync(GIVEWELL_CSV_PATH)) {
      console.log(`\n  GiveWell grants CSV not found at ${GIVEWELL_CSV_PATH}`);
      console.log("  To download:");
      console.log("    1. Open: https://airtable.com/appaVhon0jdLt1rVs/shrixNMUWCSC5v1lh/tblykYPizxzYj3U1L/viwJ3DyqAUsL654Rm");
      console.log("    2. Click the '...' menu → 'Download CSV'");
      console.log(`    3. Save the file to ${GIVEWELL_CSV_PATH}`);
      console.log("  Skipping GiveWell source.\n");
    }
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    if (!existsSync(GIVEWELL_CSV_PATH)) {
      return [];
    }

    const text = readFileSync(GIVEWELL_CSV_PATH, "utf8");
    const rows = reassembleCSVRows(text);
    const grants: RawGrant[] = [];

    // Detect header to find column indices
    const headerLine = text.split("\n")[0];
    const headers = parseCSVLine(headerLine).map((h) => h.toLowerCase().trim());

    const grantCol = headers.findIndex((h) => h.includes("grant") && !h.includes("amount"));
    const orgCol = headers.findIndex((h) => h.includes("organization") || h.includes("recipient") || h.includes("grantee"));
    const amountCol = headers.findIndex((h) => h.includes("amount") || h.includes("usd") || h.includes("dollar"));
    const dateCol = headers.findIndex((h) => h.includes("date") || h.includes("year") || h.includes("approved"));
    const topicCol = headers.findIndex((h) => h.includes("topic") || h.includes("program") || h.includes("area"));

    if (orgCol === -1) {
      console.warn("  WARNING: Could not find organization column in GiveWell CSV. Headers:", headers);
      return [];
    }

    for (const row of rows) {
      const fields = parseCSVLine(row);

      const orgName = (orgCol >= 0 ? fields[orgCol] : "")?.trim();
      if (!orgName) continue;

      const amountStr = (amountCol >= 0 ? fields[amountCol] : "")?.trim() || "";
      const dateStr = (dateCol >= 0 ? fields[dateCol] : "")?.trim() || "";
      const topic = (topicCol >= 0 ? fields[topicCol] : "")?.trim() || null;
      const grantName = (grantCol >= 0 ? fields[grantCol] : "")?.trim() || "";

      const amount = parseGiveWellAmount(amountStr);
      const isoDate = parseGiveWellDate(dateStr);
      const granteeId = matchGrantee(orgName, matcher);

      const name = grantName
        ? grantName.substring(0, 500)
        : `Grant to ${orgName}`.substring(0, 500);

      grants.push({
        source: "givewell",
        funderId: FUNDER_IDS.GIVEWELL,
        granteeName: orgName,
        granteeId,
        name,
        amount,
        date: isoDate,
        focusArea: topic,
        description: null,
      });
    }

    return grants;
  },

  printAnalysis(grants: RawGrant[]) {
    if (grants.length === 0) {
      console.log("\n  No GiveWell grants parsed (CSV not available).");
      return;
    }

    const byOrg = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const entry = byOrg.get(g.granteeName) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byOrg.set(g.granteeName, entry);
    }
    console.log("\nTop organizations by total funding:");
    const sorted = [...byOrg.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [org, data] of sorted.slice(0, 15)) {
      console.log(
        `  ${org}: ${data.count} grants, $${(data.total / 1e6).toFixed(1)}M`
      );
    }
  },
};
