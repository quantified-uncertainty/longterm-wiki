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

export const ALL_FORUMS: Forum[] = [EA_FORUM, LESSWRONG, ALIGNMENT_FORUM];

/** Execute a GraphQL query against a forum API. Throws on HTTP or GraphQL errors. */
export async function forumGraphql(
  forumUrl: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  const resp = await fetch(forumUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) throw new Error(`GraphQL HTTP error: ${resp.status}`);
  const body = await resp.json() as { errors?: { message?: string }[] };
  if (body.errors?.length) {
    throw new Error(
      body.errors.map((err) => err.message ?? 'Unknown GraphQL error').join('; ')
    );
  }
  return body;
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
