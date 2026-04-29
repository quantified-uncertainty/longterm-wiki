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
 * String-state walker that handles all three quote styles plus template
 * literal expression interpolation (`${...}`). Used by both
 * `findInlineCommentStart` and `isInsideStringAt`.
 *
 * Walks the line character-by-character. The `inString` predicate is true
 * when the current position is inside an active string literal context,
 * accounting for:
 *   - Single quotes, double quotes, backticks
 *   - Backslash escapes (`\'`, `\"`, `\``, `\\`)
 *   - Template-literal expression interpolation: inside `${...}` we're
 *     back in code context (so `apiRequest<T>` inside `${expr}` is real
 *     code and gets flagged correctly).
 *
 * Returns either:
 *   - The terminal state at end-of-line (used by `isInsideStringAt`), or
 *   - The position of the first inline-comment opener encountered (used
 *     by `findInlineCommentStart`).
 *
 * Internal — not exported. Public helpers wrap it.
 */
function walkLine(
  line: string,
  options: { stopAtCommentOpener?: boolean; targetIndex?: number },
): { commentStart: number; inString: boolean } {
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  // Stack of expression-interpolation depths within nested template
  // literals. When inside `${...}`, the outer backtick is suspended.
  // Each entry is the open-brace count for one template-expression scope.
  const exprStack: number[] = [];

  const inString = () =>
    inSingle || inDouble || (inBacktick && exprStack.length === 0);

  while (i < line.length) {
    if (options.targetIndex !== undefined && i >= options.targetIndex) break;

    const ch = line[i];
    const next = line[i + 1];

    if (inSingle) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inDouble = false;
    } else if (inBacktick && exprStack.length === 0) {
      // Active template literal at the string level (not inside ${...}).
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') inBacktick = false;
      else if (ch === '$' && next === '{') {
        exprStack.push(0); // entering expression
        i += 2;
        continue;
      }
    } else {
      // Code context — either top-level or inside `${...}` of a template.
      const inExpr = exprStack.length > 0;
      if (inExpr && ch === '{') {
        exprStack[exprStack.length - 1]++;
      } else if (inExpr && ch === '}') {
        if (exprStack[exprStack.length - 1] === 0) {
          exprStack.pop(); // closing the ${...}
        } else {
          exprStack[exprStack.length - 1]--;
        }
      } else if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === '`') {
        // A new template literal — push onto the (logical) string stack.
        // We model nested templates by toggling inBacktick: the previous
        // outer template, if any, is still tracked via exprStack — popping
        // the expression scope returns to it.
        if (inBacktick) inBacktick = false; // closing this one
        else inBacktick = true;
      }
      else if (options.stopAtCommentOpener) {
        if (ch === '/' && next === '/') return { commentStart: i, inString: false };
        if (ch === '/' && next === '*') return { commentStart: i, inString: false };
      }
    }
    i++;
  }

  return { commentStart: -1, inString: inString() };
}

/**
 * Return the index of the inline comment opener (`//` or `/*`) on the
 * given line, or `-1` if none. Skips `//` and `/*` sequences inside
 * string and template literals (including inside `${...}` expressions
 * within templates).
 *
 * Used by validators that need to know whether a regex match landed
 * BEFORE the comment opener (i.e. in real code) or AFTER (i.e. inside
 * a comment, where it should not be flagged).
 */
export function findInlineCommentStart(line: string): number {
  return walkLine(line, { stopAtCommentOpener: true }).commentStart;
}

/**
 * Test whether a position in a line falls inside a string or template
 * literal. Returns false for positions inside `${...}` expressions within
 * templates, since those are code-context.
 *
 * Used to skip false positives when a banned token literally appears in
 * a string (e.g. an error message that mentions `apiRequest<T>`).
 */
export function isInsideStringAt(line: string, index: number): boolean {
  return walkLine(line, { targetIndex: index }).inString;
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
