/**
 * Import grants from external sources into wiki-server Postgres.
 *
 * Sources:
 *   1. Coefficient Giving (Open Philanthropy) grants archive CSV
 *   2. EA Funds public grants CSV
 *   3. Manifund projects API (via Playwright for Vercel challenge bypass)
 *
 * Usage:
 *   pnpm crux import-grants analyze                # Preview CG + EA Funds
 *   pnpm crux import-grants sync                   # Import CG + EA Funds
 *   pnpm crux import-grants sync --dry-run         # Show what would be synced
 *   pnpm crux import-grants manifund-analyze       # Preview Manifund projects
 *   pnpm crux import-grants manifund-sync          # Import Manifund to wiki-server
 *   pnpm crux import-grants manifund-sync --dry-run
 */

import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import { apiRequest, getServerUrl } from "../lib/wiki-server/client.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CG_CSV_URL =
  "https://coefficientgiving.org/wp-content/uploads/Coefficient-Giving-Grants-Archive.csv";
const EA_FUNDS_CSV_URL = "https://funds.effectivealtruism.org/api/grants";

const CG_CSV_PATH = "/tmp/coefficient-giving-grants.csv";
const EA_FUNDS_CSV_PATH = "/tmp/ea-funds-grants.csv";

/** Funder entity stableIds */
const FUNDER_IDS: Record<string, string> = {
  "coefficient-giving": "ULjDXpSLCI",
  ltff: "yA12C1KcjQ",
  // EA Funds sub-funds — we map to LTFF and other known entities
  "Long-Term Future Fund": "yA12C1KcjQ",
  "Animal Welfare Fund": "__AWF__", // placeholder — will be resolved
  "EA Infrastructure Fund": "__EAIF__",
  "Effective Altruism Infrastructure Fund": "__EAIF__",
  "Global Health and Development Fund": "__GHDF__",
};

/** Manifund entity stableId and config */
const MANIFUND_FUNDER_ID = "fFVOuFZCRf";
const MANIFUND_API_URL = "https://manifund.org/api/v0/projects";
const MANIFUND_CACHE_PATH = "/tmp/manifund-projects.json";

/** Batch size for sync API calls */
const SYNC_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (line[i] === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += line[i];
    }
  }
  fields.push(current);
  return fields;
}

/** Reassemble multi-line CSV rows (Details field may contain newlines) */
function reassembleCSVRows(text: string): string[] {
  const lines = text.split("\n");
  const rows: string[] = [];
  let currentRow = "";
  let inQuotes = false;
  for (const line of lines.slice(1)) {
    // skip header
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
    }
    currentRow += (currentRow ? "\n" : "") + line;
    if (!inQuotes) {
      if (currentRow.trim()) rows.push(currentRow);
      currentRow = "";
    }
  }
  if (currentRow.trim()) rows.push(currentRow);
  return rows;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Generate a deterministic 10-char ID from input string */
function generateId(input: string): string {
  const hash = createHash("sha256").update(input).digest("base64url");
  return hash.substring(0, 10);
}

// ---------------------------------------------------------------------------
// Entity matching
// ---------------------------------------------------------------------------

interface EntityMatch {
  stableId: string;
  slug: string;
  name: string;
}

