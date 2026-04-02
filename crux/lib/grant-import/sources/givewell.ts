import { readFileSync, existsSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { parseCSVLine, reassembleCSVRows } from "../csv.ts";
import { matchGrantee } from "../entity-matcher.ts";
import { matchProgram } from "../program-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

/**
 * GiveWell publishes grants data via:
 * - Google Sheets (impact estimates, auto-downloadable):
 *   https://docs.google.com/spreadsheets/d/1z065ab9PPMu9i5KiQ4yLyQJPFQCfEzHSgtHulPiZeBo
 * - Airtable shared view (comprehensive, requires manual export):
 *   https://airtable.com/appaVhon0jdLt1rVs/shrixNMUWCSC5v1lh/tblykYPizxzYj3U1L/viwJ3DyqAUsL654Rm
 *
 * We auto-download the Google Sheets CSV (131 grants, 2020-2024) as the
 * primary source. The Airtable view has the full historical dataset but
 * requires manual export.
 */
const GIVEWELL_CSV_PATH = "/tmp/givewell-grants.csv";
const GIVEWELL_SHEETS_URL =
  "https://docs.google.com/spreadsheets/d/1z065ab9PPMu9i5KiQ4yLyQJPFQCfEzHSgtHulPiZeBo/export?format=csv&gid=0";

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
    if (existsSync(GIVEWELL_CSV_PATH)) return;
    // Auto-download from Google Sheets
    console.log("  Downloading GiveWell grants from Google Sheets...");
    try {
      execFileSync("curl", ["-sfL", "--retry", "3", "--connect-timeout", "15", "-o", GIVEWELL_CSV_PATH, GIVEWELL_SHEETS_URL], {
        stdio: "inherit",
        timeout: 30_000,
      });
    } catch {
      console.warn("  Failed to download from Google Sheets.");
      console.log("  Manual alternative: download CSV from Airtable:");
      console.log("    https://airtable.com/appaVhon0jdLt1rVs/shrixNMUWCSC5v1lh/tblykYPizxzYj3U1L/viwJ3DyqAUsL654Rm");
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

    const grantCol = headers.findIndex((h) => h.includes("grant") && !h.includes("amount") && !h.includes("size"));
    const orgCol = headers.findIndex((h) => h.includes("organization") || h.includes("recipient") || h.includes("grantee") || h.includes("top charity"));
    const amountCol = headers.findIndex((h) => h.includes("total grant size") || h.includes("amount") || h.includes("usd") || h.includes("dollar"));
    const dateCol = headers.findIndex((h) => h.includes("date") || h.includes("year") || h.includes("approved"));
    const topicCol = headers.findIndex((h) => h.includes("topic") || h.includes("program") || h.includes("area") || h.includes("intervention"));

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

      const programId = matchProgram({
        source: "givewell",
        funderId: FUNDER_IDS.GIVEWELL,
        focusArea: topic,
        name,
        description: null,
      });

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
        programId,
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
