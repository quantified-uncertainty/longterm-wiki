/**
 * Wellcome Trust grant import adapter.
 *
 * Source: https://wellcome.org/grant-funding/funded-people-and-projects
 * Format: XLSX bulk download (~16.5 MB, tens of thousands of grants, 2000-2026)
 * Fields: Amount Awarded, Award Date, Lead Applicant, Recipient Organisation,
 *         Description/Title, Research Locations
 * Standard: 360Giving data standard
 *
 * Since the project has no XLSX parser dependency, we use Python's stdlib
 * (zipfile + xml.etree.ElementTree) to convert the XLSX to CSV. This avoids
 * adding a new npm dependency for a single adapter.
 */

import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { parseCSVLine, reassembleCSVRows } from "../csv.ts";
import { downloadIfMissing } from "../download.ts";
import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

const XLSX_URL =
  "https://cms.wellcome.org/sites/default/files/2026-02/Wellcome-grants-awarded-1-October-2000-to-27-January-2026.xlsx";
const XLSX_PATH = "/tmp/wellcome-grants.xlsx";
const CSV_PATH = "/tmp/wellcome-grants.csv";

/**
 * Convert XLSX to CSV using Python's stdlib (zipfile + xml.etree.ElementTree).
 *
 * XLSX files are ZIP archives containing XML files in the OpenXML format.
 * The shared strings are in xl/sharedStrings.xml, and the sheet data is in
 * xl/worksheets/sheet1.xml. Cell values reference shared string indices.
 *
 * This avoids requiring openpyxl, xlrd, or any npm xlsx package.
 */
