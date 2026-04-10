/**
 * Extract a Linear issue identifier (e.g. "QUA-184") from an unstructured
 * string — a branch name, a task description, or a PR title.
 *
 * Used by `/agent-init` and related skills to find the Linear issue for the
 * current session without requiring a manual `--linear=QUA-NNN` flag.
 * Companion to the GitHub issue-number detection already in agent-checklist.
 *
 * Team keys are 2–5 uppercase letters followed by a dash and digits. The
 * default team key is "QUA" but the regex accepts any valid Linear key so
 * the same helper can be reused if the workspace ever adds another team.
 */

const LINEAR_ID_RE = /\b([A-Z][A-Z0-9]{1,4})-(\d{1,6})\b/;

/** Case-insensitive branch-name matcher: `claude/qua-184-description` */
const BRANCH_ID_RE = /\bclaude\/([a-z][a-z0-9]{1,4})-(\d{1,6})(?:[-/]|$)/i;

/**
 * Parse a Linear issue identifier from an unstructured string.
 *
 * Search order:
 *   1. Explicit branch-name pattern: `claude/qua-184-*`
 *   2. Any bare `QUA-184` token
 *
 * Returns the identifier in canonical form (`QUA-184`) or `null`.
 */
export function parseLinearId(input: string | null | undefined): string | null {
  if (!input) return null;

  const branchMatch = BRANCH_ID_RE.exec(input);
  if (branchMatch) {
    return `${branchMatch[1].toUpperCase()}-${branchMatch[2]}`;
  }

  const bareMatch = LINEAR_ID_RE.exec(input);
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
