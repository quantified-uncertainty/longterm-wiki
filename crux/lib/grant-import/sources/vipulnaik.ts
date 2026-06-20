/**
 * Vipul Naik Donations Database — Multi-donor grant source
 *
 * Imports from https://github.com/vipulnaik/donations — the largest structured
 * donation database in the EA/philanthropic space (207K+ donations, 75 donors).
 *
 * This source covers foundations and individual donors NOT already handled by
 * dedicated sources (coefficient-giving, ea-funds, sff, ftx-future-fund, fli,
 * manifund, givewell, acx-grants, gates-foundation, wellcome-trust, ford-foundation, aria).
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { truncateToMonth } from "../dates.ts";
import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

const VIPULNAIK_RAW_BASE =
  "https://raw.githubusercontent.com/vipulnaik/donations/master/sql/donations/";
const LOCAL_DIR = "/tmp/vipulnaik-donations";

interface DonorConfig {
  sqlPath: string;
  donorName: string;
  sqlDonorString: string;
  funderId: string;
}

const DONOR_CONFIGS: DonorConfig[] = [
  // --- Private foundations with existing entity IDs ---
  {
    sqlPath: "private-foundations/arnold-ventures-grants.sql",
    donorName: "Arnold Ventures",
    sqlDonorString: "Arnold Ventures",
    funderId: FUNDER_IDS.ARNOLD_VENTURES,
  },
  {
    sqlPath: "private-foundations/templeton-foundation-grants.sql",
    donorName: "John Templeton Foundation",
    sqlDonorString: "John Templeton Foundation",
    funderId: FUNDER_IDS.TEMPLETON_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/hewlett-foundation-grants.sql",
    donorName: "Hewlett Foundation",
    sqlDonorString: "Hewlett Foundation",
    funderId: FUNDER_IDS.HEWLETT_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/macarthur-foundation-grants.sql",
    donorName: "MacArthur Foundation",
    sqlDonorString: "MacArthur Foundation",
    funderId: FUNDER_IDS.MACARTHUR_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/sloan-foundation-grants.sql",
    donorName: "Alfred P. Sloan Foundation",
    sqlDonorString: "Alfred P. Sloan Foundation",
    funderId: FUNDER_IDS.SLOAN_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/thiel-foundation-grants.sql",
    donorName: "Thiel Foundation",
    sqlDonorString: "Thiel Foundation",
    funderId: FUNDER_IDS.THIEL_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/chan-zuckerberg-initiative-grants.sql",
    donorName: "Chan Zuckerberg Initiative",
    sqlDonorString: "Chan Zuckerberg Initiative",
    funderId: FUNDER_IDS.CHAN_ZUCKERBERG_INITIATIVE,
  },
  {
    sqlPath: "private-foundations/knight-foundation-grants.sql",
    donorName: "Knight Foundation",
    sqlDonorString: "Knight Foundation",
    funderId: FUNDER_IDS.KNIGHT_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/kellogg-foundation-grants.sql",
    donorName: "W. K. Kellogg Foundation",
    sqlDonorString: "W. K. Kellogg Foundation",
    funderId: FUNDER_IDS.KELLOGG_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/pineapple-fund-grants.sql",
    donorName: "Pineapple Fund",
    sqlDonorString: "Pineapple Fund",
    funderId: FUNDER_IDS.PINEAPPLE_FUND,
  },
  {
    sqlPath: "private-foundations/google-org.sql",
    donorName: "Google.org",
    sqlDonorString: "Google.org",
    funderId: FUNDER_IDS.GOOGLE_ORG,
  },
  {
    sqlPath: "private-foundations/lilly-endowment-grants.sql",
    donorName: "Lilly Endowment",
    sqlDonorString: "Lilly Endowment",
    funderId: FUNDER_IDS.LILLY_ENDOWMENT,
  },
  {
    sqlPath: "private-foundations/mellon-foundation-grants.sql",
    donorName: "Andrew W. Mellon Foundation",
    sqlDonorString: "Andrew W. Mellon Foundation",
    funderId: FUNDER_IDS.MELLON_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/walton-family-foundation-grants.sql",
    donorName: "Walton Family Foundation",
    sqlDonorString: "Walton Family Foundation",
    funderId: FUNDER_IDS.WALTON_FAMILY_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/barr-foundation-grants.sql",
    donorName: "Barr Foundation",
    sqlDonorString: "Barr Foundation",
    funderId: FUNDER_IDS.BARR_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/sandler-foundation-grants.sql",
    donorName: "Sandler Foundation",
    sqlDonorString: "Sandler Foundation",
    funderId: FUNDER_IDS.SANDLER_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/surdna-foundation-grants.sql",
    donorName: "Surdna Foundation",
    sqlDonorString: "Surdna Foundation",
    funderId: FUNDER_IDS.SURDNA_FOUNDATION,
  },
  {
    sqlPath: "private-foundations/donorstrust-grants.sql",
    donorName: "DonorsTrust",
    sqlDonorString: "DonorsTrust",
    funderId: FUNDER_IDS.DONORSTRUST,
  },
  // --- EA-relevant individual donors ---
  {
    sqlPath: "individual-donors/vitalik-buterin-donations.sql",
    donorName: "Vitalik Buterin",
    sqlDonorString: "Vitalik Buterin",
    funderId: FUNDER_IDS.VITALIK_BUTERIN,
  },
];

// ---------------------------------------------------------------------------
// SQL Parser
// ---------------------------------------------------------------------------

interface VNSQLGrant {
  donor: string;
  donee: string;
  earmark: string | null;
  amount: number;
  date: string;
  causeArea: string | null;
  url: string | null;
  notes: string | null;
}

/**
 * Parse a SQL VALUES tuple into an array of string values.
 * Handles: 'quoted strings', 'strings with ''escaped'' quotes', NULL, numbers.
 */