function buildEntityMatcher(): {
  match: (name: string) => EntityMatch | null;
  allNames: Map<string, EntityMatch>;
} {
  const nameMap = new Map<string, EntityMatch>();

  // Load KB data from kb-data.json (database.json strips the kb field)
  const kbDataPath = resolve("apps/web/src/data/kb-data.json");
  const kbData = JSON.parse(readFileSync(kbDataPath, "utf8"));
  const slugToId: Record<string, string> = kbData.slugToEntityId || {};
  const idToSlug = new Map<string, string>();
  for (const [slug, id] of Object.entries(slugToId)) {
    idToSlug.set(id as string, slug);
  }

  if (kbData.entities) {
    for (const [eid, entity] of Object.entries(
      kbData.entities as Record<string, { name?: string; aliases?: string[] }>
    )) {
      const slug = idToSlug.get(eid) || "";
      const match: EntityMatch = {
        stableId: eid,
        slug,
        name: entity.name || slug,
      };
      if (entity.name)
        nameMap.set(entity.name.toLowerCase().trim(), match);
      if (entity.aliases) {
        for (const alias of entity.aliases) {
          nameMap.set(alias.toLowerCase().trim(), match);
        }
      }
      if (slug) nameMap.set(slug.toLowerCase(), match);
    }
  }

  // Also load typedEntities from database.json for non-KB entities
  const dbPath = resolve("apps/web/src/data/database.json");
  const db = JSON.parse(readFileSync(dbPath, "utf8"));
  for (const e of db.typedEntities || []) {
    const slug = e.id;
    const stableId = slugToId[slug] || slug;
    const match: EntityMatch = {
      stableId,
      slug,
      name: e.title || slug,
    };
    if (e.title && !nameMap.has(e.title.toLowerCase().trim())) {
      nameMap.set(e.title.toLowerCase().trim(), match);
    }
    if (slug && !nameMap.has(slug.toLowerCase())) {
      nameMap.set(slug.toLowerCase(), match);
    }
  }

  return {
    allNames: nameMap,
    match: (name: string) => {
      const lower = name.toLowerCase().trim();
      return nameMap.get(lower) || null;
    },
  };
}

/** Manual name → slug overrides for known orgs that don't match automatically */
const MANUAL_GRANTEE_OVERRIDES: Record<string, string> = {
  // Common name mismatches
  "Center for Security and Emerging Technology": "cset",
  CSET: "cset",
  "Machine Intelligence Research Institute": "miri",
  MIRI: "miri",
  "Future of Humanity Institute": "fhi",
  "Centre for the Study of Existential Risk": "cser",
  GiveWell: "givewell",
  "Alignment Research Center": "arc",
  ARC: "arc",
  "Center for AI Safety": "center-for-ai-safety",
  "Center for Human-Compatible AI": "chai",
  CHAI: "chai",
  "Centre for Effective Altruism": "cea",
  "80,000 Hours": "80000-hours",
  "80000 Hours": "80000-hours",
  "Redwood Research": "redwood-research",
  Anthropic: "anthropic",
  OpenAI: "openai",
  "Survival and Flourishing Fund": "survival-and-flourishing-fund",
  BlueDot: "bluedot-impact",
  "BlueDot Impact": "bluedot-impact",
  Constellation: "constellation",
  "MATS Research": "mats",
  MATS: "mats",
  "Johns Hopkins Center for Health Security": "johns-hopkins-center-for-health-security",
  "Nuclear Threat Initiative": "nti-bio",
  "NTI | Bio": "nti-bio",
  Metaculus: "metaculus",
  "Center for Applied Rationality": "center-for-applied-rationality",
  "Longview Philanthropy": "longview-philanthropy",
  SecureBio: "securebio",
  Elicit: "elicit",
  "AI Safety Support": "ai-safety-support",
  "FAR AI": "far-ai",
  "Institute for AI Policy and Strategy": "iaps",
  RAND: "rand",
  "RAND Corporation": "rand",
  Manifund: "manifund",
  "GovAI": "govai",
  "Centre for Governance of AI (GovAI)": "govai",
  "Centre for Governance of AI": "govai",
  "Founders Pledge": "founders-pledge",
  "Good Ventures": "good-ventures",
  "Open Philanthropy": "coefficient-giving",
  "GiveDirectly": "givedirectly",
  "Effective Ventures Foundation": "cea",
  "Against Malaria Foundation": "against-malaria-foundation",
};

// ---------------------------------------------------------------------------
// Grant record types
// ---------------------------------------------------------------------------

interface RawGrant {
  source: "coefficient-giving" | "ea-funds" | "manifund";
  funderId: string; // stableId of funder entity
  granteeName: string;
  granteeId: string | null; // stableId if matched, else null
  name: string;
  amount: number | null;
  date: string | null;
  focusArea: string | null;
  description: string | null;
  /** URL to the source page (used for Manifund project URLs) */
  sourceUrl?: string | null;
}

