/**
 * Resource Enrichment — Forum Posts (LessWrong, AlignmentForum, EA Forum)
 *
 * Enriches forum post resources with karma, comment counts, tags, curated status,
 * and writes to the resource_forum_posts sub-table.
 */

import { loadResourcesPGFirst } from '../resource-io.ts';
import { extractForumSlug, sleep } from '../resource-utils.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import type { Resource } from '../resource-types.ts';
import type { CommandResult } from '../lib/cli.ts';
import { hostMatches } from '@longterm-wiki/url-utils';

// ── Forum GraphQL queries ───────────────────────────────────────────────────

interface ForumPostData {
  _id: string;
  title: string;
  slug: string;
  baseScore: number;
  voteCount: number;
  commentCount: number;
  postedAt: string;
  curatedDate: string | null;
  user: { displayName: string; slug: string } | null;
  coauthors: { displayName: string }[] | null;
  tags: { name: string; slug: string }[] | null;
  sequence: { title: string } | null;
}

const FORUM_QUERY = `
query PostById($id: String!) {
  post(input: {selector: {_id: $id}}) {
    result {
      _id
      title
      slug
      baseScore
      voteCount
      commentCount
      postedAt
      curatedDate
      user { displayName slug }
      coauthors { displayName }
      tags { name slug }
      sequence { title }
    }
  }
}
`;

function getForumEndpoint(url: string): { endpoint: string; forum: string } {
  if (hostMatches(url, 'forum.effectivealtruism.org')) {
    return { endpoint: 'https://forum.effectivealtruism.org/graphql', forum: 'eaforum' };
  }
  if (hostMatches(url, 'alignmentforum.org')) {
    return { endpoint: 'https://www.alignmentforum.org/graphql', forum: 'alignmentforum' };
  }
  return { endpoint: 'https://www.lesswrong.com/graphql', forum: 'lesswrong' };
}

async function fetchForumPostExtended(
  url: string,
  postId: string,
): Promise<{ forum: string; post: ForumPostData } | null> {
  const { endpoint, forum } = getForumEndpoint(url);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: FORUM_QUERY,
      variables: { id: postId },
    }),
  });

  if (!response.ok) return null;

  const data = await response.json() as {
    data?: { post?: { result?: ForumPostData } };
  };

  const post = data?.data?.post?.result;
  if (!post) return null;

  return { forum, post };
}

// ── Main enrichment ─────────────────────────────────────────────────────────

export async function enrichForumsCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const limit = (options.limit as number) || 200;
  const dryRun = options['dry-run'] as boolean;
  const verbose = options.verbose as boolean;

  console.log('📝 Forum Post Enrichment (LW/AF/EAF → resource_forum_posts)\n');
  if (dryRun) console.log('  DRY RUN — no changes will be written\n');

  const resources = await loadResourcesPGFirst();

  // Find forum post resources
  const forumResources = resources.filter((r) => {
    if (!r.url) return false;
    return extractForumSlug(r.url) !== null;
  });

  console.log(`  Found ${forumResources.length} forum post resources`);

  // Skip already-enriched/reviewed resources so we progress through the backlog
  // instead of re-processing the same first N resources every run.
  const unenriched = forumResources.filter((r) => {
    const s = r.enrichment_status;
    return !s || s === 'pending' || s === 'fetched' || s === 'classified';
  });
  console.log(`  ${unenriched.length} need enrichment (${forumResources.length - unenriched.length} already enriched/reviewed)`);

  const toProcess = unenriched.slice(0, limit);
  let enriched = 0;
  let failed = 0;

  const forumBatch: Array<{ resourceId: string } & Record<string, unknown>> = [];

  for (const r of toProcess) {
    const postId = extractForumSlug(r.url); // extracts post ID from URL (e.g., JPfJaXTDQKQQocc2f)
    if (!postId) continue;

    try {
      const result = await fetchForumPostExtended(r.url, postId);
      if (!result) {
        failed++;
        if (verbose) console.log(`  ✗ No data: ${r.title || r.url}`);
        continue;
      }

      const { forum, post } = result;

      const forumData: Record<string, unknown> = {
        resourceId: r.id,
        forum,
        forumPostId: post._id,
        forumSlug: post.slug,
        karma: post.baseScore,
        commentCount: post.commentCount,
        curated: post.curatedDate != null,
      };

      if (post.user) {
        forumData.authorUsername = post.user.slug;
      }

      if (post.tags && post.tags.length > 0) {
        forumData.forumTags = post.tags.map((t) => t.name);
      }

      if (post.sequence) {
        forumData.sequenceTitle = post.sequence.title;
      }

      forumBatch.push(forumData as { resourceId: string } & Record<string, unknown>);
      enriched++;

      if (verbose) {
        console.log(`  ✓ ${post.title} (karma: ${post.baseScore}, comments: ${post.commentCount})`);
      }

      // Rate limit — forums are generous but be polite
      await sleep(200);
    } catch (err) {
      failed++;
      if (verbose) {
        console.log(`  ✗ ${r.title || r.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`\n  Results: ${enriched} enriched, ${failed} failed`);

  // Write to sub-table via batch-details API
  if (!dryRun && forumBatch.length > 0) {
    console.log(`  Writing ${forumBatch.length} forum post records...`);

    for (let i = 0; i < forumBatch.length; i += 200) {
      const batch = forumBatch.slice(i, i + 200);
      // typed-client-ok: QUA-770 baseline — resource enrichment pipeline, internal write path
      const result = await apiRequest<{ ok: boolean; upserted: { forumPosts: number } }>(
        'POST',
        '/api/resources/batch-details',
        { forumPosts: batch },
        30000,
      );

      if (result.ok) {
        console.log(`  ✓ Batch ${Math.floor(i / 200) + 1}: ${result.data.upserted.forumPosts} forum posts written`);
      } else {
        console.error(`  ✗ Batch ${Math.floor(i / 200) + 1} failed: ${result.message}`);
      }
    }

    // Also update enrichment_status on the base resource
    const statusBatch = forumBatch.map((p) => ({
      id: p.resourceId,
      url: '', // will be COALESCED away
      enrichmentStatus: 'enriched',
    }));

    for (let i = 0; i < statusBatch.length; i += 200) {
      const batch = statusBatch.slice(i, i + 200);
      await apiRequest(
        'POST',
        '/api/resources/batch',
        { items: batch.map((b) => ({ ...b, url: resources.find((r) => r.id === b.id)?.url || '' })) },
        30000,
      );
    }
  }

  return { exitCode: 0, output: `Enriched ${enriched} forum posts` };
}
