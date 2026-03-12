import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { execSync } from "child_process";
import { matchGrantee } from "../entity-matcher.ts";
import type { GrantSource, EntityMatcher, RawGrant } from "../types.ts";
import { FUNDER_IDS } from "../constants.ts";

const MANIFUND_API_URL = "https://manifund.org/api/v0/projects";
const MANIFUND_CACHE_PATH = "/tmp/manifund-projects.json";

export interface ManifundProject {
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

  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

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

      process.stdout.write(JSON.stringify(allProjects));
      await browser.close();
    })().catch(e => { process.stderr.write('ERROR: ' + e.message + '\\n'); process.exit(1); });
  `;

  try {
    const result = execSync(
      `node -e ${JSON.stringify(script)}`,
      { maxBuffer: 50 * 1024 * 1024, timeout: 120_000, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }
    );

    const projects: ManifundProject[] = JSON.parse(result);
    console.log(`  Downloaded ${projects.length} projects`);

    writeFileSync(MANIFUND_CACHE_PATH, JSON.stringify(projects));
    return projects;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  Playwright fetch failed: ${msg}`);
    console.log("  Trying direct fetch as fallback...");
    return await fetchManifundDirect();
  }
}

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

/** Parse Manifund projects into RawGrant format. Only includes funded projects. */
export function parseManifundProjects(
  projects: ManifundProject[],
  matcher: EntityMatcher,
): RawGrant[] {
  const grants: RawGrant[] = [];

  for (const project of projects) {
    const totalFunding = project.txns
      .filter(t => t.token === "USD" && t.amount > 0)
      .reduce((sum, t) => sum + t.amount, 0);

    if (totalFunding <= 0) continue;

    const creatorName = project.profiles?.full_name
      || project.profiles?.username
      || "Unknown";

    const granteeId = matchGrantee(creatorName, matcher);

    let isoDate: string | null = null;
    if (project.created_at) {
      const dateMatch = project.created_at.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        isoDate = dateMatch[1];
      }
    }

    const focusArea = project.causes.length > 0
      ? project.causes.map(c => c.title).join(", ")
      : null;

    const sourceUrl = `https://manifund.org/projects/${project.slug}`;

    grants.push({
      source: "manifund",
      funderId: FUNDER_IDS.MANIFUND,
      granteeName: creatorName,
      granteeId,
      name: project.title.substring(0, 500),
      amount: Math.round(totalFunding * 100) / 100,
      date: isoDate,
      focusArea,
      description: project.blurb || null,
      sourceUrl,
    });
  }

  return grants;
}

export const source: GrantSource = {
  id: "manifund",
  name: "Manifund",
  sourceUrl: "https://manifund.org",

  async ensureData() {
    await fetchManifundProjects();
  },

  async parse(matcher: EntityMatcher): Promise<RawGrant[]> {
    console.log("Fetching Manifund projects...");
    const projects = await fetchManifundProjects();
    console.log(`  Total projects from API: ${projects.length}`);
    return parseManifundProjects(projects, matcher);
  },

  printAnalysis(grants: RawGrant[]) {
    // Top funded projects
    const sorted = [...grants].sort((a, b) => (b.amount || 0) - (a.amount || 0));
    console.log(`\nTop 20 funded projects:`);
    for (const g of sorted.slice(0, 20)) {
      const matchLabel = g.granteeId ? ` [${g.granteeId}]` : "";
      console.log(`  $${((g.amount || 0) / 1000).toFixed(1)}k — ${g.name.slice(0, 60)} (${g.granteeName})${matchLabel}`);
    }

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
  },
};
