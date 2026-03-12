import { readFileSync } from "fs";
import { parseCSVLine } from "../csv.ts";
import { parseQuarterYear } from "../dates.ts";
import { downloadIfMissing } from "../download.ts";
import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";

const EA_FUNDS_CSV_URL = "https://funds.effectivealtruism.org/api/grants";
const EA_FUNDS_CSV_PATH = "/tmp/ea-funds-grants.csv";

export function resolveEAFundEntityIds(
  matcher: EntityMatcher,
): Record<string, string> {
  const ltff = matcher.match("ltff");
  const cea = matcher.match("cea");

  return {
    "Long-Term Future Fund": ltff?.stableId || "yA12C1KcjQ",
    "Animal Welfare Fund": cea?.stableId || "gNsqAes7Dw",
    "EA Infrastructure Fund": cea?.stableId || "gNsqAes7Dw",
    "Effective Altruism Infrastructure Fund": cea?.stableId || "gNsqAes7Dw",
    "Global Health and Development Fund": cea?.stableId || "gNsqAes7Dw",
  };
}

export const source: GrantSource = {
  id: "ea-funds",
  name: "EA Funds",
  sourceUrl: "https://funds.effectivealtruism.org/grants",

  ensureData() {
    downloadIfMissing(EA_FUNDS_CSV_URL, EA_FUNDS_CSV_PATH, "EA Funds CSV");
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    const eaFundEntityIds = resolveEAFundEntityIds(matcher);
    const text = readFileSync(EA_FUNDS_CSV_PATH, "utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    const grants: RawGrant[] = [];

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 5) continue;

      const fund = fields[1]?.trim();
      const description = fields[2]?.trim();
      const grantee = fields[3]?.trim();
      const amountStr = fields[4]?.trim();
      const round = fields[5]?.trim();
      const year = fields[7]?.trim();

      if (!fund || !grantee) continue;
      if (grantee === "(Anonymous)") continue;

      const amount = parseFloat(amountStr) || null;

      const funderId = eaFundEntityIds[fund];
      if (!funderId) continue;

      const granteeId = matchGrantee(grantee, matcher);

      // Date from round: "2025 Q3" → "2025-07", "2024 Q1" → "2024-01"
      let isoDate: string | null = round ? parseQuarterYear(round) : null;
      if (!isoDate && year) {
        isoDate = year;
      }

      const name = description
        ? description.substring(0, 500)
        : `Grant to ${grantee}`;

      grants.push({
        source: "ea-funds",
        funderId,
        granteeName: grantee,
        granteeId,
        name,
        amount,
        date: isoDate,
        focusArea: fund,
        description: description || null,
      });
    }

    return grants;
  },
};
