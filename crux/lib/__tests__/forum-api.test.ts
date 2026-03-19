import { describe, it, expect } from 'vitest';
import { postPermalink, postAuthors, EA_FORUM, LESSWRONG } from '../forum-api.ts';
import type { ForumPost } from '../forum-api.ts';

const mockPost: ForumPost = {
  _id: 'abc123',
  title: 'Test Post',
  slug: 'test-post',
  postedAt: '2024-01-15T10:00:00Z',
  baseScore: 42,
  voteCount: 50,
  user: { displayName: 'Alice', slug: 'alice' },
  coauthors: [{ displayName: 'Bob', slug: 'bob' }],
};

describe('postPermalink', () => {
  it('builds EA Forum permalink', () => {
    expect(postPermalink(EA_FORUM, mockPost)).toBe(
      'https://forum.effectivealtruism.org/posts/abc123/test-post'
    );
  });

  it('builds LessWrong permalink', () => {
    expect(postPermalink(LESSWRONG, mockPost)).toBe(
      'https://www.lesswrong.com/posts/abc123/test-post'
    );
  });

  it('never uses linkpost URL field', () => {
    const linkpost = { ...mockPost, url: 'https://external-site.com/article' };
    expect(postPermalink(EA_FORUM, linkpost)).toBe(
      'https://forum.effectivealtruism.org/posts/abc123/test-post'
    );
  });
});

describe('postAuthors', () => {
  it('returns primary author and coauthors', () => {
    expect(postAuthors(mockPost)).toEqual(['Alice', 'Bob']);
  });

  it('returns empty array for posts with no user', () => {
    const noUser = { ...mockPost, user: undefined, coauthors: undefined };
    expect(postAuthors(noUser)).toEqual([]);
  });

  it('handles post with only primary author', () => {
    const soloAuthor = { ...mockPost, coauthors: [] };
    expect(postAuthors(soloAuthor)).toEqual(['Alice']);
  });
});
