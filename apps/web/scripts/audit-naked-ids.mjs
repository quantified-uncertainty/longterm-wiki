/**
 * Naked / Missing ID Audit — public-page sweep (QUA-537)
 *
 * Paranoid Playwright sweep of public detail pages that looks for:
 *   1. Naked `sid_[A-Za-z0-9_-]{10}` stableIds leaking into user-visible text
 *   2. Bare10 legacy IDs in ID columns (should be 0 post-QUA-503)
 *   3. Raw column-name enum values (e.g. `publisher_entity_id` in Inference Source)
 *   4. Empty `ID` / `Slug` / `Resource ID` / `Stakeholder` / etc. cells
 *
 * Critically, this script EXPANDS COLLAPSED SECTIONS before scanning (by
 * clicking every `button` containing a lucide-chevron-right svg). The existing
 * Playwright spec at `apps/web/e2e/no-raw-ids.spec.ts` uses `innerText` which
 * skips collapsed content, which is why QUA-397's fix appeared complete while
 * the user-facing bug remained live. QUA-537 covers folding this behavior into
 * the spec; until then, this script is the regression check.
 *
 * Usage:
 *   node apps/web/scripts/audit-naked-ids.mjs                  # against prod
 *   BASE_URL=http://localhost:3001 node apps/web/scripts/audit-naked-ids.mjs
 *   SAMPLES=5 node apps/web/scripts/audit-naked-ids.mjs        # sample more detail pages per directory
 *
 * Output: human-readable report to stdout. Non-zero exit if the aggregate finds
 * any naked sids or column-name-as-value cells (empty-cell counts are reported
 * but don't fail — some are legit join-tables).
 *
 * NOT wired into CI or the build. Run manually during data-model-unwind work.
 * When QUA-537 ships, the e2e spec supersedes this; consider deleting the
 * script at that point.
 */

import playwrightPkg from "playwright";
const { chromium } = playwrightPkg;

const BASE = process.env.BASE_URL || "https://www.longtermwiki.com";
const SAMPLES_PER_DIR = parseInt(process.env.SAMPLES || "3", 10);

const SID_RE = /sid_[A-Za-z0-9_-]{10}\b/g;
const BARE10_RE = /\b[a-f0-9]{10}\b/g;
const COL_NAME_AS_VALUE = /^(publisher_entity_id|entity_id|parent_thing_id|source_table|source_id|resource_id|person_display_name|organization_display_name|stakeholder_display_name|target_entity_id|related_entity_id|lead_investor_display_name|company_display_name|person_id|organization_id|investor_id|company_id|stakeholder_id|lead_investor_id|grantor_id|recipient_id)$/;

// High-signal pages (user-named must-checks + diverse entity types).
// Update when canonical slugs change or new entity types get /data?tab=database.
const EXPLICIT_PAGES = [
  "/organizations/anthropic/data?tab=database",
  "/organizations/openai/data?tab=database",
  "/organizations/deepmind/data?tab=database",
  "/organizations/coefficient-giving/data?tab=database",
  "/organizations/open-philanthropy/data?tab=database",
  "/organizations/apollo-research/data?tab=database",
  "/organizations/redwood-research/data?tab=database",

  "/legislation/california-sb1047",
  "/legislation/california-sb1047/data?tab=database",
  "/legislation/eu-ai-act",
  "/legislation/eu-ai-act/data?tab=database",

  "/people/dario-amodei/data?tab=database",
  "/people/geoffrey-hinton/data?tab=database",
  "/people/sam-altman/data?tab=database",

  "/ai-models/claude-3-opus/data?tab=database",
  "/ai-models/gpt-4/data?tab=database",
  "/ai-models/gemini-1-5-pro/data?tab=database",

  "/benchmarks/gpqa-diamond",
  "/benchmarks/mmlu",
  "/benchmarks/swe-bench-verified",

  "/factbase/entity/anthropic",
  "/factbase/entity/openai",
];

const DIRECTORIES = [
  { path: "/grants" },
  { path: "/funding-programs" },
  { path: "/investments" },
  { path: "/funding-rounds" },
  { path: "/divisions" },
  { path: "/publications" },
  { path: "/events" },
  { path: "/approaches" },
  { path: "/legislation" },
  { path: "/projects" },
];

