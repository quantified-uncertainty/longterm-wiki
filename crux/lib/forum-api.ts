/**
 * EA Forum / LessWrong GraphQL API client.
 *
 * Fetches posts by user slug from EA Forum and LessWrong.
 * Used by crux/scripts/fetch-forum-posts.ts and available for other tools.
 */

export interface ForumPost {
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

export interface Forum {
  name: string;
  graphqlUrl: string;
  baseUrl: string;
}

export const EA_FORUM: Forum = {
  name: 'EA Forum',
  graphqlUrl: 'https://forum.effectivealtruism.org/graphql',
  baseUrl: 'https://forum.effectivealtruism.org',
};

export const LESSWRONG: Forum = {
  name: 'LessWrong',
  graphqlUrl: 'https://www.lesswrong.com/graphql',
  baseUrl: 'https://www.lesswrong.com',
};

export const ALIGNMENT_FORUM: Forum = {
  name: 'Alignment Forum',
  graphqlUrl: 'https://www.alignmentforum.org/graphql',
  baseUrl: 'https://www.alignmentforum.org',
};

export const ALL_FORUMS: Forum[] = [EA_FORUM, LESSWRONG];
export const ALL_FORUMS_WITH_AF: Forum[] = [EA_FORUM, LESSWRONG, ALIGNMENT_FORUM];

/** Execute a GraphQL query against a forum API. Retries on 429 with backoff. */
export async function forumGraphql(
  forumUrl: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(forumUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (resp.status === 429 && attempt < maxRetries) {
      const delay = (attempt + 1) * 5000; // 5s, 10s, 15s
      console.warn(`    Rate limited (429), retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    if (!resp.ok) throw new Error(`GraphQL HTTP error: ${resp.status}`);
    const body = await resp.json() as { errors?: { message?: string }[] };
    if (body.errors?.length) {
      throw new Error(
        body.errors.map((err) => err.message ?? 'Unknown GraphQL error').join('; ')
      );
    }
    return body;
  }
  throw new Error('GraphQL request failed after retries');
}

/** Look up a user's internal ID by their slug. Returns null if not found. */
export async function getUserId(forum: Forum, slug: string): Promise<{ id: string; name: string } | null> {
  const data = await forumGraphql(forum.graphqlUrl, `query GetUser($slug: String!) {
    user(input: { selector: { slug: $slug } }) {
      result { _id displayName slug }
    }
  }`, { slug }) as { data?: { user?: { result?: { _id: string; displayName: string } } } };

  const user = data?.data?.user?.result;
  if (!user) return null;
  return { id: user._id, name: user.displayName };
}

/** Fetch all posts by a user, paginating through results. */
export async function getUserPosts(forum: Forum, userId: string, pageSize = 100): Promise<ForumPost[]> {
  const allPosts: ForumPost[] = [];
  let offset = 0;

  while (true) {
    const data = await forumGraphql(forum.graphqlUrl, `query GetPosts($userId: String!, $limit: Int!, $offset: Int!) {
      posts(input: {
        terms: {
          userId: $userId,
          limit: $limit,
          offset: $offset,
          sortedBy: "top"
        }
      }) {
        results {
          _id title slug postedAt baseScore voteCount
          user { displayName slug }
          coauthors { displayName slug }
        }
        totalCount
      }
    }`, { userId, limit: pageSize, offset }) as { data?: { posts?: { results?: ForumPost[]; totalCount?: number } } };

    const page = data?.data?.posts?.results ?? [];
    const totalCount = data?.data?.posts?.totalCount ?? 0;
    allPosts.push(...page);

    if (page.length === 0 || allPosts.length >= totalCount) break;
    offset += pageSize;
  }

  return allPosts;
}

/**
 * Fetch posts globally (not per-user) with karma threshold and date window.
 * Uses half-year date windows to stay under the ~2500 skip limit.
 */
export async function getGlobalPosts(
  forum: Forum,
  options: {
    karmaThreshold?: number;
    after?: string;
    before?: string;
    sortedBy?: string;
    limit?: number;
    pageSize?: number;
    delayMs?: number;
    onPage?: (count: number, lastKarma: number) => void;
  } = {},
): Promise<ForumPost[]> {
  const karmaThreshold = Math.floor(Number(options.karmaThreshold) || 10);
  const after = options.after ?? '2015-01-01';
  const before = options.before ?? new Date().toISOString().slice(0, 10);
  const sortedBy = options.sortedBy ?? 'top';
  const maxTotal = options.limit ?? Infinity;
  const pageSize = options.pageSize ?? 500;
  const delayMs = options.delayMs ?? 300;

  // Generate half-year windows to stay under skip limit (~2500)
  const windows: { after: string; before: string }[] = [];
  const startYear = parseInt(after.slice(0, 4));
  const endDate = before;
  for (let y = startYear; ; y++) {
    const h1Start = `${y}-01-01`;
    const h1End = `${y}-07-01`;
    const h2Start = `${y}-07-01`;
    const h2End = `${y + 1}-01-01`;

    if (h1Start >= endDate) break;
    if (h1End > after && h1Start < endDate) {
      windows.push({ after: h1Start < after ? after : h1Start, before: h1End > endDate ? endDate : h1End });
    }
    if (h2Start >= endDate) break;
    if (h2End > after && h2Start < endDate) {
      windows.push({ after: h2Start, before: h2End > endDate ? endDate : h2End });
    }
  }

  const allPosts: ForumPost[] = [];

  for (const window of windows) {
    if (allPosts.length >= maxTotal) break;

    let offset = 0;
    while (allPosts.length < maxTotal) {
      const remaining = maxTotal - allPosts.length;
      const thisPageSize = Math.min(pageSize, remaining);

      const data = await forumGraphql(forum.graphqlUrl, `query GetGlobalPosts($limit: Int!, $offset: Int!, $after: String, $before: String, $karmaThreshold: Int) {
        posts(input: {
          terms: {
            sortedBy: "${sortedBy}",
            limit: $limit,
            offset: $offset,
            after: $after,
            before: $before,
            karmaThreshold: $karmaThreshold
          }
        }) {
          results {
            _id title slug postedAt baseScore voteCount
            user { displayName slug }
            coauthors { displayName slug }
          }
        }
      }`, {
        limit: thisPageSize,
        offset,
        after: window.after,
        before: window.before,
        karmaThreshold,
      }) as { data?: { posts?: { results?: ForumPost[] } } };

      const page = data?.data?.posts?.results ?? [];
      if (page.length === 0) break;

      allPosts.push(...page);
      options.onPage?.(allPosts.length, page[page.length - 1].baseScore);

      if (page.length < thisPageSize) break;
      offset += page.length;

      // Throttle
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return allPosts.slice(0, maxTotal);
}

/** Build the canonical permalink for a forum post (never uses linkpost URL). */
export function postPermalink(forum: Forum, post: ForumPost): string {
  return `${forum.baseUrl}/posts/${post._id}/${post.slug}`;
}

/** Extract author display names from a post. */
export function postAuthors(post: ForumPost): string[] {
  return [
    post.user?.displayName,
    ...(post.coauthors?.map(c => c.displayName) || []),
  ].filter((name): name is string => !!name);
}

/**
 * Fetch all posts by an author across multiple forums.
 * Returns deduplicated posts sorted by score.
 */
export async function fetchAuthorPosts(
  authorSlug: string,
  options: { forums?: Forum[]; minScore?: number } = {},
): Promise<{ forum: Forum; post: ForumPost }[]> {
  const forums = options.forums ?? ALL_FORUMS;
  const minScore = options.minScore ?? 0;

  const allPosts: { forum: Forum; post: ForumPost }[] = [];

  for (const forum of forums) {
    const user = await getUserId(forum, authorSlug);
    if (!user) continue;

    const posts = await getUserPosts(forum, user.id);
    for (const post of posts) {
      if (post.baseScore >= minScore) {
        allPosts.push({ forum, post });
      }
    }
  }

  // Deduplicate by permalink, then sort by score descending
  const seen = new Set<string>();
  const deduped = allPosts.filter(({ forum, post }) => {
    const url = postPermalink(forum, post);
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  return deduped.sort((a, b) => (b.post.baseScore ?? 0) - (a.post.baseScore ?? 0));
}