interface SyncGrant {
  id: string;
  organizationId: string;
  granteeId: string | null;
  name: string;
  amount: number | null;
  currency: string;
  date: string | null;
  status: string | null;
  source: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// CSV parsing into RawGrant
// ---------------------------------------------------------------------------

function parseCoefficientGivingCSV(
  csvPath: string,
  matcher: ReturnType<typeof buildEntityMatcher>
): RawGrant[] {
  const text = readFileSync(csvPath, "utf8");
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

    // Match grantee
    let granteeId: string | null = null;
    const overrideSlug = MANUAL_GRANTEE_OVERRIDES[orgName];
    if (overrideSlug) {
      const match = matcher.match(overrideSlug);
      if (match) granteeId = match.stableId;
    }
    if (!granteeId) {
      const match = matcher.match(orgName);
      if (match) granteeId = match.stableId;
    }

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
      funderId: FUNDER_IDS["coefficient-giving"],
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
}

function parseEAFundsCSV(
  csvPath: string,
  matcher: ReturnType<typeof buildEntityMatcher>,
  eaFundEntityIds: Record<string, string>
): RawGrant[] {
  const text = readFileSync(csvPath, "utf8");
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
    if (grantee === "(Anonymous)") continue; // skip anonymous

    const amount = parseFloat(amountStr) || null;

    // Map fund to entity
    const funderId = eaFundEntityIds[fund];
    if (!funderId) continue;

    // Match grantee
    let granteeId: string | null = null;
    const overrideSlug = MANUAL_GRANTEE_OVERRIDES[grantee];
    if (overrideSlug) {
      const match = matcher.match(overrideSlug);
      if (match) granteeId = match.stableId;
    }
    if (!granteeId) {
      const match = matcher.match(grantee);
      if (match) granteeId = match.stableId;
    }

    // Date from round: "2025 Q3" → "2025-07", "2024 Q1" → "2024-01"
    let isoDate: string | null = null;
    if (round) {
      const m = round.match(/^(\d{4})\s+Q(\d)$/);
      if (m) {
        const qMonth: Record<string, string> = {
          "1": "01", "2": "04", "3": "07", "4": "10",
        };
        isoDate = `${m[1]}-${qMonth[m[2]] || "01"}`;
      }
    }
    if (!isoDate && year) {
      isoDate = year;
    }

    // Grant name: use description, truncated
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
}

// ---------------------------------------------------------------------------
// Convert to sync format
// ---------------------------------------------------------------------------

function toSyncGrant(raw: RawGrant): SyncGrant {
  // Generate deterministic ID from source + funder + grantee + date + amount
  const idInput = `${raw.source}|${raw.funderId}|${raw.granteeName}|${raw.date || ""}|${raw.amount || ""}|${raw.name.substring(0, 100)}`;
  const id = generateId(idInput);

  // granteeId: always store the human-readable name (max 200 chars).
  // The entity stableId is useful for linking but the grants table renders
  // this field directly, so it must always be a display name.
  const granteeId = raw.granteeName.substring(0, 200);

  // Truncate notes
  let notes: string | null = null;
  if (raw.focusArea && raw.description) {
    notes = `[${raw.focusArea}] ${raw.description}`.substring(0, 5000);
  } else if (raw.focusArea) {
    notes = raw.focusArea;
  } else if (raw.description) {
    notes = raw.description.substring(0, 5000);
  }

  return {
    id,
    organizationId: raw.funderId,
    granteeId,
    name: raw.name,
    amount: raw.amount,
    currency: "USD",
    date: raw.date,
    status: null,
    source:
      raw.sourceUrl
        ? raw.sourceUrl
        : raw.source === "coefficient-giving"
          ? "https://coefficientgiving.org/grants/"
          : "https://funds.effectivealtruism.org/grants",
    notes,
  };
}

// ---------------------------------------------------------------------------
// Download CSVs
// ---------------------------------------------------------------------------

function downloadCSVs() {
  console.log("Downloading Coefficient Giving CSV...");
  execSync(`curl -fsSL --retry 3 --connect-timeout 10 -o "${CG_CSV_PATH}" "${CG_CSV_URL}"`, {
    stdio: "inherit",
  });
  const cgSize = readFileSync(CG_CSV_PATH).length;
  console.log(`  → ${(cgSize / 1024).toFixed(0)} KB`);

  console.log("Downloading EA Funds CSV...");
  execSync(`curl -fsSL --retry 3 --connect-timeout 10 -o "${EA_FUNDS_CSV_PATH}" "${EA_FUNDS_CSV_URL}"`, {
    stdio: "inherit",
  });
  const eaSize = readFileSync(EA_FUNDS_CSV_PATH).length;
  console.log(`  → ${(eaSize / 1024).toFixed(0)} KB`);
}

// ---------------------------------------------------------------------------
// Sync to wiki-server
// ---------------------------------------------------------------------------

async function syncToServer(
  grants: SyncGrant[],
  dryRun: boolean
): Promise<void> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    console.error(
      "ERROR: wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
    process.exit(1);
  }

