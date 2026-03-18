/**
 * Fetch EA Forum / LessWrong posts for an author and create resources.
 *
 * Usage:
 *   pnpm tsx crux/scripts/fetch-forum-posts.ts --slug=ozziegooen --entity=quri
 *   pnpm tsx crux/scripts/fetch-forum-posts.ts --slug=ozziegooen --entity=quri --apply
 */

import 'dotenv/config';

interface ForumPost {
  _id: string;
  title: string;
  slug: string;
  postedAt: string;
  baseScore: number;
  voteCount: number;
  url?: string;
  user?: { displayName: string; slug: string };
  coauthors?: { displayName: string; slug: string }[];
}

interface Forum {
  name: string;
  url: string;
  baseUrl: string;
}

const FORUMS: Forum[] = [
  { name: 'EA Forum', url: 'https://forum.effectivealtruism.org/graphql', baseUrl: 'https://forum.effectivealtruism.org' },
  { name: 'LessWrong', url: 'https://www.lesswrong.com/graphql', baseUrl: 'https://www.lesswrong.com' },
];

async function graphql(forumUrl: string, query: string): Promise<unknown> {
  const resp = await fetch(forumUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) throw new Error(`GraphQL error: ${resp.status}`);
  const body = await resp.json() as { errors?: { message?: string }[] };
  if (body.errors?.length) {
    throw new Error(
      body.errors.map((err) => err.message ?? 'Unknown GraphQL error').join('; ')
    );
  }
  return body;
}

async function getUserId(forum: Forum, slug: string): Promise<{ id: string; name: string } | null> {
  const data = await graphql(forum.url, `query {
    user(input: { selector: { slug: "${slug}" } }) {
      result { _id displayName slug }
    }
  }`) as { data?: { user?: { result?: { _id: string; displayName: string } } } };

  const user = data?.data?.user?.result;
  if (!user) return null;
  return { id: user._id, name: user.displayName };
}

async function getUserPosts(forum: Forum, userId: string, pageSize = 100): Promise<ForumPost[]> {
  const allPosts: ForumPost[] = [];
  let offset = 0;

  while (true) {
    const data = await graphql(forum.url, `query {
      posts(input: {
        terms: {
          userId: "${userId}",
          limit: ${pageSize},
          offset: ${offset},
          sortedBy: "top"
        }
      }) {
        results {
          _id title slug postedAt baseScore voteCount url
          user { displayName slug }
          coauthors { displayName slug }
        }
        totalCount
      }
    }`) as { data?: { posts?: { results?: ForumPost[]; totalCount?: number } } };

    const page = data?.data?.posts?.results ?? [];
    const totalCount = data?.data?.posts?.totalCount ?? 0;
    allPosts.push(...page);

    if (page.length === 0 || allPosts.length >= totalCount) break;
    offset += pageSize;
  }

  return allPosts;
}

function postToResourceUrl(forum: Forum, post: ForumPost): string {
  return `${forum.baseUrl}/posts/${post._id}/${post.slug}`;
}

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

  const allPosts: { forum: Forum; post: ForumPost }[] = [];

  for (const forum of FORUMS) {
    const user = await getUserId(forum, authorSlug);
    if (!user) {
      console.log(`  ${forum.name}: user "${authorSlug}" not found`);
      continue;
    }
    console.log(`  ${forum.name}: found ${user.name} (${user.id})`);

    const posts = await getUserPosts(forum, user.id);
    const filtered = posts.filter(p => p.baseScore >= minScore);
    console.log(`  ${forum.name}: ${posts.length} total posts, ${filtered.length} with score >= ${minScore}\n`);

    for (const post of filtered) {
      allPosts.push({ forum, post });
    }
  }

  // Deduplicate by URL (cross-posted content)
  const seen = new Set<string>();
  const unique = allPosts.filter(({ forum, post }) => {
    const url = postToResourceUrl(forum, post);
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });

  console.log(`\n  Total unique posts: ${unique.length}\n`);

  // Display them
  for (const { forum, post } of unique) {
    const url = postToResourceUrl(forum, post);
    const date = post.postedAt?.substring(0, 10) || '?';
    const authors = [
      post.user?.displayName,
      ...(post.coauthors?.map(c => c.displayName) || []),
    ].filter(Boolean);
    console.log(`  [${post.baseScore}] ${date} ${post.title}`);
    console.log(`    ${url}`);
    console.log(`    Authors: ${authors.join(', ')}`);
    console.log();
  }

  if (!apply) {
    console.log(`\n  Run with --apply to create ${unique.length} resources.`);
    return;
  }

  // Create resources via wiki-server API
  const { apiRequest } = await import('../lib/wiki-server/client.ts');
  const { hashId, guessResourceType } = await import('../resource-utils.ts');

  let created = 0;
  let errors = 0;

  for (const { forum, post } of unique) {
    const url = postToResourceUrl(forum, post);
    const id = hashId(url);
    const date = post.postedAt?.substring(0, 10) || undefined;
    const authors = [
      post.user?.displayName,
      ...(post.coauthors?.map(c => c.displayName) || []),
    ].filter(Boolean);

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
      // Rate limit
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
