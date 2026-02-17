/**
 * GitHub PR Lookup
 *
 * Fetches PR metadata from the GitHub API and builds a branch→PR number map.
 * Used at build time to auto-populate PR links in change history entries,
 * so session logs don't need to manually include the PR number.
 *
 * Requires GITHUB_TOKEN environment variable. Gracefully returns an empty
 * map if the token is missing or the API is unreachable.
 */

const REPO = 'quantified-uncertainty/longterm-wiki';
const PER_PAGE = 100;
const MAX_PAGES = 3; // 300 PRs should cover all history

/**
 * Fetch all PRs from the GitHub API and return a Map of branch name → PR number.
 * When multiple PRs exist for the same branch, uses the highest (most recent) number.
 *
 * @returns {Promise<Map<string, number>>} branch name → PR number
 */
export async function fetchBranchToPrMap() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return new Map();
  }

  const branchToPr = new Map();

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://api.github.com/repos/${REPO}/pulls?state=all&per_page=${PER_PAGE}&page=${page}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
        },
      });

      if (!res.ok) {
        console.warn(`  github-pr-lookup: API returned ${res.status}, skipping PR enrichment`);
        return branchToPr;
      }

      const prs = await res.json();
      if (!Array.isArray(prs) || prs.length === 0) break;

      for (const pr of prs) {
        const branch = pr.head?.ref;
        const num = pr.number;
        if (branch && num) {
          const existing = branchToPr.get(branch);
          if (!existing || num > existing) {
            branchToPr.set(branch, num);
          }
        }
      }

      if (prs.length < PER_PAGE) break; // last page
    }
  } catch (err) {
    console.warn(`  github-pr-lookup: ${err.message}, skipping PR enrichment`);
  }

  return branchToPr;
}

/**
 * Enrich a pageId → ChangeEntry[] map with PR numbers from the GitHub API.
 * Entries that already have a `pr` field (from the session log **PR:** field)
 * are left unchanged. Entries without `pr` get it populated from the
 * branch→PR lookup.
 *
 * @param {Record<string, Array<{branch: string, pr?: number}>>} pageHistory
 * @param {Map<string, number>} branchToPr
 * @returns {number} count of entries enriched
 */
export function enrichWithPrNumbers(pageHistory, branchToPr) {
  let enriched = 0;
  for (const entries of Object.values(pageHistory)) {
    for (const entry of entries) {
      if (entry.pr !== undefined) continue; // already has PR from session log
      const prNum = branchToPr.get(entry.branch);
      if (prNum) {
        entry.pr = prNum;
        enriched++;
      }
    }
  }
  return enriched;
}