  console.log(`\nSyncing ${grants.length} grants to ${serverUrl}...`);

  if (dryRun) {
    console.log("  (dry run — no data written)");
    console.log(`  Would send ${Math.ceil(grants.length / SYNC_BATCH_SIZE)} batches of up to ${SYNC_BATCH_SIZE}`);
    return;
  }

  let totalUpserted = 0;
  let failedBatches = 0;
  for (let i = 0; i < grants.length; i += SYNC_BATCH_SIZE) {
    const batch = grants.slice(i, i + SYNC_BATCH_SIZE);
    const batchNum = Math.floor(i / SYNC_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(grants.length / SYNC_BATCH_SIZE);

    console.log(
      `  Batch ${batchNum}/${totalBatches}: ${batch.length} grants...`
    );

    const result = await apiRequest<{ upserted: number }>(
      "POST",
      "/api/grants/sync",
      { items: batch },
    );

    if (result.ok) {
      totalUpserted += result.data.upserted;
      console.log(`    → ${result.data.upserted} upserted`);
    } else {
      failedBatches++;
      console.error(`    ✗ Batch ${batchNum} failed:`, result.error);
    }
  }

  console.log(`\nTotal upserted: ${totalUpserted}`);
  if (failedBatches > 0) {
    throw new Error(`${failedBatches} grant sync batch(es) failed`);
  }
}

// ---------------------------------------------------------------------------
// Manifund API types and fetching
// ---------------------------------------------------------------------------

interface ManifundProject {
  title: string;
  id: string;
  created_at: string;
  creator: string;
  slug: string;
  blurb: string;
  description: string;
  stage: string;
  funding_goal: number | null;
  min_funding: number | null;
  type: string;
  profiles: { username: string; full_name: string } | null;
  txns: Array<{ amount: number; token: string }>;
  bids: Array<{ amount: number; status: string }>;
  causes: Array<{ title: string; slug: string }>;
}

/**
 * Fetch all Manifund projects using Playwright to bypass Vercel security checkpoint.
 * Results are cached to /tmp/manifund-projects.json for subsequent runs.
 */
async function fetchManifundProjects(): Promise<ManifundProject[]> {
  // Try reading from cache first (less than 1 hour old)
  if (existsSync(MANIFUND_CACHE_PATH)) {
    const stat = statSync(MANIFUND_CACHE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 3600_000) {
      console.log(`  Using cached data (${(ageMs / 60_000).toFixed(0)}m old)`);
      return JSON.parse(readFileSync(MANIFUND_CACHE_PATH, "utf8"));
    }
  }

  console.log("  Fetching from Manifund API via Playwright...");
  console.log("  (Manifund uses Vercel security checkpoint — requires headless browser)");

  // Use a child process to run Playwright since it may not be in the project's
  // node_modules but is available globally via npx
  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      // Navigate to homepage to pass Vercel security challenge
      await page.goto('https://manifund.org/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(5000);

      let allProjects = [];
      let before = null;
      let pageNum = 0;

      while (true) {
        pageNum++;
        const url = before
          ? '/api/v0/projects?before=' + encodeURIComponent(before)
          : '/api/v0/projects';

        const text = await page.evaluate(async (u) => {
          const resp = await fetch(u);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.text();
        }, url);

        const data = JSON.parse(text);
        process.stderr.write('  Page ' + pageNum + ': ' + data.length + ' projects\\n');

        if (data.length === 0) break;
        allProjects = allProjects.concat(data);

        before = data[data.length - 1].created_at;
        if (data.length < 100) break;
      }

      // Write to stdout as JSON
      process.stdout.write(JSON.stringify(allProjects));
      await browser.close();
    })().catch(e => { process.stderr.write('ERROR: ' + e.message + '\\n'); process.exit(1); });
  `;

  try {
    const result = execSync(
      `NODE_PATH=/opt/homebrew/lib/node_modules node -e ${JSON.stringify(script)}`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 120_000, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }
    );

    const projects: ManifundProject[] = JSON.parse(result);
    console.log(`  Downloaded ${projects.length} projects`);

    // Cache the results
    writeFileSync(MANIFUND_CACHE_PATH, JSON.stringify(projects));
    return projects;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    // If Playwright fails, try direct fetch as fallback (works when Vercel isn't blocking)
    console.warn(`  Playwright fetch failed: ${msg}`);
    console.log("  Trying direct fetch as fallback...");
    return await fetchManifundDirect();
  }
}

/**
 * Fallback: try to fetch Manifund API directly without Playwright.
 * Works when Vercel isn't enforcing their security checkpoint.
 */
async function fetchManifundDirect(): Promise<ManifundProject[]> {
  const allProjects: ManifundProject[] = [];
  let before: string | null = null;
  let pageNum = 0;

  while (true) {
    pageNum++;
    const url = before
      ? `${MANIFUND_API_URL}?before=${encodeURIComponent(before)}`
      : MANIFUND_API_URL;

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Manifund API returned HTTP ${response.status}. Try again later or use cached data.`);
    }

    const data: ManifundProject[] = await response.json();
    console.log(`  Page ${pageNum}: ${data.length} projects`);

    if (data.length === 0) break;
    allProjects.push(...data);

    before = data[data.length - 1].created_at;
    if (data.length < 100) break;
  }

  console.log(`  Downloaded ${allProjects.length} projects`);
  writeFileSync(MANIFUND_CACHE_PATH, JSON.stringify(allProjects));
  return allProjects;
}