function parseSQLTuple(tuple: string): (string | null)[] {
  const fields: (string | null)[] = [];
  let s = tuple.trim();
  if (s.startsWith("(")) s = s.substring(1);
  if (s.endsWith(")")) s = s.substring(0, s.length - 1);

  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
    if (i >= s.length) break;
    if (s[i] === ",") { i++; continue; }

    if (s[i] === "'") {
      i++;
      let value = "";
      while (i < s.length) {
        if (s[i] === "'" && i + 1 < s.length && s[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (s[i] === "'") {
          i++;
          break;
        } else {
          value += s[i];
          i++;
        }
      }
      fields.push(value);
    } else if (s.substring(i, i + 4).toUpperCase() === "NULL") {
      fields.push(null);
      i += 4;
    } else {
      let value = "";
      while (i < s.length && s[i] !== "," && s[i] !== ")") {
        value += s[i];
        i++;
      }
      fields.push(value.trim());
    }

    while (i < s.length && s[i] !== ",") i++;
    if (i < s.length && s[i] === ",") i++;
  }

  return fields;
}

/**
 * Generic parser for Vipul Naik SQL INSERT statements.
 * Handles multiple INSERT blocks with different column sets per file.
 */
export function parseVNSQLFile(content: string): VNSQLGrant[] {
  const grants: VNSQLGrant[] = [];
  const insertRegex = /insert\s+into\s+donations\s*\(([^)]+)\)\s*values\s*/gi;
  let insertMatch;

  while ((insertMatch = insertRegex.exec(content)) !== null) {
    const columns = insertMatch[1].split(",").map((c) => c.trim().toLowerCase());
    const colIdx = (name: string): number => columns.indexOf(name);
    const donorIdx = colIdx("donor");
    const doneeIdx = colIdx("donee");
    const earmarkIdx = colIdx("donation_earmark");
    const amountIdx = colIdx("amount");
    const dateIdx = colIdx("donation_date");
    const causeAreaIdx = colIdx("cause_area");
    const urlIdx = colIdx("url");
    const notesIdx = colIdx("notes");

    if (donorIdx < 0 || doneeIdx < 0 || amountIdx < 0) continue;

    const valuesStart = insertMatch.index! + insertMatch[0].length;
    const nextInsert = content.indexOf("insert into donations", valuesStart);
    const blockContent = nextInsert > -1
      ? content.substring(valuesStart, nextInsert)
      : content.substring(valuesStart);

    const tupleRegex = /\((?:'(?:[^'\\]|'')*'|[^')])*\)/g;
    let tupleMatch;

    while ((tupleMatch = tupleRegex.exec(blockContent)) !== null) {
      const fields = parseSQLTuple(tupleMatch[0]);
      if (fields.length < Math.max(donorIdx, doneeIdx, amountIdx) + 1) continue;

      const donor = fields[donorIdx];
      const donee = fields[doneeIdx];
      if (!donor || !donee) continue;

      const amount = parseFloat(fields[amountIdx] || "0");
      if (isNaN(amount) || amount <= 0) continue;

      grants.push({
        donor,
        donee,
        earmark: earmarkIdx >= 0 ? (fields[earmarkIdx] || null) : null,
        amount,
        date: dateIdx >= 0 && fields[dateIdx] ? fields[dateIdx]! : "",
        causeArea: causeAreaIdx >= 0 ? (fields[causeAreaIdx] || null) : null,
        url: urlIdx >= 0 && fields[urlIdx]?.startsWith("http") ? fields[urlIdx] : null,
        notes: notesIdx >= 0 ? (fields[notesIdx] || null) : null,
      });
    }
  }

  return grants;
}

