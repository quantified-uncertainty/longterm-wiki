import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { truncateToMonth } from "../dates.ts";
import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

const FTX_SQL_BASE_URL =
  "https://raw.githubusercontent.com/vipulnaik/donations/master/sql/donations/private-foundations/ftx-future-fund/";
const FTX_SQL_FILES = [
  "ftx-future-fund-ai-safety-open-call-grants.sql",
  "ftx-future-fund-ai-safety-regrants.sql",
  "ftx-future-fund-biosecurity-open-call-grants.sql",
  "ftx-future-fund-biosecurity-regrants.sql",
  "ftx-future-fund-biosecurity-staff-led-grants.sql",
  "ftx-future-fund-effective-altruism-open-call-grants.sql",
  "ftx-future-fund-effective-altruism-staff-led-grants.sql",
  "ftx-future-fund-epistemic-institutions-open-call-grants.sql",
  "ftx-future-fund-epistemic-institutions-regrants.sql",
  "ftx-future-fund-open-call-grants.sql",
  "ftx-future-fund-staff-led-grants.sql",
];
const FTX_SQL_DIR = "/tmp/ftx-future-fund-sql";

interface FTXSQLGrant {
  donee: string;
  amount: number;
  date: string;
  causeArea: string | null;
  earmark: string | null;
  intendedUse: string | null;
  grantType: string;
}

function classifyFTXFile(filename: string): string {
  if (filename.includes("regrant")) return "regrant";
  if (filename.includes("staff-led")) return "staff-led";
  return "open-call";
}

/**
 * Parse Vipul Naik SQL INSERT statements to extract grant records.
 *
 * The SQL format is:
 *   insert into donations(donor, donee, amount, donation_date, ...) values
 *     ('FTX Future Fund','Donee Name',123456,'2022-05-01',...),
 *     ...;
 */
export function parseFTXSQLFile(
  content: string,
  grantType: string,
): FTXSQLGrant[] {
  const grants: FTXSQLGrant[] = [];

  const rowPattern = /\('FTX Future Fund','([^']*(?:''[^']*)*)'\s*,\s*(\d+)\s*,\s*'([^']*)'/g;
  let match;

  while ((match = rowPattern.exec(content)) !== null) {
    const donee = match[1].replace(/''/g, "'");
    const amount = parseInt(match[2], 10);
    const date = match[3];

    const startIdx = match.index;
    const nextRowIdx = content.indexOf("('FTX Future Fund'", startIdx + 1);
    const rowText =
      nextRowIdx > -1
        ? content.substring(startIdx, nextRowIdx)
        : content.substring(startIdx);

    const causeAreaMatch = rowText.match(
      /,'(?:month|day|year)','(?:donation log|website)'\s*,\s*(?:'([^']*(?:''[^']*)*)'|NULL)/
    );
    const causeArea = causeAreaMatch?.[1]?.replace(/''/g, "'") || null;

    let earmark: string | null = null;
    const urlEarmarkPattern =
      /https?:\/\/ftxfuturefund\.org\/[^']*'\s*,\s*(?:'(https?:\/\/[^']*)'\s*,\s*)?(?:'([^']+)'|NULL)\s*,\s*(?:'([^']*)'|NULL)\s*,/;
    const ueMatch = rowText.match(urlEarmarkPattern);
    if (ueMatch) {
      const possibleEarmark = ueMatch[2];
      if (
        possibleEarmark &&
        possibleEarmark !== "NULL" &&
        !possibleEarmark.startsWith("http")
      ) {
        earmark = possibleEarmark.replace(/''/g, "'");
      }
    }

    const useMatch = rowText.match(
      /\/\*\s*intended_use_of_funds\s*\*\/\s*'([^']*(?:''[^']*)*)'/
    );
    const intendedUse = useMatch?.[1]?.replace(/''/g, "'") || null;

    grants.push({
      donee,
      amount,
      date,
      causeArea,
      earmark,
      intendedUse,
      grantType,
    });
  }

  return grants;
}

export const source: GrantSource = {
  id: "ftx-future-fund",
  name: "FTX Future Fund",
  sourceUrl: "https://web.archive.org/web/20221101/https://ftxfuturefund.org/our-grants/",

  ensureData() {
    execFileSync("mkdir", ["-p", FTX_SQL_DIR], { stdio: "pipe" });
    for (const file of FTX_SQL_FILES) {
      const url = `${FTX_SQL_BASE_URL}${file}`;
      const path = `${FTX_SQL_DIR}/${file}`;
      if (existsSync(path)) continue;
      console.log(`  Downloading ${file}...`);
      execFileSync("curl", ["-fsSL", "--retry", "3", "--connect-timeout", "10", "-o", path, url], {
        stdio: "inherit",
      });
    }
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    const grants: RawGrant[] = [];

    for (const file of FTX_SQL_FILES) {
      const path = `${FTX_SQL_DIR}/${file}`;
      if (!existsSync(path)) {
        console.warn(`  WARNING: Missing ${file}, skipping`);
        continue;
      }
      const content = readFileSync(path, "utf8");
      const grantType = classifyFTXFile(file);
      const sqlGrants = parseFTXSQLFile(content, grantType);

      for (const g of sqlGrants) {
        const granteeId = matchGrantee(g.donee, matcher);

        let name: string;
        if (g.intendedUse) {
          name = g.intendedUse.substring(0, 500);
        } else if (g.earmark) {
          name = `Grant to ${g.donee} (${g.earmark})`;
        } else {
          name = `Grant to ${g.donee}`;
        }

        const isoDate = g.date ? truncateToMonth(g.date) : null;

        const focusParts: string[] = [];
        if (g.causeArea) focusParts.push(g.causeArea);
        if (g.grantType !== "open-call") focusParts.push(g.grantType);
        const focusArea = focusParts.length > 0 ? focusParts.join("; ") : null;

        grants.push({
          source: "ftx-future-fund",
          funderId: FUNDER_IDS.FTX_FUTURE_FUND,
          granteeName: g.donee,
          granteeId,
          name,
          amount: g.amount,
          date: isoDate,
          focusArea,
          description: g.intendedUse,
        });
      }
    }

    return grants;
  },

  printAnalysis(grants: RawGrant[]) {
    const byType = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const type = g.focusArea || "unknown";
      const entry = byType.get(type) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byType.set(type, entry);
    }
    console.log("\nBy focus area:");
    for (const [type, data] of [...byType.entries()].sort(
      (a, b) => b[1].total - a[1].total
    )) {
      console.log(
        `  ${type}: ${data.count} grants, $${(data.total / 1e6).toFixed(1)}M`
      );
    }

    console.log("\nSample grants (first 10):");
    for (const g of grants.slice(0, 10)) {
      const matchLabel = g.granteeId ? " [MATCHED]" : "";
      console.log(
        `  ${g.date || "????"} | $${((g.amount || 0) / 1e3).toFixed(0)}K | ${g.granteeName}${matchLabel}`
      );
      if (g.name && g.name !== `Grant to ${g.granteeName}`) {
        console.log(`    ${g.name.substring(0, 100)}`);
      }
    }
  },
};