/**
 * Parse Manifund projects into RawGrant format.
 * Only includes projects that received funding (have positive txns).
 */
function parseManifundProjects(
  projects: ManifundProject[],
  matcher: ReturnType<typeof buildEntityMatcher>
): RawGrant[] {
  const grants: RawGrant[] = [];

  for (const project of projects) {
    // Calculate total funding from USD txns
    const totalFunding = project.txns
      .filter(t => t.token === "USD" && t.amount > 0)
      .reduce((sum, t) => sum + t.amount, 0);

    // Skip unfunded projects
    if (totalFunding <= 0) continue;

    // Creator name from profiles
    const creatorName = project.profiles?.full_name
      || project.profiles?.username
      || "Unknown";

    // Match grantee to entity
    let granteeId: string | null = null;
    const overrideSlug = MANUAL_GRANTEE_OVERRIDES[creatorName];
    if (overrideSlug) {
      const match = matcher.match(overrideSlug);
      if (match) granteeId = match.stableId;
    }
    if (!granteeId) {
      const match = matcher.match(creatorName);
      if (match) granteeId = match.stableId;
    }

    // Parse date from created_at ISO string
    let isoDate: string | null = null;
    if (project.created_at) {
      // "2024-03-15T12:00:00.000Z" → "2024-03-15"
      const dateMatch = project.created_at.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        isoDate = dateMatch[1];
      }
    }

    // Build cause area string from causes
    const focusArea = project.causes.length > 0
      ? project.causes.map(c => c.title).join(", ")
      : null;

    // Project page URL
    const sourceUrl = `https://manifund.org/projects/${project.slug}`;

    grants.push({
      source: "manifund",
      funderId: MANIFUND_FUNDER_ID,
      granteeName: creatorName,
      granteeId,
      name: project.title.substring(0, 500),
      amount: Math.round(totalFunding * 100) / 100, // round to cents
      date: isoDate,
      focusArea,
      description: project.blurb || null,
      sourceUrl,
    });
  }

  return grants;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function resolveEAFundEntityIds(
  matcher: ReturnType<typeof buildEntityMatcher>
): Record<string, string> {
  // Map EA Fund names to entity stableIds
  // For funds without their own entities, we use the umbrella org
  const ltff = matcher.match("ltff");
  const cea = matcher.match("cea");

  return {
    "Long-Term Future Fund": ltff?.stableId || "yA12C1KcjQ",
    // AWF, EAIF, GH&D don't have their own entity files;
    // use CEA as the parent org (EA Funds is a CEA program)
    "Animal Welfare Fund": cea?.stableId || "gNsqAes7Dw",
    "EA Infrastructure Fund": cea?.stableId || "gNsqAes7Dw",
    "Effective Altruism Infrastructure Fund": cea?.stableId || "gNsqAes7Dw",
    "Global Health and Development Fund": cea?.stableId || "gNsqAes7Dw",
  };
}