// ---------------------------------------------------------------------------
// GrantSource implementation
// ---------------------------------------------------------------------------

export const source: GrantSource = {
  id: "vipulnaik",
  name: "Vipul Naik Donations Database",
  sourceUrl: "https://donations.vipulnaik.com/",

  ensureData() {
    mkdirSync(LOCAL_DIR, { recursive: true });
    let downloaded = 0;
    let skipped = 0;

    for (const donor of DONOR_CONFIGS) {
      const localPath = `${LOCAL_DIR}/${donor.sqlPath.replace(/\//g, "_")}`;
      if (existsSync(localPath)) { skipped++; continue; }

      const url = `${VIPULNAIK_RAW_BASE}${donor.sqlPath}`;
      console.log(`  Downloading ${donor.donorName}...`);
      try {
        execFileSync("curl", ["-fsSL", "--retry", "2", "--connect-timeout", "10", "-o", localPath, url], { stdio: "pipe" });
        downloaded++;
      } catch (e: unknown) {
        console.warn(`  WARNING: Failed to download ${donor.donorName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log(`  Downloaded ${downloaded} files, ${skipped} cached`);
    // Write combined SQL file for snapshot capture
    const parts: string[] = [];
    for (const donor of DONOR_CONFIGS) {
      const localPath = `${LOCAL_DIR}/${donor.sqlPath.replace(/\//g, "_")}`;
      if (existsSync(localPath)) parts.push(readFileSync(localPath, 'utf8'));
    }
    if (parts.length > 0) {
      writeFileSync('/tmp/vipulnaik-combined.sql', parts.join('\n'));
    }
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    const grants: RawGrant[] = [];

    for (const donor of DONOR_CONFIGS) {
      const localPath = `${LOCAL_DIR}/${donor.sqlPath.replace(/\//g, "_")}`;
      if (!existsSync(localPath)) {
        console.warn(`  WARNING: Missing ${donor.donorName} SQL, skipping`);
        continue;
      }

      const content = readFileSync(localPath, "utf8");
      const sqlGrants = parseVNSQLFile(content);
      const donorGrants = sqlGrants.filter((g) => g.donor === donor.sqlDonorString);

      for (const g of donorGrants) {
        const granteeId = matchGrantee(g.donee, matcher);
        let name = g.earmark
          ? `${donor.donorName}: ${g.donee} (${g.earmark})`
          : `${donor.donorName}: ${g.donee}`;
        name = name.substring(0, 500);

        grants.push({
          source: "vipulnaik",
          funderId: donor.funderId,
          granteeName: g.donee,
          granteeId,
          name,
          amount: g.amount,
          date: g.date ? truncateToMonth(g.date) : null,
          focusArea: g.causeArea,
          description: g.notes ? g.notes.substring(0, 4000) : null,
          sourceUrl: g.url,
        });
      }
    }
    return grants;
  },

  printAnalysis(grants: RawGrant[]) {
    const byFunder = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const config = DONOR_CONFIGS.find((d) => d.funderId === g.funderId);
      const funderName = config?.donorName || g.funderId;
      const entry = byFunder.get(funderName) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byFunder.set(funderName, entry);
    }
    console.log("\nBy funder:");
    for (const [funder, data] of [...byFunder.entries()].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${funder}: ${data.count} grants, $${(data.total / 1e6).toFixed(1)}M`);
    }

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
      console.log(`  ${year}: ${data.count} grants, $${(data.total / 1e6).toFixed(1)}M`);
    }

    const matched = grants.filter((g) => g.granteeId).length;
    console.log(`\nEntity match rate: ${matched}/${grants.length} (${((matched / grants.length) * 100).toFixed(1)}%)`);

    const unmatchedByName = new Map<string, number>();
    for (const g of grants) {
      if (!g.granteeId) {
        unmatchedByName.set(g.granteeName, (unmatchedByName.get(g.granteeName) || 0) + (g.amount || 0));
      }
    }
    const topUnmatched = [...unmatchedByName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    if (topUnmatched.length > 0) {
      console.log("\nTop 20 unmatched grantees by total amount:");
      for (const [name, total] of topUnmatched) {
        console.log(`  $${(total / 1e6).toFixed(1)}M — ${name}`);
      }
    }

    console.log("\nSample grants (first 10):");
    for (const g of grants.slice(0, 10)) {
      const matchLabel = g.granteeId ? " [MATCHED]" : "";
      console.log(`  ${g.date || "????"} | $${((g.amount || 0) / 1e3).toFixed(0)}K | ${g.granteeName}${matchLabel}`);
    }
  },
};
