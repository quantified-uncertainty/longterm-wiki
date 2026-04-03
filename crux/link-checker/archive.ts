/**
 * Archive.org lookup — find Wayback Machine snapshots for broken URLs.
 *
 * Uses the shared wayback module (crux/lib/wayback.ts) for API calls.
 */

import { sleep } from '../resource-utils.ts';
import { lookupWaybackSnapshot } from '../lib/wayback.ts';
import type { CheckResult } from './types.ts';

/** Look up archive.org snapshots for broken URLs. */
export async function lookupArchiveForBroken(results: CheckResult[]): Promise<void> {
  const broken = results.filter(r =>
    r.status === 'broken' || (r.status === 'error' && r.httpStatus === 0),
  );

  if (broken.length === 0) {
    console.log('  No broken URLs to look up on archive.org.');
    return;
  }

  console.log(`  Looking up ${broken.length} broken URLs on archive.org...`);

  let found = 0;
  for (let i = 0; i < broken.length; i++) {
    const result = broken[i];
    const snapshot = await lookupWaybackSnapshot(result.url);

    if (snapshot) {
      result.archiveUrl = snapshot.url;
      found++;
    }

    if ((i + 1) % 10 === 0) {
      process.stdout.write(`\r  Looked up ${i + 1}/${broken.length}...`);
    }

    await sleep(200);
  }

  console.log(`\r  Archive.org: ${found}/${broken.length} broken URLs have archived snapshots.${' '.repeat(20)}`);
}
