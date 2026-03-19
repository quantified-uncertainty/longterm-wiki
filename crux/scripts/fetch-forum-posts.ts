/**
 * CLI: Fetch EA Forum / LessWrong posts for an author and create resources.
 *
 * Usage:
 *   pnpm tsx crux/scripts/fetch-forum-posts.ts --slug=ozziegooen --entity=quri
 *   pnpm tsx crux/scripts/fetch-forum-posts.ts --slug=ozziegooen --entity=quri --apply
 */

import 'dotenv/config';
import { fetchAuthorPosts, postPermalink, postAuthors } from '../lib/forum-api.ts';
import type { Forum, ForumPost } from '../lib/forum-api.ts';

async function main() {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      opts[key] = val ?? true;
    }
  }

  const authorSlug = opts.slug as string;
  const entityId = opts.entity as string;
  const apply = !!opts.apply;
  const minScore = Number(opts['min-score'] || 5);

  if (!authorSlug) {
    console.error('Usage: pnpm tsx crux/scripts/fetch-forum-posts.ts --slug=<author-slug> --entity=<entity-id> [--apply] [--min-score=5]');
    process.exit(1);
  }

  console.log(`\nFetching forum posts for user: ${authorSlug}`);
  console.log(`Entity: ${entityId || '(none — resources only)'}`);
  console.log(`Min score: ${minScore}`);
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

  const posts = await fetchAuthorPosts(authorSlug, { minScore });

  console.log(`  Total unique posts: ${posts.length}\n`);

  for (const { forum, post } of posts) {
    const url = postPermalink(forum, post);
    const date = post.postedAt?.substring(0, 10) || '?';
    const authors = postAuthors(post);
    console.log(`  [${post.baseScore}] ${date} ${post.title}`);
    console.log(`    ${url}`);
    console.log(`    Authors: ${authors.join(', ')}\n`);
  }

  if (!apply) {
    console.log(`\n  Run with --apply to create ${posts.length} resources.`);
    return;
  }

  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const { hashId } = await import('../resource-utils.ts');

  let created = 0;
  let errors = 0;

  for (const { forum, post } of posts) {
    const url = postPermalink(forum, post);
    const id = hashId(url);
    const date = post.postedAt?.substring(0, 10) || undefined;
    const authors = postAuthors(post);

    const resource = {
      id,
      url,
      title: post.title,
      type: 'web',
      authors: authors.length > 0 ? authors : null,
      publishedDate: date || null,
      tags: entityId ? [entityId] : null,
      stableId: null,
      summary: null,
      review: null,
      abstract: null,
      keyPoints: null,
      publicationId: forum.name === 'EA Forum' ? 'ea-forum' : 'lesswrong',
      localFilename: null,
      credibilityOverride: null,
      fetchedAt: null,
      contentHash: null,
      citedBy: null,
      archiveUrl: null,
    };

    try {
      const result = await apiRequest<{ id: string }>('POST', '/api/resources', resource);
      if (result.ok) {
        created++;
      } else {
        errors++;
        console.warn(`  ✗ ${post.title}: ${result.message}`);
      }
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      errors++;
      console.warn(`  ✗ ${post.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n  ✓ Created ${created} resources${errors > 0 ? `, ${errors} errors` : ''}.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
