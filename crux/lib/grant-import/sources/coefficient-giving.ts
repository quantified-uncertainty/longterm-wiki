import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { parseCSVLine, reassembleCSVRows } from "../csv.ts";
import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";

const CG_CSV_URL =
  "https://coefficientgiving.org/wp-content/uploads/Coefficient-Giving-Grants-Archive.csv";
const CG_CSV_PATH = "/tmp/coefficient-giving-grants.csv";
const FUNDER_ID = "ULjDXpSLCI";

export const source: GrantSource = {
  id: "coefficient-giving",
  name: "Coefficient Giving",
  sourceUrl: "https://coefficientgiving.org/grants/",

  ensureData() {
    if (existsSync(CG_CSV_PATH)) return;
    console.log("Downloading Coefficient Giving CSV...");
    execSync(`curl -fsSL --retry 3 --connect-timeout 10 -o "${CG_CSV_PATH}" "${CG_CSV_URL}"`, {
      stdio: "inherit",
    });
    const size = readFileSync(CG_CSV_PATH).length;
    console.log(`  → ${(size / 1024).toFixed(0)} KB`);
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    const text = readFileSync(CG_CSV_PATH, "utf8");
    const rows = reassembleCSVRows(text);
    const grants: RawGrant[] = [];

    for (const row of rows) {
      const fields = parseCSVLine(row);
      if (fields.length < 5) continue;

      const grantName = fields[0]?.trim();
      const orgName = fields[1]?.trim();
      const focusArea = fields[2]?.trim();
      const amountStr = (fields[3] || "").replace(/[$,"\r]/g, "").trim();
      const date = fields[4]?.trim().replace(/\r/g, "");
      const details = fields[5]?.trim().replace(/\r/g, "") || null;

      if (!grantName || !orgName) continue;

      const amount = parseFloat(amountStr) || null;
      const granteeId = matchGrantee(orgName, matcher);

      // Parse date: "February 2016" → "2016-02"
      let isoDate: string | null = null;
      if (date) {
        const parts = date.split(" ");
        if (parts.length === 2) {
          const monthNames: Record<string, string> = {
            January: "01", February: "02", March: "03", April: "04",
            May: "05", June: "06", July: "07", August: "08",
            September: "09", October: "10", November: "11", December: "12",
          };
          const monthNum = monthNames[parts[0]];
          if (monthNum && parts[1]) {
            isoDate = `${parts[1]}-${monthNum}`;
          }
        }
      }

      grants.push({
        source: "coefficient-giving",
        funderId: FUNDER_ID,
        granteeName: orgName,
        granteeId,
        name: grantName.substring(0, 500),
        amount,
        date: isoDate,
        focusArea: focusArea || null,
        description: details ? details.substring(0, 4000) : null,
      });
    }

    return grants;
  },
};
