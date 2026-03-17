/**
 * Bill & Melinda Gates Foundation grant import adapter.
 *
 * Source: https://www.gatesfoundation.org/about/committed-grants
 * Format: CSV download (~40K grants, $97B+ total, 1994-present)
 * Fields: GRANT ID, GRANTEE, PURPOSE, DIVISION, DATE COMMITTED,
 *         DURATION (MONTHS), AMOUNT COMMITTED, GRANTEE WEBSITE,
 *         GRANTEE CITY, GRANTEE STATE, GRANTEE COUNTRY, REGION SERVED, TOPIC
 */

import { readFileSync } from "fs";
import { parseCSVLine, reassembleCSVRows } from "../csv.ts";
import { downloadIfMissing } from "../download.ts";
import { matchGrantee } from "../entity-matcher.ts";
import { matchProgram } from "../program-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

const CSV_URL =
  "https://www.gatesfoundation.org/-/media/files/bmgf-grants.csv";
const CSV_PATH = "/tmp/gates-foundation-grants.csv";

export const source: GrantSource = {
  id: "gates-foundation",
  name: "Gates Foundation",
  sourceUrl: "https://www.gatesfoundation.org/about/committed-grants",

  ensureData() {
    downloadIfMissing(CSV_URL, CSV_PATH, "Gates Foundation CSV");
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    const text = readFileSync(CSV_PATH, "utf8");
    const lines = reassembleCSVRows(text);
    const grants: RawGrant[] = [];

    // Skip the "Updated ..." header line and the column header line
    let startIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("GRANT ID,")) {
        startIdx = i + 1;
        break;
      }
    }

    for (let i = startIdx; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 7) continue;

      const grantId = fields[0]?.trim();
      const granteeName = fields[1]?.trim();
      const purpose = fields[2]?.trim();
      const division = fields[3]?.trim();
      const dateCommitted = fields[4]?.trim(); // "YYYY-MM" format
      // fields[5] = duration months (not used)
      const amountStr = (fields[6] || "").replace(/[$,"\r]/g, "").trim();
      // fields[7] = grantee website
      // fields[8-10] = city, state, country
      // fields[11] = region served
      const topic = fields[12]?.trim().replace(/\r/g, "") || null;

      if (!granteeName || !grantId) continue;

      const amount = parseFloat(amountStr) || null;
      const granteeId = matchGrantee(granteeName, matcher);

      // Date is already in ISO "YYYY-MM" format
      const isoDate = dateCommitted && /^\d{4}-\d{2}$/.test(dateCommitted)
        ? dateCommitted
        : null;

      const name = purpose
        ? `${purpose.substring(0, 490)}`
        : `Grant to ${granteeName}`.substring(0, 500);

      const notesParts: string[] = [];
      if (grantId) notesParts.push(`Grant ID: ${grantId}`);
      if (division) notesParts.push(`Division: ${division}`);
      if (topic) notesParts.push(`Topic: ${topic}`);
      const description = notesParts.length > 0
        ? notesParts.join("; ").substring(0, 4000)
        : null;

      const programId = matchProgram({
        source: "gates-foundation",
        funderId: FUNDER_IDS.GATES_FOUNDATION,
        focusArea: topic,
        name,
        description,
      });

      grants.push({
        source: "gates-foundation",
        funderId: FUNDER_IDS.GATES_FOUNDATION,
        granteeName,
        granteeId,
        name,
        amount,
        date: isoDate,
        focusArea: topic,
        description,
        sourceUrl: `https://www.gatesfoundation.org/about/committed-grants/${grantId}`,
        programId,
      });
    }

    return grants;
  },

  printAnalysis(grants: RawGrant[]) {
    const byTopic = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const topic = g.focusArea || "Unknown";
      const entry = byTopic.get(topic) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byTopic.set(topic, entry);
    }
    console.log("\nTop topics:");
    const sorted = [...byTopic.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [topic, data] of sorted.slice(0, 15)) {
      console.log(
        `  ${data.count.toString().padStart(5)} grants  $${(data.total / 1e9).toFixed(2)}B  ${topic}`
      );
    }
  },
};
