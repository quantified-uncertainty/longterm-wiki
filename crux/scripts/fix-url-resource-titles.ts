/**
 * Fix 10 URL-derived resource titles on legislation pages.
 *
 * These resources had titles derived from URL slugs instead of proper article names.
 * This script updates them via the wiki-server API.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod npx tsx crux/scripts/fix-url-resource-titles.ts
 *   WIKI_SERVER_ENV=prod npx tsx crux/scripts/fix-url-resource-titles.ts --dry-run
 *
 * Closes #2816
 */

import 'dotenv/config';
import { apiRequest } from '../lib/wiki-server/client.ts';

interface ResourceFix {
  id: string;
  url: string;
  title: string;
  type: string | null;
  stableId: string | null;
}

const fixes: ResourceFix[] = [
  {
    id: "134c62f84c36d583",
    url: "https://www.nytimes.com/2024/09/29/technology/california-ai-safety-bill-veto.html",
    title: "California Governor Vetoes Landmark A.I. Safety Bill",
    type: "web",
    stableId: "LvyJa0hnXg",
  },
  {
    id: "2647ee59fd776e4b",
    url: "https://www.washingtonpost.com/technology/2024/09/29/california-ai-bill-sb1047-newsom-veto/",
    title: "California Gov. Newsom vetoes AI safety bill SB 1047",
    type: "web",
    stableId: "tte7S8rHAg",
  },
  {
    id: "4647ddd8b9cac7b5",
    url: "https://www.lawfaremedia.org/article/sb-1047-and-the-future-of-frontier-ai-safety-regulation",
    title: "SB 1047 and the Future of Frontier AI Safety Regulation",
    type: "web",
    stableId: "d0lbbqP4wg",
  },
  {
    id: "9187b18768c0e05a",
    url: "https://www.wired.com/story/ai-employees-letter-sb-1047-newsom/",
    title: "Over 100 AI Employees Wrote to Gov. Newsom Urging Him to Sign SB 1047",
    type: "web",
    stableId: "a90RRZkCGg",
  },
  {
    id: "9bcf97f47b585a6b",
    url: "https://hai.stanford.edu/news/analysis-proposed-safe-and-secure-innovation-frontier-artificial-intelligence-models-act",
    title: "Analysis of the Proposed Safe and Secure Innovation for Frontier Artificial Intelligence Models Act",
    type: "web",
    stableId: "DNTXWXm3UA",
  },
  {
    id: "9dce479615a37a41",
    url: "https://www.theverge.com/2024/9/29/24256529/california-governor-gavin-newsom-vetoes-ai-safety-bill-sb-1047",
    title: "California Governor Gavin Newsom vetoes AI safety bill SB 1047",
    type: "web",
    stableId: "gyj97Qa8AQ",
  },
  {
    id: "c69432c5238f280f",
    url: "https://www.vox.com/future-perfect/366040/california-ai-safety-bill-sb-1047-scott-wiener",
    title: "The fight over California's AI safety bill, explained",
    type: "web",
    stableId: "tLyDgkPpbA",
  },
  {
    id: "aa1edac7c8c30d83",
    url: "https://forum.effectivealtruism.org/posts/vhQBbzmSsLCkMRnGH/sb-1047-will-likely-be-signed-into-law-here-s-what-that-means",
    title: "SB 1047 will likely be signed into law. Here's what that means",
    type: "blog",
    stableId: "9GWtuZiHdw",
  },
  {
    id: "61d484269e6dbd8c",
    url: "https://carnegieendowment.org/posts/2024/10/california-sb1047-ai-safety-bill-veto-lessons?lang=en",
    title: "A Heated California Debate Offers Lessons for AI Safety Governance",
    type: "web",
    stableId: "NWE0M2UxZW",
  },
  {
    id: "9f90a50d63c2f1eb",
    url: "https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202320240SB1047",
    title: "SB-1047 Safe and Secure Innovation for Frontier Artificial Intelligence Models Act",
    type: "government",
    stableId: "NDJhYWFlOD",
  },
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`\nFixing ${fixes.length} URL-derived resource titles${dryRun ? ' (DRY RUN)' : ''}\n`);

  let success = 0;
  let errors = 0;

  for (const fix of fixes) {
    console.log(`  ${fix.id}: "${fix.title}"`);
    console.log(`    URL: ${fix.url}`);

    if (dryRun) {
      console.log(`    [DRY RUN] Would update title\n`);
      continue;
    }

    try {
      // typed-client-ok: QUA-770 baseline — one-shot maintenance script
      const result = await apiRequest<{ id: string }>(
        'POST',
        '/api/resources',
        {
          id: fix.id,
          url: fix.url,
          title: fix.title,
          type: fix.type,
          stableId: fix.stableId,
        },
      );

      if (result.ok) {
        console.log(`    Updated successfully\n`);
        success++;
      } else {
        console.error(`    FAILED: ${result.message}\n`);
        errors++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    ERROR: ${msg}\n`);
      errors++;
    }
  }

  console.log(`\nDone: ${success} updated, ${errors} errors`);
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("fix-url-resource-titles crashed:", err);
  process.exit(1);
});
