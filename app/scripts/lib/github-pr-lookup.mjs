/**
 * GitHub PR Lookup
 *
 * Fetches PR metadata from the GitHub API and builds:
 * 1. A branch→PR number map (used to enrich change history entries)
 * 2. A full PR items array (used by the PR Descriptions dashboard)
 *
 * Requires GITHUB_TOKEN environment variable. Gracefully returns empty
 * results if the token is missing or the API is unreachable.
 */

const REPO = 'quantified-uncertainty/longterm-wiki';
const PER_PAGE = 100;
const MAX_PAGES = 3; // 300 PRs should cover all history

/**
 * Fetch all PRs from the GitHub API.
 * Returns both a branch→PR map and a full PR items array.
 *
 * @returns {Promise<{ branchToPr: Map<string, number>, prItems: Array<object> }>}
 */
async function fetchAllPrs() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { branchToPr: new Map(), prItems: [] };
  }

  const branchToPr = new Map();
  const prItems = [];

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
        return { branchToPr, prItems };
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

        // Collect full PR metadata for the dashboard
        // Note: additions/deletions/changedFiles are NOT available from the
        // list endpoint — only from individual PR fetches. Omitted to avoid
        // always-null fields.
        if (num) {
          prItems.push({
            number: num,
            title: pr.title || '',
            body: pr.body || '',
            state: pr.state || 'unknown',
            branch: branch || '',
            author: pr.user?.login || '',
            createdAt: pr.created_at || '',
            updatedAt: pr.updated_at || '',
            mergedAt: pr.merged_at || null,
            closedAt: pr.closed_at || null,
            labels: (pr.labels || []).map(l => l.name),
          });
        }
      }

      if (prs.length < PER_PAGE) break; // last page
    }
  } catch (err) {
    console.warn(`  github-pr-lookup: ${err.message}, skipping PR enrichment`);
  }

  return { branchToPr, prItems };
}

/** @type {Promise<{ branchToPr: Map<string, number>, prItems: Array<object> }> | null} */
let _cached = null;

/**
 * Get cached PR data. Both fetchBranchToPrMap and fetchPrItems share
 * the same API call to avoid duplicate requests.
 */
function getCachedPrs() {
  if (!_cached) {
    _cached = fetchAllPrs();
  }
  return _cached;
}

/**
 * Fetch all PRs from the GitHub API and return a Map of branch name → PR number.
 * When multiple PRs exist for the same branch, uses the highest (most recent) number.
 *
 * @returns {Promise<Map<string, number>>} branch name → PR number
 */
export async function fetchBranchToPrMap() {
  const { branchToPr } = await getCachedPrs();
  return branchToPr;
}

/**
 * Fetch all PRs and return an array of PR metadata objects for the dashboard.
 * Sorted by PR number descending (most recent first).
 *
 * @returns {Promise<Array<object>>} PR items array
 */
export async function fetchPrItems() {
  const { prItems } = await getCachedPrs();
  // Deduplicate by PR number (keep the first occurrence, which has the most data)
  const seen = new Set();
  const unique = [];
  for (const item of prItems) {
    if (!seen.has(item.number)) {
      seen.add(item.number);
      unique.push(item);
    }
  }
  // Sort by number descending
  unique.sort((a, b) => b.number - a.number);
  return unique;
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
