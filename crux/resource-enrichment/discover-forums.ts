/**
 * Resource Discovery — Bulk import from LessWrong, EA Forum, and Alignment Forum.
 *
 * Fetches posts globally using the public GraphQL API, filtered by karma threshold
 * and date range. Creates resource records in the wiki-server database.
 *
 * Uses half-year date windows to stay under the ~2500 skip limit per query.
 * Deduplicates against existing resources by URL.
 *
 * Cost: $0 (free API, no auth required).
 */

import {
  EA_FORUM,
  LESSWRONG,
  ALIGNMENT_FORUM,
  ALL_FORUMS_WITH_AF,
  getGlobalPosts,
  postPermalink,
  postAuthors,
  type Forum,
  type ForumPost,
} from '../lib/forum-api.ts';
import { upsertResourceBatch, type UpsertResourceItem } from '../lib/wiki-server/resources.ts';
import { hashId } from '../resource-utils.ts';
import type { CommandResult } from '../lib/cli.ts';

const FORUM_MAP: Record<string, Forum> = {
  lw: LESSWRONG,
  lesswrong: LESSWRONG,
  eaf: EA_FORUM,
  'ea-forum': EA_FORUM,
  af: ALIGNMENT_FORUM,
  'alignment-forum': ALIGNMENT_FORUM,
};

const PUBLICATION_ID_MAP: Record<string, string> = {
  'EA Forum': 'ea-forum',
  'LessWrong': 'lesswrong',
  'Alignment Forum': 'alignment-forum',
};

const BATCH_SIZE = 200;

interface DiscoveredPost {
  forum: Forum;
  post: ForumPost;
  url: string;
  id: string;
}

export async function discoverForumsCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const karma = Number(options.karma) || 30;
  const after = (options.after as string) || '2015-01-01';
  const before = (options.before as string) || new Date().toISOString().slice(0, 10);
  const limit = Number(options.limit) || 50000;
  const apply = !!options.apply;
  const verbose = !!options.verbose;
  const forumsArg = (options.forums as string) || 'lw,eaf,af';

  const selectedForums = forumsArg.split(',').map(f => {
    const forum = FORUM_MAP[f.trim().toLowerCase()];
    if (!forum) throw new Error(`Unknown forum: ${f}. Valid: lw, eaf, af`);
    return forum;
  });

  console.log('🔍 Forum Bulk Discovery\n');
  console.log(`  Forums: ${selectedForums.map(f => f.name).join(', ')}`);
  console.log(`  Karma threshold: ≥${karma}`);
  console.log(`  Date range: ${after} to ${before}`);
  console.log(`  Max posts: ${limit.toLocaleString()}`);
  console.log(`  Mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

  // Phase 1: Discover posts from each forum
  const allDiscovered: DiscoveredPost[] = [];

  let remaining = limit;
  for (const forum of selectedForums) {
    if (remaining <= 0) break;
    console.log(`  Fetching from ${forum.name}...`);
    try {
      const posts = await getGlobalPosts(forum, {
        karmaThreshold: karma,
        after,
        before,
        limit: remaining,
        onPage: (count, lastKarma) => {
          process.stdout.write(`\r    ${count.toLocaleString()} posts so far (karma ≥${lastKarma})...`);
        },
      });
      process.stdout.write('\r');
      console.log(`    ${posts.length.toLocaleString()} posts from ${forum.name}                `);

      for (const post of posts) {
        const url = postPermalink(forum, post);
        allDiscovered.push({
          forum,
          post,
          url,
          id: hashId(url),
        });
      }
      remaining -= posts.length;
    } catch (e: unknown) {
      process.stdout.write('\r');
      console.warn(`    ✗ ${forum.name} failed: ${e instanceof Error ? e.message : String(e)}                `);
    }
  }

  console.log(`\n  Total discovered: ${allDiscovered.length.toLocaleString()}`);

  // Phase 2: Deduplicate by URL
  // LW and AF share many posts (cross-posts). Prefer AF URL for alignment content.
  const seen = new Map<string, DiscoveredPost>();
  const titleAuthorKey = (post: ForumPost) =>
    `${post.title?.toLowerCase().trim()}::${post.user?.displayName?.toLowerCase().trim() ?? ''}`;

  // Process AF first, then LW, then EAF — so AF takes priority for cross-posts
  const sorted = [...allDiscovered].sort((a, b) => {
    const order = { 'Alignment Forum': 0, 'LessWrong': 1, 'EA Forum': 2 };
    return (order[a.forum.name as keyof typeof order] ?? 3) - (order[b.forum.name as keyof typeof order] ?? 3);
  });

  for (const item of sorted) {
    const key = titleAuthorKey(item.post);
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }

  const deduped = [...seen.values()];
  const removedDups = allDiscovered.length - deduped.length;
  if (removedDups > 0) {
    console.log(`  Deduplicated: ${removedDups.toLocaleString()} cross-posts removed`);
  }
  console.log(`  Unique posts: ${deduped.length.toLocaleString()}`);

  // Phase 3: Show summary by forum
  const byForum = new Map<string, number>();
  for (const item of deduped) {
    byForum.set(item.forum.name, (byForum.get(item.forum.name) ?? 0) + 1);
  }
  for (const [name, count] of byForum) {
    console.log(`    ${name}: ${count.toLocaleString()}`);
  }

  // Show karma distribution
  const karmas = deduped.map(d => d.post.baseScore).sort((a, b) => a - b);
  if (karmas.length > 0) {
    console.log(`\n  Karma range: ${karmas[0]} – ${karmas[karmas.length - 1]}`);
    const p10 = karmas[Math.floor(karmas.length * 0.1)];
    const p50 = karmas[Math.floor(karmas.length * 0.5)];
    const p90 = karmas[Math.floor(karmas.length * 0.9)];
    console.log(`  Percentiles: p10=${p10}, p50=${p50}, p90=${p90}`);
  }

  if (!apply) {
    console.log(`\n  Run with --apply to create ${deduped.length.toLocaleString()} resources.`);
    return { exitCode: 0, output: `Discovered ${deduped.length} posts (dry run)` };
  }

  // Phase 4: Create resources via batch API
  console.log(`\n  Creating resources...`);

  let created = 0;
  let errors = 0;

  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
    const items: UpsertResourceItem[] = batch.map(({ forum, post, url, id }) => {
      const authors = postAuthors(post);
      const date = post.postedAt?.substring(0, 10) || undefined;
      return {
        id,
        url,
        title: post.title,
        type: 'blog' as const,
        authors: authors.length > 0 ? authors : undefined,
        publishedDate: date,
        publicationId: PUBLICATION_ID_MAP[forum.name] ?? undefined,
      };
    });

    const result = await upsertResourceBatch(items);
    if (result.ok) {
      created += result.data.upserted;
      if (verbose) {
        console.log(`    Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.data.upserted} upserted`);
      }
    } else {
      errors += batch.length;
      console.error(`    ✗ Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${result.message}`);
    }

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < deduped.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n  ✓ Created/updated ${created.toLocaleString()} resources${errors > 0 ? `, ${errors} errors` : ''}`);

  return {
    exitCode: errors > 0 ? 1 : 0,
    output: `Discovered ${deduped.length} posts, created ${created} resources`,
  };
}
