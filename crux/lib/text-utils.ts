/**
 * Single source of truth for string truncation across crux/.
 *
 * Replaces ~9 named `truncate()` / `truncateText()` helpers and dozens of
 * inline `s.slice(0, N) + '...'` expressions. See QUA-678 for context.
 *
 * Default semantics: budget-inclusive — the ellipsis counts toward `max`,
 * so the result has length <= max. This matches the most common existing
 * helper (e.g. sessions-list, audit, t1-allowlist, url-resolves-verifier).
 *
 * For inline `slice(0, N) + '...'` call sites where the existing output
 * is `N` chars of content + 3 char ellipsis (length N+3), pass
 * `{ ellipsis: '...' }` and a `max` of `N + 3` to preserve identical output.
 */

export interface TruncateOptions {
  /**
   * The marker appended when truncation occurs. Counts toward `max`.
   * Default `'…'` (single Unicode ellipsis, 1 char).
   */
  ellipsis?: string;
  /**
   * When true, format as `<max-chars-of-content>… [truncated, N more chars]`.
   * Result length exceeds `max`. Overrides `ellipsis`.
   * Used by tablebase manifest summaries.
   */
  showCount?: boolean;
  /**
   * Back up to the last whitespace boundary before the cut, so the last
   * word isn't sliced mid-letter. Only fires if a space exists past the
   * half-way point of the budget. Default false.
   */
  wordBoundary?: boolean;
  /** Collapse newlines to spaces before measuring. Default false. */
  oneLine?: boolean;
  /** Returned for null/undefined input. Default `''`. */
  fallback?: string;
}

/**
 * Truncate a string so the result fits within `max` characters.
 *
 * - Default ellipsis is `'…'` (1 char) and counts toward `max`.
 * - For 3-dot ASCII ellipsis, pass `{ ellipsis: '...' }`.
 * - For the count-annotated form, pass `{ showCount: true }`.
 */
export function truncate(
  s: string | null | undefined,
  max: number,
  opts: TruncateOptions = {},
): string {
  if (s == null) return opts.fallback ?? '';
  const str = opts.oneLine ? s.replace(/\n/g, ' ') : s;
  if (str.length <= max) return str;

  if (opts.showCount) {
    const more = str.length - max;
    return `${str.slice(0, max)}… [truncated, ${more} more chars]`;
  }

  const ellipsis = opts.ellipsis ?? '…';
  const budget = max - ellipsis.length;
  if (budget <= 0) {
    // `max` is too small to fit even the ellipsis. Return the leading slice
    // of the ellipsis itself rather than producing a longer-than-max result.
    return ellipsis.slice(0, Math.max(0, max));
  }

  let cut = budget;
  if (opts.wordBoundary) {
    const sub = str.slice(0, budget);
    const lastSpace = sub.lastIndexOf(' ');
    if (lastSpace > budget / 2) cut = lastSpace;
  }
  return str.slice(0, cut) + ellipsis;
}