async function cmdAnalyze() {
  // Ensure CSVs exist
  if (!existsSync(CG_CSV_PATH) || !existsSync(EA_FUNDS_CSV_PATH)) {
    downloadCSVs();
  }

  const matcher = buildEntityMatcher();
  const eaFundIds = resolveEAFundEntityIds(matcher);

  const cgGrants = parseCoefficientGivingCSV(CG_CSV_PATH, matcher);
  const eaGrants = parseEAFundsCSV(EA_FUNDS_CSV_PATH, matcher, eaFundIds);
  const allGrants = [...cgGrants, ...eaGrants];

  // Stats
  const matched = allGrants.filter((g) => g.granteeId !== null);
  const unmatched = allGrants.filter((g) => g.granteeId === null);
  const cgTotal = cgGrants.reduce((s, g) => s + (g.amount || 0), 0);
  const eaTotal = eaGrants.reduce((s, g) => s + (g.amount || 0), 0);

  console.log("=== Grant Import Analysis ===\n");
  console.log(`Coefficient Giving: ${cgGrants.length} grants ($${(cgTotal / 1e9).toFixed(2)}B)`);
  console.log(`EA Funds: ${eaGrants.length} grants ($${(eaTotal / 1e6).toFixed(1)}M)`);
  console.log(`Total: ${allGrants.length} grants ($${((cgTotal + eaTotal) / 1e9).toFixed(2)}B)\n`);

  console.log(`Entity matching:`);
  console.log(`  Matched: ${matched.length} (${((matched.length / allGrants.length) * 100).toFixed(1)}%)`);
  console.log(`  Unmatched: ${unmatched.length} (stored as display names)\n`);

  // Unique grantees
  const granteeNames = new Set(allGrants.map((g) => g.granteeName));
  const matchedNames = new Set(matched.map((g) => g.granteeName));
  console.log(`Unique grantee names: ${granteeNames.size}`);
  console.log(`Matched to entities: ${matchedNames.size}`);

  // Top unmatched by total amount
  const unmatchedByOrg = new Map<string, { total: number; count: number }>();
  for (const g of unmatched) {
    const entry = unmatchedByOrg.get(g.granteeName) || {
      total: 0,
      count: 0,
    };
    entry.total += g.amount || 0;
    entry.count++;
    unmatchedByOrg.set(g.granteeName, entry);
  }

  const sortedUnmatched = [...unmatchedByOrg.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 30);

  console.log(`\nTop 30 unmatched grantees by amount:`);
  for (const [name, data] of sortedUnmatched) {
    console.log(
      `  $${(data.total / 1e6).toFixed(1)}M (${data.count} grants) — ${name}`
    );
  }

  // Check for ID collisions
  const syncGrants = allGrants.map(toSyncGrant);
  const idSet = new Set<string>();
  let collisions = 0;
  for (const g of syncGrants) {
    if (idSet.has(g.id)) collisions++;
    idSet.add(g.id);
  }
  console.log(`\nGenerated ${idSet.size} unique IDs (${collisions} collisions → would be deduped)`);

  // By funder
  const byFunder = new Map<string, number>();
  for (const g of syncGrants) {
    byFunder.set(g.organizationId, (byFunder.get(g.organizationId) || 0) + 1);
  }
  console.log(`\nGrants by funder entity:`);
  for (const [id, count] of [...byFunder.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id}: ${count} grants`);
  }
}

async function cmdSync(dryRun: boolean) {
  // Ensure CSVs exist
  if (!existsSync(CG_CSV_PATH) || !existsSync(EA_FUNDS_CSV_PATH)) {
    downloadCSVs();
  }

  const matcher = buildEntityMatcher();
  const eaFundIds = resolveEAFundEntityIds(matcher);

  const cgGrants = parseCoefficientGivingCSV(CG_CSV_PATH, matcher);
  const eaGrants = parseEAFundsCSV(EA_FUNDS_CSV_PATH, matcher, eaFundIds);
  const allGrants = [...cgGrants, ...eaGrants];

  console.log(`Parsed ${cgGrants.length} CG + ${eaGrants.length} EA Funds = ${allGrants.length} grants`);

  // Convert and deduplicate by ID
  const syncMap = new Map<string, SyncGrant>();
  for (const raw of allGrants) {
    const sync = toSyncGrant(raw);
    syncMap.set(sync.id, sync);
  }
  const syncGrants = [...syncMap.values()];
  console.log(`After dedup: ${syncGrants.length} unique grants`);

  await syncToServer(syncGrants, dryRun);
}

async function cmdManifundAnalyze() {
  console.log("=== Manifund Import Analysis ===\n");
  console.log("Fetching Manifund projects...");

  const projects = await fetchManifundProjects();
  console.log(`\nTotal projects from API: ${projects.length}`);

  // Stage breakdown
  const stages: Record<string, number> = {};
  for (const p of projects) {
    stages[p.stage] = (stages[p.stage] || 0) + 1;
  }
  console.log(`\nProjects by stage:`);
  for (const [stage, count] of Object.entries(stages).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${stage}: ${count}`);
  }

  // Type breakdown
  const types: Record<string, number> = {};
  for (const p of projects) {
    types[p.type] = (types[p.type] || 0) + 1;
  }
  console.log(`\nProjects by type:`);
  for (const [type, count] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  const matcher = buildEntityMatcher();
  const grants = parseManifundProjects(projects, matcher);

  const totalFunding = grants.reduce((s, g) => s + (g.amount || 0), 0);
  const matched = grants.filter(g => g.granteeId !== null);

  console.log(`\nFunded projects: ${grants.length}`);
  console.log(`Total funding: $${(totalFunding / 1e6).toFixed(2)}M`);
  console.log(`\nEntity matching:`);
  console.log(`  Matched: ${matched.length} (${grants.length > 0 ? ((matched.length / grants.length) * 100).toFixed(1) : 0}%)`);
  console.log(`  Unmatched: ${grants.length - matched.length} (stored as display names)`);

  // Top funded projects
  const sorted = [...grants].sort((a, b) => (b.amount || 0) - (a.amount || 0));
  console.log(`\nTop 20 funded projects:`);
  for (const g of sorted.slice(0, 20)) {
    const matchLabel = g.granteeId ? ` [${g.granteeId}]` : "";
    console.log(`  $${((g.amount || 0) / 1000).toFixed(1)}k — ${g.name.slice(0, 60)} (${g.granteeName})${matchLabel}`);
  }

  // Top unmatched
  const unmatchedByName = new Map<string, { total: number; count: number }>();
  for (const g of grants.filter(g => !g.granteeId)) {
    const entry = unmatchedByName.get(g.granteeName) || { total: 0, count: 0 };
    entry.total += g.amount || 0;
    entry.count++;
    unmatchedByName.set(g.granteeName, entry);
  }
  const sortedUnmatched = [...unmatchedByName.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 20);
  console.log(`\nTop 20 unmatched grantees by amount:`);
  for (const [name, data] of sortedUnmatched) {
    console.log(`  $${(data.total / 1000).toFixed(1)}k (${data.count} projects) — ${name}`);
  }

  // ID collision check
  const syncGrants = grants.map(toSyncGrant);
  const idSet = new Set<string>();
  let collisions = 0;
  for (const g of syncGrants) {
    if (idSet.has(g.id)) collisions++;
    idSet.add(g.id);
  }
  console.log(`\nGenerated ${idSet.size} unique IDs (${collisions} collisions)`);

  // Year breakdown
  const byYear: Record<string, number> = {};
  for (const g of grants) {
    const year = g.date?.slice(0, 4) || "unknown";
    byYear[year] = (byYear[year] || 0) + 1;
  }
  console.log(`\nFunded projects by year:`);
  for (const [year, count] of Object.entries(byYear).sort()) {
    console.log(`  ${year}: ${count}`);
  }
}