async function analyzeTables(page) {
  return await page.evaluate(
    ({ sidRe, colRe, bare10Re }) => {
      const sidPattern = new RegExp(sidRe, "g");
      const colPattern = new RegExp(colRe);
      const bare10Pattern = new RegExp(bare10Re, "g");
      const out = [];
      const tables = Array.from(document.querySelectorAll("table"));
      tables.forEach((table, ti) => {
        let label = "";
        let el = table.parentElement;
        for (let depth = 0; depth < 6 && el; depth++) {
          const h = el.querySelector("h2, h3, h4, .font-semibold, [class*=text-sm]");
          if (h && h !== table && h.innerText && h.innerText.length < 120) {
            label = h.innerText.trim();
            break;
          }
          el = el.parentElement;
        }
        const headers = Array.from(table.querySelectorAll("thead th, thead td")).map((th) =>
          th.innerText.trim(),
        );
        const idColumnIdxs = headers
          .map((h, i) => ({ h: h.trim(), i }))
          .filter((x) =>
            /^(id|slug|resource id|entity id|parent org|author|person|organization|stakeholder|company|investor|target)$/i.test(
              x.h,
            ),
          )
          .map((x) => x.i);
        const rows = Array.from(table.querySelectorAll("tbody tr"));
        let nakedSidCells = 0,
          nakedBare10Cells = 0,
          colNameAsValueCells = 0,
          emptyIdCells = 0;
        const emptyIdByCol = {};
        let sampledSid = "",
          sampledBare = "",
          sampledColName = "";
        rows.forEach((r) => {
          const cells = Array.from(r.querySelectorAll("td"));
          cells.forEach((c, ci) => {
            const text = c.innerText.trim();
            if (!text) return;
            if (sidPattern.test(text)) {
              nakedSidCells++;
              if (!sampledSid) sampledSid = text.slice(0, 80);
            }
            sidPattern.lastIndex = 0;
            if (colPattern.test(text)) {
              colNameAsValueCells++;
              if (!sampledColName)
                sampledColName = `${text} (col="${headers[ci] || "?"}")`.slice(0, 120);
            }
            if (idColumnIdxs.includes(ci) && bare10Pattern.test(text) && !/sid_/.test(text)) {
              nakedBare10Cells++;
              if (!sampledBare) sampledBare = text.slice(0, 80);
            }
            bare10Pattern.lastIndex = 0;
          });
          for (const idx of idColumnIdxs) {
            if (cells[idx]) {
              const v = cells[idx].innerText.trim();
              if (v === "\u2014" || v === "-" || v === "") {
                emptyIdCells++;
                const h = headers[idx] || "?";
                emptyIdByCol[h] = (emptyIdByCol[h] || 0) + 1;
              }
            }
          }
        });
        out.push({
          tableIndex: ti,
          label,
          headers,
          rowCount: rows.length,
          idColumnHeaders: idColumnIdxs.map((i) => headers[i]),
          nakedSidCells,
          nakedBare10Cells,
          colNameAsValueCells,
          emptyIdCells,
          emptyIdByCol,
          sampledSid,
          sampledBare,
          sampledColName,
        });
      });
      const bodyText = document.body.innerText || "";
      const pageSids = (bodyText.match(sidPattern) || []).slice(0, 8);
      return { tables: out, pageSids };
    },
    {
      sidRe: SID_RE.source,
      colRe: COL_NAME_AS_VALUE.source,
      bare10Re: BARE10_RE.source,
    },
  );
}

async function extractDetailLinks(page, prefix) {
  return await page.evaluate((pfx) => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const hrefs = anchors
      .map((a) => a.getAttribute("href"))
      .filter((h) => h && h.startsWith(pfx + "/") && h !== pfx + "/")
      .map((h) => h.split("?")[0].split("#")[0]);
    return [...new Set(hrefs)];
  }, prefix);
}

// Collapsible sections in EntityProfileViewer use React state (not <details>),
// so collapsed bodies aren't in the DOM. Clicking toggles them in.
async function expandAllCollapsibles(page) {
  for (let pass = 0; pass < 2; pass++) {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const b of buttons) {
        const svg = b.querySelector("svg");
        if (!svg) continue;
        const rect = b.getBoundingClientRect();
        if (rect.width < 200) continue;
        const cls = svg.getAttribute("class") || "";
        if (/chevron-right|lucide-chevron-right/i.test(cls)) {
          try {
            b.click();
          } catch {}
        }
      }
    });
    await page.waitForTimeout(500);
  }
}

