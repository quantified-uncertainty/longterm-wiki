/**
 * Research Areas CLI — Link grants, backfill papers, discover orgs, and show stats.
 *
 * Usage:
 *   pnpm crux research-areas link-grants [--dry-run]
 *   pnpm crux research-areas backfill-papers [--dry-run]
 *   pnpm crux research-areas discover-orgs [--dry-run]
 *   pnpm crux research-areas stats
 */

import {
  matchResearchAreas,
  type ResearchAreaMatch,
} from "../lib/grant-import/research-area-matcher.ts";
import {
  batchedRequest,
  apiRequest,
  getServerUrl,
} from "../lib/wiki-server/client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GrantForMatching {
  id: string;
  name: string;
  notes: string | null;
  amount: number | null;
  organizationId: string;
  granteeId: string | null;
}

interface AllGrantsForMatchingResponse {
  grants: GrantForMatching[];
  total: number;
}

interface GrantLink {
  grantId: string;
  researchAreaId: string;
  confidence: number;
}

interface SyncGrantLinksResponse {
  upserted: number;
}

interface BackfillPapersResponse {
  inserted: number;
}

interface ResearchAreaEnriched {
  id: string;
  title: string;
  cluster: string | null;
  orgCount: number;
  paperCount: number;
  grantCount: number;
  totalFunding: string;
  riskCount: number;
}

interface EnrichedResponse {
  researchAreas: ResearchAreaEnriched[];
}

interface GrantDetail {
  id: string;
  name: string;
  amount: number | null;
  organizationId: string;
  granteeId: string | null;
}

interface AreaDetailResponse {
  id: string;
  title: string;
  organizations: Array<{ organizationId: string; role: string }>;
  grants: GrantDetail[];
  fundingByOrg: Array<{
    organizationId: string;
    grantCount: number;
    totalAmount: string;
  }>;
}

type CommandResult = { exitCode?: number; output?: string };

// ---------------------------------------------------------------------------
// Phase 1: Link Grants to Research Areas
// ---------------------------------------------------------------------------

const BATCH_SIZE = 1000;

async function linkGrants(dryRun: boolean): Promise<void> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
  }

  // 1. Fetch all grants
  console.log(`Fetching grants from ${serverUrl}...`);
  const result = await batchedRequest<AllGrantsForMatchingResponse>(
    "GET",
    "/api/grants/all-for-matching"
  );

  if (!result.ok) {
    throw new Error(`Failed to fetch grants: ${result.message}`);
  }

  const allGrants = result.data.grants;
  console.log(`  Total grants: ${allGrants.length}\n`);

  // 2. Match each grant to research areas
  console.log("Matching grants to research areas...");
  const allLinks: GrantLink[] = [];
  let matchedGrants = 0;
  let unmatchedGrants = 0;
  const areaCounts = new Map<string, { count: number; totalFunding: number }>();

  for (const grant of allGrants) {
    const matches: ResearchAreaMatch[] = matchResearchAreas({
      name: grant.name,
      description: grant.notes,
    });

    if (matches.length > 0) {
      matchedGrants++;
      for (const match of matches) {
        allLinks.push({
          grantId: grant.id,
          researchAreaId: match.researchAreaId,
          confidence: match.confidence,
        });
        const existing = areaCounts.get(match.researchAreaId) ?? {
          count: 0,
          totalFunding: 0,
        };
        existing.count++;
        existing.totalFunding += grant.amount ?? 0;
        areaCounts.set(match.researchAreaId, existing);
      }
    } else {
      unmatchedGrants++;
    }
  }

  // 3. Print summary
  console.log("\n=== Matching Results ===");
  console.log(`  Grants matched:    ${matchedGrants}`);
  console.log(`  Grants unmatched:  ${unmatchedGrants}`);
  console.log(`  Total links:       ${allLinks.length}`);
  console.log(
    `  Coverage:          ${((matchedGrants / allGrants.length) * 100).toFixed(1)}%\n`
  );

  // Show per-area breakdown
  const sorted = [...areaCounts.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log("=== Coverage by Research Area ===");
  for (const [areaId, { count, totalFunding }] of sorted) {
    const funding =
      totalFunding > 0
        ? ` ($${(totalFunding / 1_000_000).toFixed(1)}M)`
        : "";
    console.log(`  ${count.toString().padStart(5)} grants  ${areaId}${funding}`);
  }
  console.log("");

  // Show sample of unmatched grants (top 10 by amount)
  const unmatched = allGrants
    .filter(
      (g) =>
        matchResearchAreas({ name: g.name, description: g.notes }).length === 0
    )
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, 10);

  if (unmatched.length > 0) {
    console.log("Top 10 unmatched grants (by amount):");
    for (const g of unmatched) {
      const amt = g.amount ? `$${(g.amount / 1_000_000).toFixed(2)}M` : "N/A";
      console.log(`  ${amt.padStart(10)}  ${g.name.slice(0, 80)}`);
    }
    console.log("");
  }

  if (allLinks.length === 0) {
    console.log("No links to sync.");
    return;
  }

  if (dryRun) {
    console.log(
      `Dry run — would sync ${allLinks.length} grant-research-area links. Use without --dry-run to apply.`
    );
    return;
  }

  // 4. Batch POST to sync endpoint
  console.log(`Syncing ${allLinks.length} links...`);
  let totalUpserted = 0;
  let failedBatches = 0;

  for (let i = 0; i < allLinks.length; i += BATCH_SIZE) {
    const batch = allLinks.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allLinks.length / BATCH_SIZE);

    console.log(`  Batch ${batchNum}/${totalBatches}: ${batch.length} links...`);

    const syncResult = await batchedRequest<SyncGrantLinksResponse>(
      "POST",
      "/api/research-areas/sync-grant-links",
      { items: batch }
    );

    if (syncResult.ok) {
      totalUpserted += syncResult.data.upserted;
      console.log(`    -> ${syncResult.data.upserted} upserted`);
    } else {
      failedBatches++;
      console.error(`    x Batch ${batchNum} failed: ${syncResult.message}`);
    }
  }

  console.log(`\nTotal upserted: ${totalUpserted}`);
  if (failedBatches > 0) {
    throw new Error(`${failedBatches} batch(es) failed`);
  }
  console.log("Done.");
}