async function cmdManifundSync(dryRun: boolean) {
  console.log("Fetching Manifund projects...");
  const projects = await fetchManifundProjects();

  const matcher = buildEntityMatcher();
  const grants = parseManifundProjects(projects, matcher);

  console.log(`Parsed ${grants.length} funded Manifund projects from ${projects.length} total`);

  // Convert and deduplicate by ID
  const syncMap = new Map<string, SyncGrant>();
  for (const raw of grants) {
    const sync = toSyncGrant(raw);
    syncMap.set(sync.id, sync);
  }
  const syncGrants = [...syncMap.values()];
  console.log(`After dedup: ${syncGrants.length} unique grants`);

  await syncToServer(syncGrants, dryRun);
}

// ---------------------------------------------------------------------------
// Crux command exports
// ---------------------------------------------------------------------------

type CommandResult = { exitCode?: number; output?: string };

async function analyzeCommand(_args: string[], _options: Record<string, unknown>): Promise<CommandResult> {
  await cmdAnalyze();
  return { exitCode: 0 };
}

async function syncCommand(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options['dry-run'];
  await cmdSync(dryRun);
  return { exitCode: 0 };
}

async function downloadCommand(_args: string[], _options: Record<string, unknown>): Promise<CommandResult> {
  downloadCSVs();
  return { exitCode: 0 };
}

async function manifundAnalyzeCommand(_args: string[], _options: Record<string, unknown>): Promise<CommandResult> {
  await cmdManifundAnalyze();
  return { exitCode: 0 };
}

async function manifundSyncCommand(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options['dry-run'];
  await cmdManifundSync(dryRun);
  return { exitCode: 0 };
}

export const commands = {
  analyze: analyzeCommand,
  sync: syncCommand,
  download: downloadCommand,
  "manifund-analyze": manifundAnalyzeCommand,
  "manifund-sync": manifundSyncCommand,
  default: analyzeCommand,
};

export function getHelp(): string {
  return `
Import Grants — Import external grant databases into wiki-server Postgres

Commands:
  analyze              Preview CG + EA Funds import stats
  sync                 Import CG + EA Funds to wiki-server
  sync --dry-run       Show what would be synced without writing
  download             Just download the CSV files
  manifund-analyze     Preview Manifund projects import stats
  manifund-sync        Import Manifund projects to wiki-server
  manifund-sync --dry-run

Sources:
  - Coefficient Giving (Open Philanthropy) grants archive CSV
  - EA Funds public grants CSV
  - Manifund projects API (https://manifund.org)
`;
}
