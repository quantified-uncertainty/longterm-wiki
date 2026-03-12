import { readFileSync } from "fs";
import { downloadIfMissing } from "../download.ts";
import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

const SFF_URL = "https://survivalandflourishing.fund/recommendations";
const SFF_HTML_PATH = "/tmp/sff-recommendations.html";

/**
 * Parse the SFF amount field which can have several formats:
 * - "$79,000"
 * - "$1,535,000 +$500,000\u2021"   (matching pledge)
 * - "$1,607,000\u2021"              (all matching)
 * - "$1,094,000 and $135,000"  (FlexHEG dual-source)
 *
 * We sum all dollar amounts in the field to get the total.
 */
export function parseSFFAmount(amountStr: string): number | null {
  const matches = amountStr.match(/\$[\d,]+/g);
  if (!matches || matches.length === 0) return null;

  let total = 0;
  for (const m of matches) {
    const num = parseFloat(m.replace(/[$,]/g, ""));
    if (!isNaN(num)) total += num;
  }
  return total > 0 ? total : null;
}

/**
 * Convert SFF round name to an ISO date string.
 * - "SFF-2025" -> "2025"
 * - "SFF-2023-H1" -> "2023-01"
 * - "SFF-2023-H2" -> "2023-07"
 * - "SFF-2019-Q3" -> "2019-07"
 * - "SFF-2024-FlexHEGs" -> "2024"
 * - "Initiative Committee 2024" -> "2024"
 */
export function sffRoundToDate(round: string): string | null {
  const hMatch = round.match(/SFF-(\d{4})-H(\d)/);
  if (hMatch) {
    const year = hMatch[1];
    const half = hMatch[2];
    return half === "1" ? `${year}-01` : `${year}-07`;
  }

  const qMatch = round.match(/SFF-(\d{4})-Q(\d)/);
  if (qMatch) {
    const year = qMatch[1];
    const qMonth: Record<string, string> = {
      "1": "01", "2": "04", "3": "07", "4": "10",
    };
    return `${year}-${qMonth[qMatch[2]] || "01"}`;
  }

  const yearMatch = round.match(/SFF-(\d{4})/);
  if (yearMatch) return yearMatch[1];

  const icMatch = round.match(/Initiative Committee (\d{4})/);
  if (icMatch) return icMatch[1];

  return null;
}

export const source: GrantSource = {
  id: "sff",
  name: "Survival and Flourishing Fund",
  sourceUrl: "https://survivalandflourishing.fund/recommendations",

  ensureData() {
    downloadIfMissing(SFF_URL, SFF_HTML_PATH, "SFF recommendations HTML");
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    const html = readFileSync(SFF_HTML_PATH, "utf8");
    const grants: RawGrant[] = [];

    const trRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/tr>/g;
    let trMatch;

    while ((trMatch = trRegex.exec(html)) !== null) {
      const rowHtml = trMatch[0];

      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
      const cells: string[] = [];
      let tdMatch;
      while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
        cells.push(
          tdMatch[1]
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, " ")
            .trim()
        );
      }

      if (cells.length < 6) continue;

      const round = cells[0];
      const sourceField = cells[1];
      const organization = cells[2];
      const amountStr = cells[3];
      const receivingCharity = cells[4];
      const purpose = cells[5];

      if (!organization || !round) continue;

      const amount = parseSFFAmount(amountStr);
      const isoDate = sffRoundToDate(round);
      const granteeId = matchGrantee(organization, matcher);

      const name = purpose && purpose !== "General support"
        ? purpose.substring(0, 500)
        : `Grant to ${organization}`.substring(0, 500);

      const notesParts: string[] = [];
      notesParts.push(`Round: ${round}`);
      notesParts.push(`Source: ${sourceField}`);
      if (receivingCharity && receivingCharity !== organization) {
        notesParts.push(`Receiving charity: ${receivingCharity}`);
      }
      if (amountStr.includes("+") || amountStr.includes("and")) {
        notesParts.push(`Raw amount: ${amountStr}`);
      }
      if (amountStr.includes("\u2021")) {
        notesParts.push("Includes matching pledge funding (\u2021)");
      }

      grants.push({
        source: "sff",
        funderId: FUNDER_IDS.SFF,
        granteeName: organization,
        granteeId,
        name,
        amount,
        date: isoDate,
        focusArea: null,
        description: notesParts.join("; ").substring(0, 4000),
      });
    }

    return grants;
  },

  printAnalysis(grants: RawGrant[]) {
    const byRound = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const round = g.description?.match(/Round: ([^;]+)/)?.[1] || "unknown";
      const entry = byRound.get(round) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byRound.set(round, entry);
    }
    console.log("\nBy round:");
    for (const [round, data] of [...byRound.entries()].sort()) {
      console.log(`  ${round}: ${data.count} grants ($${(data.total / 1e6).toFixed(1)}M)`);
    }
  },
};
