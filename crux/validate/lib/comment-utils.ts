/**
 * Shared helpers for line-oriented validators that need to distinguish
 * source code from comments and string literals.
 *
 * Used by:
 * - validate-dangerous-patterns.ts (silent catch, as any, skipEntityValidation)
 * - validate-typed-client.ts (direct apiRequest<T> calls — QUA-770)
 *
 * Both validators were independently walking string state and extracting
 * inline comments. Per `.claude/rules/implementation-quality.md` §
 * "Pattern fixes must be global", this module hosts the shared
 * implementation so both validators stay in sync.
 */

/**
 * Extract the inline comment portion of a line, ignoring `//` sequences
 * that appear inside string or template literals. Returns the comment
 * text (the substring after the `//` or `/*`) or `null` if there is no
 * real inline comment.
 */
export function extractInlineComment(line: string): string | null {
  const start = findInlineCommentStart(line);
  if (start === -1) return null;
  // Skip the comment opener (`//` or `/*`).
  return line.slice(start + 2);
}

/**
 * Return the index of the inline comment opener (`//` or `/*`) on the
 * given line, or `-1` if none. Skips `//` and `/*` sequences inside
 * string and template literals.
 *
 * Used by validators that need to know whether a regex match landed
 * BEFORE the comment opener (i.e. in real code) or AFTER (i.e. inside
 * a comment, where it should not be flagged).
 */
export function findInlineCommentStart(line: string): number {
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (inSingle) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inDouble = false;
    } else if (inBacktick) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') inBacktick = false;
    } else {
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === '`') inBacktick = true;
      else if (ch === '/' && next === '/') return i;
      else if (ch === '/' && next === '*') return i;
    }
    i++;
  }
  return -1;
}

/**
 * Test whether a position in a line falls inside a string or template
 * literal. Used to skip false positives when a banned token literally
 * appears in a string (e.g. an error message that mentions `apiRequest<T>`).
 *
 * Walks characters tracking quote/backtick state.
 */
export function isInsideStringAt(line: string, index: number): boolean {
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  while (i < index && i < line.length) {
    const ch = line[i];
    if (inSingle) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inDouble = false;
    } else if (inBacktick) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') inBacktick = false;
    } else {
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === '`') inBacktick = true;
    }
    i++;
  }
  return inSingle || inDouble || inBacktick;
}

/**
 * Build a strict suppression-marker regex. The marker MUST appear in the
 * form `<marker>: <reason>` (with a non-empty reason after the colon).
 * Callers pass only the comment portion of a line (via
 * `extractInlineComment`), so the regex never sees code outside comments.
 */
export function buildSuppressionRegex(marker: string): RegExp {
  const escaped = marker.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\s*:\\s*\\S`);
}
