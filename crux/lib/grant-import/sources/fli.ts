import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { truncateToMonth } from "../dates.ts";
import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

const FLI_SQL_URL =
  "https://raw.githubusercontent.com/vipulnaik/donations/master/sql/donations/private-foundations/future-of-life-institute-grants.sql";
const FLI_SQL_PATH = "/tmp/fli-grants.sql";

interface FLISQLGrant {
  donee: string;
  amount: number;
  date: string;
  causeArea: string | null;
  earmark: string | null;
  notes: string | null;
  url: string | null;
}

/**
 * Parse Vipul Naik SQL INSERT statements to extract FLI grant records.
 *
 * The SQL format is:
 *   insert into donations(donor, donee, donation_earmark,
 *       amount, donation_date, ...) values
 *     ('Future of Life Institute','Donee Name','Earmark',123456,'2015-09-01',...),
 *     ...;
 */
export function parseFLISQLFile(content: string): FLISQLGrant[] {
  const grants: FLISQLGrant[] = [];

  // Match rows: ('Future of Life Institute','donee','earmark',amount,'date',...)
  const rowPattern =
    /\('Future of Life Institute','([^']*(?:''[^']*)*)'\s*,\s*'([^']*(?:''[^']*)*)'\s*,\s*([\d.]+)\s*,\s*'([^']*)'/g;
  let match;

  while ((match = rowPattern.exec(content)) !== null) {
    const donee = match[1].replace(/''/g, "'");
    const earmark = match[2].replace(/''/g, "'") || null;
    const amount = parseFloat(match[3]);
    const date = match[4];

    // Extract the full row text for additional field parsing
    const startIdx = match.index;
    const nextRowIdx = content.indexOf(
      "('Future of Life Institute'",
      startIdx + 1,
    );
    const rowText =
      nextRowIdx > -1
        ? content.substring(startIdx, nextRowIdx)
        : content.substring(startIdx);

    // Extract cause_area field
    const causeAreaMatch = rowText.match(
      /'AI safety'|'[^']*safety[^']*'/,
    );
    const causeArea = causeAreaMatch
      ? causeAreaMatch[0].replace(/^'|'$/g, "")
      : "AI safety";

    // Extract URL field
    const urlMatch = rowText.match(
      /'(https?:\/\/futureoflife\.org[^']*)'/,
    );
    const url = urlMatch ? urlMatch[1] : null;

    // Extract notes field
    const notesMatch = rowText.match(
      /NULL,'([^']*(?:''[^']*)*)'\s*,\s*NULL/,
    );
    const notes = notesMatch ? notesMatch[1].replace(/''/g, "'") : null;

    grants.push({
      donee,
      amount,
      date,
      causeArea,
      earmark,
      notes,
      url,
    });
  }

  return grants;
}

export const source: GrantSource = {
  id: "fli",
  name: "Future of Life Institute",
  sourceUrl: "https://futureoflife.org/",

  ensureData() {
    if (existsSync(FLI_SQL_PATH)) return;
    console.log("  Downloading FLI grants SQL...");
    execFileSync(
      "curl",
      [
        "-fsSL",
        "--retry",
        "3",
        "--connect-timeout",
        "10",
        "-o",
        FLI_SQL_PATH,
        FLI_SQL_URL,
      ],
      { stdio: "inherit" },
    );
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    if (!existsSync(FLI_SQL_PATH)) {
      console.warn("  WARNING: FLI SQL file missing, skipping");
      return [];
    }

    const content = readFileSync(FLI_SQL_PATH, "utf8");
    const sqlGrants = parseFLISQLFile(content);
    const grants: RawGrant[] = [];

    for (const g of sqlGrants) {
      const granteeId = matchGrantee(g.donee, matcher);

      // Build a descriptive name using the earmark (typically PI name)
      let name: string;
      if (g.earmark) {
        name = `FLI Grant to ${g.donee} (${g.earmark})`;
      } else {
        name = `FLI Grant to ${g.donee}`;
      }
      name = name.substring(0, 500);

      const isoDate = g.date ? truncateToMonth(g.date) : null;

      const description = g.notes
        ? g.notes.substring(0, 4000)
        : null;

      grants.push({
        source: "fli",
        funderId: FUNDER_IDS.FLI,
        granteeName: g.donee,
        granteeId,
        name,
        amount: g.amount,
        date: isoDate,
        focusArea: g.causeArea,
        description,
        sourceUrl: g.url,
      });
    }

    return grants;
  },

  printAnalysis(grants: RawGrant[]) {
    // Group by year
    const byYear = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const year = g.date?.substring(0, 4) || "unknown";
      const entry = byYear.get(year) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byYear.set(year, entry);
    }

    console.log("\nBy year:");
    for (const [year, data] of [...byYear.entries()].sort()) {
      console.log(
        `  ${year}: ${data.count} grants, $${(data.total / 1e6).toFixed(2)}M`,
      );
    }

    console.log("\nSample grants (first 10):");
    for (const g of grants.slice(0, 10)) {
      const matchLabel = g.granteeId ? " [MATCHED]" : "";
      console.log(
        `  ${g.date || "????"} | $${((g.amount || 0) / 1e3).toFixed(0)}K | ${g.granteeName}${matchLabel}`,
      );
    }
  },
};