async function scanPage(page, url) {
  const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  const status = resp?.status() ?? 0;
  if (status >= 400) return { status, error: `HTTP ${status}`, tables: [], pageSids: [] };
  await page.waitForTimeout(700);
  await expandAllCollapsibles(page);
  try {
    const tabCount = await page.locator("[role='tab']").count();
    for (let i = 0; i < Math.min(tabCount, 8); i++) {
      const t = page.locator("[role='tab']").nth(i);
      if (await t.isVisible()) {
        try {
          await t.click({ timeout: 2000 });
          await page.waitForTimeout(300);
          await expandAllCollapsibles(page);
        } catch {}
      }
    }
  } catch {}
  await page.waitForTimeout(400);
  const data = await analyzeTables(page);
  return { status, ...data };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  const discovered = [];
  for (const dir of DIRECTORIES) {
    try {
      await page.goto(BASE + dir.path, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(600);
      const links = await extractDetailLinks(page, dir.path);
      for (const href of links.slice(0, SAMPLES_PER_DIR)) discovered.push(href);
      process.stderr.write(`  DIR ${dir.path}: sampled ${Math.min(links.length, SAMPLES_PER_DIR)}\n`);
    } catch (e) {
      process.stderr.write(`  DIR ${dir.path}: ERR ${e.message}\n`);
    }
  }

  const allPaths = [...new Set([...EXPLICIT_PAGES, ...discovered])];
  process.stderr.write(`Total paths to scan: ${allPaths.length}\n\n`);

  const findings = [];
  for (const path of allPaths) {
    const url = BASE + path;
    try {
      const data = await scanPage(page, url);
      findings.push({ path, ...data });
      process.stderr.write(
        `  ${path} [${data.status || "?"}] tables=${(data.tables || []).length} bodySids=${(data.pageSids || []).length}\n`,
      );
    } catch (e) {
      findings.push({ path, error: e.message, tables: [], pageSids: [] });
      process.stderr.write(`  ${path} ERROR ${e.message}\n`);
    }
  }
  await browser.close();

  console.log("\n========== NAKED / MISSING ID AUDIT ==========");
  console.log(`Base: ${BASE}`);
  console.log(`Pages scanned: ${allPaths.length}\n`);
  let totalSid = 0,
    totalBare = 0,
    totalColName = 0,
    totalEmpty = 0,
    totalPageSids = 0,
    errors = 0;
  for (const f of findings) {
    if (f.error || (f.status && f.status >= 400)) {
      errors++;
      continue;
    }
    for (const t of f.tables || []) {
      totalSid += t.nakedSidCells;
      totalBare += t.nakedBare10Cells;
      totalColName += t.colNameAsValueCells;
      totalEmpty += t.emptyIdCells;
    }
    totalPageSids += (f.pageSids || []).length;
  }
  console.log("Aggregate:");
  console.log(`  Cells with naked sid_: ${totalSid}`);
  console.log(`  Cells with bare10 ids (in ID columns): ${totalBare}`);
  console.log(`  Cells showing column-name-as-value: ${totalColName}`);
  console.log(`  Empty cells in ID/Slug columns: ${totalEmpty}`);
  console.log(`  Pages with sid_ in body text: ${totalPageSids}`);
  console.log(`  Pages with errors / 4xx: ${errors}\n`);

  console.log("-- Per-page detail --");
  for (const f of findings) {
    const flags = [];
    if (f.error) flags.push(`ERROR: ${f.error}`);
    if (f.status && f.status >= 400) flags.push(`status=${f.status}`);
    const tableIssues = (f.tables || []).filter(
      (t) =>
        t.nakedSidCells > 0 ||
        t.nakedBare10Cells > 0 ||
        t.colNameAsValueCells > 0 ||
        t.emptyIdCells > 0,
    );
    if ((f.pageSids || []).length === 0 && tableIssues.length === 0 && !f.error) continue;
    console.log(`\n${f.path}  ${flags.join(" ")}`);
    if (f.pageSids && f.pageSids.length) {
      console.log(`  body sids: ${f.pageSids.join(", ")}`);
    }
    for (const t of tableIssues) {
      console.log(
        `  table "${t.label || "(no label)"}" [${t.headers.slice(0, 6).join("|")}] rows=${t.rowCount}`,
      );
      if (t.nakedSidCells)
        console.log(`    - ${t.nakedSidCells} naked sid_ cells (sample: ${t.sampledSid})`);
      if (t.nakedBare10Cells)
        console.log(`    - ${t.nakedBare10Cells} bare10 id cells (sample: ${t.sampledBare})`);
      if (t.colNameAsValueCells)
        console.log(
          `    - ${t.colNameAsValueCells} column-name-as-value cells (sample: ${t.sampledColName})`,
        );
      if (t.emptyIdCells) {
        const byCol = Object.entries(t.emptyIdByCol || {})
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        console.log(`    - ${t.emptyIdCells} empty cells in ID/link columns [${byCol}]`);
      }
    }
  }

  // Fail the run if the high-signal patterns remain live. Empty-cell counts
  // are informational only — some link-tables legitimately have no user-
  // facing ID column.
  if (totalSid > 0 || totalColName > 0 || totalBare > 0) {
    console.error(
      `\nFAIL: ${totalSid} naked sid_, ${totalBare} bare10, ${totalColName} column-name-as-value cells.`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