// ---------------------------------------------------------------------------
// Phase 2: Backfill Papers from Citations
// ---------------------------------------------------------------------------

async function backfillPapers(dryRun: boolean): Promise<void> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
  }

  if (dryRun) {
    console.log(
      "Dry run — would backfill research_area_papers from resource citations on wiki pages. Use without --dry-run to apply."
    );
    return;
  }

  console.log("Backfilling research_area_papers from resource citations...");
  const result = await batchedRequest<BackfillPapersResponse>(
    "POST",
    "/api/research-areas/backfill-papers-from-citations"
  );

  if (!result.ok) {
    throw new Error(`Failed to backfill papers: ${result.message}`);
  }

  console.log(`  Inserted: ${result.data.inserted} paper links`);
  console.log("Done.");
}

// ---------------------------------------------------------------------------
// Phase 3: Discover Organizations from Grant Data
// ---------------------------------------------------------------------------

async function discoverOrgs(dryRun: boolean): Promise<void> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
  }

  // Fetch enriched areas to find which have grants
  console.log("Fetching enriched research areas...");
  const areasResult = await batchedRequest<EnrichedResponse>(
    "GET",
    "/api/research-areas/enriched?limit=200"
  );

  if (!areasResult.ok) {
    throw new Error(`Failed to fetch research areas: ${areasResult.message}`);
  }

  const areas = areasResult.data.researchAreas.filter((a) => a.grantCount > 0);
  console.log(`  Areas with grants: ${areas.length}\n`);

  // For each area with grants, fetch detail to get grant granteeIds
  const orgLinks: Array<{
    researchAreaId: string;
    organizationId: string;
    role: string;
  }> = [];

  for (const area of areas) {
    const detailResult = await apiRequest<AreaDetailResponse>(
      "GET",
      `/api/research-areas/${area.id}`
    );
    if (!detailResult.ok) {
      console.warn(
        `  Warning: could not fetch detail for ${area.id}: ${detailResult.message}`
      );
      continue;
    }

    // Aggregate grantee activity from the fundingByOrg breakdown
    const detail = detailResult.data;

    for (const funder of detail.fundingByOrg) {
      const totalAmount = Number(funder.totalAmount);
      // Filter: >= 2 grants OR >= $100K
      if (funder.grantCount >= 2 || totalAmount >= 100_000) {
        // Check if already in organizations list
        const alreadyLinked = detail.organizations.some(
          (o) => o.organizationId === funder.organizationId
        );
        if (!alreadyLinked) {
          orgLinks.push({
            researchAreaId: area.id,
            organizationId: funder.organizationId,
            role: "funder",
          });
        }
      }
    }

    // Also discover grantee orgs
    const granteeAgg = new Map<
      string,
      { count: number; totalAmount: number }
    >();
    for (const grant of detail.grants) {
      if (!grant.granteeId) continue;
      const existing = granteeAgg.get(grant.granteeId) ?? {
        count: 0,
        totalAmount: 0,
      };
      existing.count++;
      existing.totalAmount += grant.amount ?? 0;
      granteeAgg.set(grant.granteeId, existing);
    }

    for (const [granteeId, agg] of granteeAgg) {
      if (agg.count >= 2 || agg.totalAmount >= 100_000) {
        const alreadyLinked = detail.organizations.some(
          (o) => o.organizationId === granteeId
        );
        if (!alreadyLinked) {
          orgLinks.push({
            researchAreaId: area.id,
            organizationId: granteeId,
            role: "active",
          });
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const deduped = orgLinks.filter((l) => {
    const key = `${l.researchAreaId}:${l.organizationId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`=== Org Discovery Results ===`);
  console.log(`  New org links found: ${deduped.length}\n`);

  if (deduped.length === 0) {
    console.log("No new org links to sync.");
    return;
  }

  // Show sample
  console.log("Sample (first 20):");
  for (const link of deduped.slice(0, 20)) {
    console.log(
      `  ${link.researchAreaId} <- ${link.organizationId} (${link.role})`
    );
  }
  if (deduped.length > 20) {
    console.log(`  ... and ${deduped.length - 20} more\n`);
  }

  if (dryRun) {
    console.log(
      `Dry run — would sync ${deduped.length} org links. Use without --dry-run to apply.`
    );
    return;
  }

  // Sync to server
  console.log(`Syncing ${deduped.length} org links...`);
  const syncResult = await batchedRequest<{ upserted: number }>(
    "POST",
    "/api/research-areas/sync-organizations",
    {
      items: deduped.map((l) => ({
        researchAreaId: l.researchAreaId,
        organizationId: l.organizationId,
        role: l.role,
      })),
    }
  );

  if (!syncResult.ok) {
    throw new Error(`Failed to sync org links: ${syncResult.message}`);
  }

  console.log(`  Upserted: ${syncResult.data.upserted}`);
  console.log("Done.");
}

// ---------------------------------------------------------------------------
// Phase 5: Stats Command
// ---------------------------------------------------------------------------

async function showStats(): Promise<void> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
  }

  console.log("Fetching research area stats...\n");

  const result = await batchedRequest<EnrichedResponse>(
    "GET",
    "/api/research-areas/enriched?limit=200"
  );

  if (!result.ok) {
    throw new Error(`Failed to fetch research areas: ${result.message}`);
  }

  const areas = result.data.researchAreas;

  // Overall stats
  const totalGrants = areas.reduce((s, a) => s + a.grantCount, 0);
  const totalFunding = areas.reduce(
    (s, a) => s + Number(a.totalFunding),
    0
  );
  const totalOrgs = areas.reduce((s, a) => s + a.orgCount, 0);
  const totalPapers = areas.reduce((s, a) => s + a.paperCount, 0);

  console.log("=== Overall Stats ===");
  console.log(`  Research areas:   ${areas.length}`);
  console.log(`  Total grant links: ${totalGrants}`);
  console.log(
    `  Total funding:    $${(totalFunding / 1_000_000).toFixed(1)}M`
  );
  console.log(`  Total org links:  ${totalOrgs}`);
  console.log(`  Total papers:     ${totalPapers}\n`);

  // Per-area breakdown (sorted by total funding)
  const sorted = [...areas].sort(
    (a, b) => Number(b.totalFunding) - Number(a.totalFunding)
  );

  console.log(
    "=== Per-Area Breakdown (sorted by funding) ==="
  );
  console.log(
    `${"Area".padEnd(35)} ${"Grants".padStart(7)} ${"Funding".padStart(12)} ${"Orgs".padStart(5)} ${"Papers".padStart(7)}`
  );
  console.log("-".repeat(70));

  for (const area of sorted) {
    const funding = Number(area.totalFunding);
    const fundingStr =
      funding > 0
        ? `$${(funding / 1_000_000).toFixed(1)}M`
        : "-";
    console.log(
      `${area.title.slice(0, 34).padEnd(35)} ${String(area.grantCount).padStart(7)} ${fundingStr.padStart(12)} ${String(area.orgCount).padStart(5)} ${String(area.paperCount).padStart(7)}`
    );
  }

  // Coverage gaps
  const noGrants = areas.filter((a) => a.grantCount === 0);
  if (noGrants.length > 0) {
    console.log(`\n=== Coverage Gaps (${noGrants.length} areas with 0 grants) ===`);
    for (const area of noGrants) {
      console.log(`  ${area.id} — ${area.title}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Crux command exports
// ---------------------------------------------------------------------------

async function linkGrantsCommand(
  _args: string[],
  options: Record<string, unknown>
): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  await linkGrants(dryRun);
  return { exitCode: 0 };
}

async function backfillPapersCommand(
  _args: string[],
  options: Record<string, unknown>
): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  await backfillPapers(dryRun);
  return { exitCode: 0 };
}

async function discoverOrgsCommand(
  _args: string[],
  options: Record<string, unknown>
): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  await discoverOrgs(dryRun);
  return { exitCode: 0 };
}

async function statsCommand(
  _args: string[],
  _options: Record<string, unknown>
): Promise<CommandResult> {
  await showStats();
  return { exitCode: 0 };
}

export const commands = {
  "link-grants": linkGrantsCommand,
  "backfill-papers": backfillPapersCommand,
  "discover-orgs": discoverOrgsCommand,
  stats: statsCommand,
  default: statsCommand,
};

export function getHelp(): string {
  return `
Research Areas — Link grants, backfill papers, discover orgs, and show stats

Commands:
  link-grants [--dry-run]      Match all grants to research areas and sync links
  backfill-papers [--dry-run]  Backfill papers from resource citations on wiki pages
  discover-orgs [--dry-run]    Discover orgs from grant data (funders + grantees)
  stats                        Show coverage stats (default)

Examples:
  pnpm crux research-areas stats
  pnpm crux research-areas link-grants --dry-run
  pnpm crux research-areas link-grants
  pnpm crux research-areas backfill-papers
  pnpm crux research-areas discover-orgs --dry-run
`;
}
