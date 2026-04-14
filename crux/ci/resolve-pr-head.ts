/**
 * Resolve a PR's current head SHA via the GitHub API.
 *
 * Used by `crux gh ci status --pr=<N>` so the CLI always reports on the PR's
 * live state, not a stale local snapshot. (QUA-410)
 */

import { githubApi, REPO } from '../lib/github.ts';

export async function resolvePrHeadSha(
  prNumber: string,
  api: typeof githubApi = githubApi,
): Promise<string> {
  if (!/^\d+$/.test(prNumber)) {
    throw new Error(`Invalid --pr value: ${prNumber} (must be numeric)`);
  }
  const pr = await api<{ head: { sha: string } }>(
    `/repos/${REPO}/pulls/${prNumber}`,
  );
  if (!pr?.head?.sha) {
    throw new Error(`Could not resolve head SHA for PR #${prNumber}`);
  }
  return pr.head.sha;
}
