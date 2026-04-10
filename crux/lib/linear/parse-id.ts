/**
 * Extract a Linear issue identifier (e.g. "QUA-184") from an unstructured
 * string — a branch name, a task description, or a PR title.
 *
 * Used by `/agent-init` and related skills to find the Linear issue for the
 * current session without requiring a manual `--linear=QUA-NNN` flag.
 * Companion to the GitHub issue-number detection already in agent-checklist.
 *
 * Both the bare-token matcher AND the branch-pattern matcher are restricted
 * to the known team-key allowlist (currently just `QUA`). Without that, a
 * GitHub-style branch like `claude/fix-239-...` would be misclassified as
 * `FIX-239` and pollute Linear checklist metadata.
 */

/**
 * Known Linear team keys recognised by branch and bare-token matching.
 * Add new team keys here as the workspace grows.
 */
export const KNOWN_LINEAR_TEAM_KEYS = ['QUA'] as const;

const knownTeamKeyAlt = KNOWN_LINEAR_TEAM_KEYS.join('|');
const BARE_ID_RE = new RegExp(`\\b(${knownTeamKeyAlt})-(\\d{1,6})\\b`);

/**
 * Case-insensitive branch-name matcher: `claude/qua-184-description`.
 * Restricted to the known-team-keys allowlist so that GitHub-flavored branches
 * like `claude/fix-239-...` or `claude/cve-2024-...` don't get misclassified.
 */
const BRANCH_ID_RE = new RegExp(
  `\\bclaude\\/(${knownTeamKeyAlt})-(\\d{1,6})(?:[-/]|$)`,
  'i',
);

/**
 * Parse a Linear issue identifier from an unstructured string.
 *
 * Search order:
 *   1. Explicit branch-name pattern: `claude/qua-184-*`
 *   2. Bare `QUA-184` token
 *
 * Both matchers use the known-team-keys allowlist so tokens like
 * `UTF-8`, `CVE-2024`, `FIX-239`, `PR-1234` aren't mis-parsed.
 *
 * Returns the identifier in canonical form (`QUA-184`) or `null`.
 */
export function parseLinearId(input: string | null | undefined): string | null {
  if (!input) return null;

  const branchMatch = BRANCH_ID_RE.exec(input);
  if (branchMatch) {
    return `${branchMatch[1].toUpperCase()}-${branchMatch[2]}`;
  }

  const bareMatch = BARE_ID_RE.exec(input);
  if (bareMatch) {
    return `${bareMatch[1]}-${bareMatch[2]}`;
  }

  return null;
}

/**
 * Parse a Linear ID from several sources, preferring earlier ones.
 * Designed for session-init: branch name first, then task description.
 */
export function resolveLinearId(sources: Array<string | null | undefined>): string | null {
  for (const s of sources) {
    const id = parseLinearId(s);
    if (id) return id;
  }
  return null;
}
