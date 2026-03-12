import { readFileSync } from "fs";
import { parseCSVLine, reassembleCSVRows } from "../csv.ts";
import { parseMonthYear } from "../dates.ts";
import { downloadIfMissing } from "../download.ts";
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
    downloadIfMissing(CG_CSV_URL, CG_CSV_PATH, "Coefficient Giving CSV");
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
      const isoDate = date ? parseMonthYear(date) : null;

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
