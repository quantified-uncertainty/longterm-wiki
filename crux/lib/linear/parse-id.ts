/**
 * Extract a Linear issue identifier (e.g. "QUA-184") from an unstructured
 * string — a branch name, a task description, or a PR title.
 *
 * Used by `/agent-init` and related skills to find the Linear issue for the
 * current session without requiring a manual `--linear=QUA-NNN` flag.
 * Companion to the GitHub issue-number detection already in agent-checklist.
 *
 * The bare-token matcher is deliberately restricted to a known team-key
 * allowlist (currently just `QUA`) to avoid false positives on tokens like
 * `UTF-8`, `CVE-2024`, `PR-1234`, `HTTP2-3`, `ISO-8601` that otherwise look
 * like Linear identifiers but aren't. The branch-pattern matcher is more
 * permissive since the `claude/` prefix already disambiguates intent.
 */

/**
 * Known Linear team keys recognised by bare-token matching.
 *
 * Add new team keys here as the workspace grows. The branch-pattern matcher
 * doesn't use this list — any 2–5 letter key inside a `claude/<key>-N-*`
 * branch is accepted since the `claude/` prefix signals explicit intent.
 */
export const KNOWN_LINEAR_TEAM_KEYS = ['QUA'] as const;

const knownTeamKeyAlt = KNOWN_LINEAR_TEAM_KEYS.join('|');
const BARE_ID_RE = new RegExp(`\\b(${knownTeamKeyAlt})-(\\d{1,6})\\b`);

/** Case-insensitive branch-name matcher: `claude/qua-184-description` */
const BRANCH_ID_RE = /\bclaude\/([a-z]{2,5})-(\d{1,6})(?:[-/]|$)/i;

/**
 * Parse a Linear issue identifier from an unstructured string.
 *
 * Search order:
 *   1. Explicit branch-name pattern: `claude/qua-184-*` — any 2–5 letter key
 *   2. Bare `QUA-184` token — restricted to the known-team-keys allowlist
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