function convertXlsxToCsv(xlsxPath: string, csvPath: string): void {
  console.log("  Converting XLSX to CSV via Python stdlib...");

  // Python script that parses XLSX (OpenXML) using only stdlib modules.
  // We read shared strings and the first worksheet, then output CSV.
  const pythonScript = `
import zipfile
import xml.etree.ElementTree as ET
import csv
import sys
import re

xlsx_path = sys.argv[1]
csv_path = sys.argv[2]

ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

with zipfile.ZipFile(xlsx_path, 'r') as z:
    # Parse shared strings
    shared_strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        ss_xml = z.read('xl/sharedStrings.xml')
        ss_tree = ET.fromstring(ss_xml)
        for si in ss_tree.findall('.//s:si', ns):
            # Shared string can have <t> directly or multiple <r><t> elements
            parts = []
            t_elem = si.find('s:t', ns)
            if t_elem is not None and t_elem.text:
                parts.append(t_elem.text)
            else:
                for r in si.findall('.//s:r', ns):
                    t = r.find('s:t', ns)
                    if t is not None and t.text:
                        parts.append(t.text)
            shared_strings.append(''.join(parts))

    # Find the first worksheet
    sheet_name = 'xl/worksheets/sheet1.xml'
    if sheet_name not in z.namelist():
        # Try to find any sheet
        sheets = [n for n in z.namelist() if n.startswith('xl/worksheets/sheet') and n.endswith('.xml')]
        if not sheets:
            print('ERROR: No worksheet found in XLSX', file=sys.stderr)
            sys.exit(1)
        sheet_name = sorted(sheets)[0]

    sheet_xml = z.read(sheet_name)
    sheet_tree = ET.fromstring(sheet_xml)

    # Parse styles to detect date-formatted cells
    date_format_ids = set()
    if 'xl/styles.xml' in z.namelist():
        styles_xml = z.read('xl/styles.xml')
        styles_tree = ET.fromstring(styles_xml)
        # Collect numFmt codes that look like dates
        date_fmt_codes = set()
        # Built-in date format IDs (Excel's predefined date formats)
        for fid in [14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31,
                     32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]:
            date_fmt_codes.add(fid)
        # Custom date formats
        nf_ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        for nf in styles_tree.findall('.//s:numFmt', nf_ns):
            code = nf.get('formatCode', '')
            nf_id = int(nf.get('numFmtId', '0'))
            if any(tok in code.lower() for tok in ['yy', 'mm', 'dd', 'date']):
                date_fmt_codes.add(nf_id)
        # Map cellXfs index to whether it's a date format
        for i, xf in enumerate(styles_tree.findall('.//s:cellXfs/s:xf', nf_ns)):
            fmt_id = int(xf.get('numFmtId', '0'))
            if fmt_id in date_fmt_codes:
                date_format_ids.add(i)

    def col_index(ref):
        """Convert cell reference like 'AB12' to 0-based column index."""
        col = ''
        for ch in ref:
            if ch.isalpha():
                col += ch
            else:
                break
        idx = 0
        for ch in col.upper():
            idx = idx * 26 + (ord(ch) - ord('A') + 1)
        return idx - 1

    def excel_date_to_iso(serial):
        """Convert Excel serial date number to ISO date string."""
        import datetime
        try:
            serial = float(serial)
            if serial < 1:
                return str(serial)
            # Excel epoch: 1899-12-30 (accounting for the 1900 leap year bug)
            base = datetime.date(1899, 12, 30)
            delta = datetime.timedelta(days=int(serial))
            d = base + delta
            return d.strftime('%Y-%m-%d')
        except (ValueError, OverflowError):
            return str(serial)

    rows = []
    max_col = 0
    for row_elem in sheet_tree.findall('.//s:sheetData/s:row', ns):
        row_data = {}
        for cell in row_elem.findall('s:c', ns):
            ref = cell.get('r', '')
            cell_type = cell.get('t', '')
            style_idx = int(cell.get('s', '0'))
            v_elem = cell.find('s:v', ns)
            if v_elem is None or v_elem.text is None:
                # Check for inline string
                is_elem = cell.find('s:is/s:t', ns)
                if is_elem is not None and is_elem.text:
                    value = is_elem.text
                else:
                    continue
            elif cell_type == 's':
                # Shared string reference
                idx = int(v_elem.text)
                value = shared_strings[idx] if idx < len(shared_strings) else ''
            elif cell_type == 'b':
                value = 'TRUE' if v_elem.text == '1' else 'FALSE'
            else:
                value = v_elem.text
                # Check if this is a date-formatted number
                if style_idx in date_format_ids and cell_type != 's':
                    try:
                        float(value)
                        value = excel_date_to_iso(value)
                    except ValueError:
                        pass

            ci = col_index(ref)
            row_data[ci] = value
            if ci > max_col:
                max_col = ci

        if row_data:
            rows.append(row_data)

    # Write CSV
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        for row_data in rows:
            row_list = []
            for ci in range(max_col + 1):
                row_list.append(row_data.get(ci, ''))
            writer.writerow(row_list)

    print(f'  -> Converted {len(rows)} rows to CSV', file=sys.stderr)
`;

  try {
    execFileSync("python3", ["-c", pythonScript, xlsxPath, csvPath], {
      stdio: ["pipe", "inherit", "inherit"],
      timeout: 120_000, // 2 minutes for large file
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to convert XLSX to CSV via Python. ` +
      `Ensure python3 is available. Error: ${msg}\n` +
      `Alternative: manually convert using 'ssconvert ${xlsxPath} ${csvPath}' ` +
      `or 'libreoffice --convert-to csv ${xlsxPath}'`
    );
  }
}

/**
 * Parse a Wellcome Trust date field.
 * The XLSX stores dates as Excel serial numbers which our converter turns into
 * ISO dates (YYYY-MM-DD). Some cells may have text dates like "01/10/2000".
 */
function parseWellcomeDate(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // ISO format from our converter: "2023-05-15"
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // ISO month: "2023-05"
  if (/^\d{4}-\d{2}$/.test(trimmed)) return trimmed;

  // Year only: "2023"
  if (/^\d{4}$/.test(trimmed)) return trimmed;

  // DD/MM/YYYY (UK format, common for Wellcome Trust)
  const ukMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ukMatch) {
    const day = ukMatch[1].padStart(2, "0");
    const month = ukMatch[2].padStart(2, "0");
    return `${ukMatch[3]}-${month}-${day}`;
  }

  return null;
}

/**
 * Detect column indices from the CSV header row.
 * Wellcome Trust uses 360Giving standard column names, but we search flexibly.
 */
function detectColumns(headers: string[]): {
  title: number;
  description: number;
  amount: number;
  currency: number;
  awardDate: number;
  recipientOrg: number;
  leadApplicant: number;
  focusArea: number;
} {
  const find = (patterns: RegExp[]): number => {
    for (const pat of patterns) {
      const idx = headers.findIndex((h) => pat.test(h));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  return {
    title: find([/^title$/i, /grant.*title/i, /^identifier/i]),
    description: find([/^description$/i, /project.*summary/i, /^summary$/i]),
    amount: find([/amount.*awarded/i, /^amount$/i, /award.*amount/i, /amount.*disbursed/i]),
    currency: find([/^currency$/i, /currency.*code/i]),
    awardDate: find([/award.*date/i, /^date$/i, /date.*awarded/i, /planned.*dates.*start/i]),
    recipientOrg: find([/recipient.*org.*name/i, /recipient.*organisation/i, /^recipient.*name/i, /organisation.*name/i]),
    leadApplicant: find([/lead.*applicant/i, /applicant.*name/i]),
    focusArea: find([/theme/i, /focus.*area/i, /research.*area/i, /subject/i, /grant.*programme.*title/i, /programme/i]),
  };
}

export const source: GrantSource = {
  id: "wellcome-trust",
  name: "Wellcome Trust",
  sourceUrl: "https://wellcome.org/grant-funding/funded-people-and-projects",

  ensureData() {
    downloadIfMissing(XLSX_URL, XLSX_PATH, "Wellcome Trust XLSX (16.5 MB)");

    if (!existsSync(CSV_PATH)) {
      convertXlsxToCsv(XLSX_PATH, CSV_PATH);
    } else {
      console.log("  CSV already exists at " + CSV_PATH);
    }
  },

  parse(matcher: EntityMatcher): RawGrant[] {
    if (!existsSync(CSV_PATH)) {
      console.warn("  Wellcome Trust CSV not found at " + CSV_PATH);
      return [];
    }

    const text = readFileSync(CSV_PATH, "utf8");

    // Detect headers from the first line
    const headerLine = text.split("\n")[0];
    const headers = parseCSVLine(headerLine).map((h) => h.toLowerCase().trim());
    const cols = detectColumns(headers);

    if (cols.recipientOrg === -1 && cols.leadApplicant === -1) {
      console.warn(
        "  WARNING: Could not find recipient/applicant column. Headers:",
        headers.filter((h) => h.length > 0)
      );
      return [];
    }

    const rows = reassembleCSVRows(text);
    const grants: RawGrant[] = [];

    for (const row of rows) {
      const fields = parseCSVLine(row);

      // Recipient organization name (fall back to lead applicant)
      const recipientOrg =
        (cols.recipientOrg >= 0 ? fields[cols.recipientOrg] : "")?.trim() || "";
      const leadApplicant =
        (cols.leadApplicant >= 0 ? fields[cols.leadApplicant] : "")?.trim() || "";
      const granteeName = recipientOrg || leadApplicant;
      if (!granteeName) continue;

      const title =
        (cols.title >= 0 ? fields[cols.title] : "")?.trim() || "";
      const description =
        (cols.description >= 0 ? fields[cols.description] : "")?.trim() || "";
      const amountStr =
        (cols.amount >= 0 ? fields[cols.amount] : "")
          ?.replace(/[£$,"\r]/g, "")
          .trim() || "";
      const currencyStr =
        (cols.currency >= 0 ? fields[cols.currency] : "")?.trim() || "";
      const dateStr =
        (cols.awardDate >= 0 ? fields[cols.awardDate] : "")?.trim() || "";
      const focusArea =
        (cols.focusArea >= 0 ? fields[cols.focusArea] : "")?.trim() || null;

      const amount = parseFloat(amountStr) || null;
      const currency = currencyStr.toUpperCase() || "GBP"; // Wellcome Trust awards in GBP
      const isoDate = parseWellcomeDate(dateStr);
      const granteeId = matchGrantee(granteeName, matcher);

      const name = title
        ? title.substring(0, 500)
        : `Grant to ${granteeName}`.substring(0, 500);

      const notesParts: string[] = [];
      if (leadApplicant && recipientOrg) {
        notesParts.push(`Lead Applicant: ${leadApplicant}`);
      }
      if (description) {
        notesParts.push(description);
      }
      const descriptionText =
        notesParts.length > 0
          ? notesParts.join("; ").substring(0, 4000)
          : null;

      grants.push({
        source: "wellcome-trust",
        funderId: FUNDER_IDS.WELLCOME_TRUST,
        granteeName,
        granteeId,
        name,
        amount,
        currency,
        date: isoDate,
        focusArea,
        description: descriptionText,
      });
    }

    return grants;
  },

  printAnalysis(grants: RawGrant[]) {
    if (grants.length === 0) {
      console.log("\n  No Wellcome Trust grants parsed.");
      return;
    }

    // Currency breakdown
    const byCurrency = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const cur = g.currency || "GBP";
      const entry = byCurrency.get(cur) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byCurrency.set(cur, entry);
    }
    console.log("\nBy currency:");
    for (const [cur, data] of [...byCurrency.entries()].sort(
      (a, b) => b[1].total - a[1].total
    )) {
      console.log(
        `  ${cur}: ${data.count} grants, ${(data.total / 1e9).toFixed(2)}B`
      );
    }

    // Year breakdown
    const byYear = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const year = g.date ? g.date.substring(0, 4) : "Unknown";
      const entry = byYear.get(year) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byYear.set(year, entry);
    }
    console.log("\nBy year (top 10):");
    const sortedYears = [...byYear.entries()].sort(
      (a, b) => b[1].total - a[1].total
    );
    for (const [year, data] of sortedYears.slice(0, 10)) {
      console.log(
        `  ${year}: ${data.count.toString().padStart(5)} grants, ${(data.total / 1e6).toFixed(1)}M`
      );
    }

    // Top recipients
    const byOrg = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const entry = byOrg.get(g.granteeName) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byOrg.set(g.granteeName, entry);
    }
    console.log("\nTop 15 recipients by total funding:");
    const sortedOrgs = [...byOrg.entries()].sort(
      (a, b) => b[1].total - a[1].total
    );
    for (const [org, data] of sortedOrgs.slice(0, 15)) {
      console.log(
        `  ${data.count.toString().padStart(5)} grants  ${(data.total / 1e6).toFixed(1)}M  ${org}`
      );
    }

    // Focus area breakdown
    const byFocus = new Map<string, { count: number; total: number }>();
    for (const g of grants) {
      const area = g.focusArea || "Unknown";
      const entry = byFocus.get(area) || { count: 0, total: 0 };
      entry.count++;
      entry.total += g.amount || 0;
      byFocus.set(area, entry);
    }
    console.log("\nTop 10 focus areas:");
    const sortedFocus = [...byFocus.entries()].sort(
      (a, b) => b[1].total - a[1].total
    );
    for (const [area, data] of sortedFocus.slice(0, 10)) {
      console.log(
        `  ${data.count.toString().padStart(5)} grants  ${(data.total / 1e6).toFixed(1)}M  ${area}`
      );
    }
  },
};
