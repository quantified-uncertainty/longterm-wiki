/**
 * Validator: crux command handlers should wrap filesystem / exec / network
 * I/O in a top-level try/catch (or explicitly opt out with `// handler-safe`).
 *
 * Background: QUA-339 PR #4245 shipped four new command handlers
 * (`sentinelWrite`, `sentinelTouch`, `sentinelCheck`, `tmuxClaim`) that
 * called into fs-touching helpers without error handling. A filesystem
 * error (EACCES on /tmp, EDQUOT, etc.) would surface as an uncaught
 * exception with a raw Node stack trace instead of a clean
 * CommandResult, crashing the calling skill. Caught by the pass-2 review,
 * fixed in #4256.
 *
 * Scope: This validator is ADVISORY (non-blocking). The existing crux
 * codebase has many legacy handlers without try/catch, and retrofitting
 * all of them is a separate project. The purpose here is to:
 *   1. Produce a visible warning when new handlers lack error handling,
 *      so reviewers notice the pattern
 *   2. Provide detection logic that `/agent-review-pr` and the
 *      diff-triggered checklist (option B) can reuse
 *
 * Detection semantics:
 *   - A "command handler" is an async function whose return type is
 *     `Promise<CommandResult>`
 *   - The handler is "safe" if:
 *     (a) its body contains a `try {` block at the top level (brace
 *         depth 1 relative to the body), OR
 *     (b) the line above its declaration contains `// handler-safe`
 *   - Otherwise it's flagged
 *
 * We deliberately do NOT require the try to be the FIRST statement —
 * real handlers usually do arg parsing and type narrowing first, then
 * wrap the I/O section in try/catch. The point is "some protection is
 * present", not "protection is maximally eager".
 *
 * Run standalone: npx tsx crux/validate/validate-command-handler-errors.ts
 *
 * Exit code:
 *   0 — advisory; always exits 0 so the gate doesn't block on legacy handlers
 *   (summary is printed to stdout so the gate captures it as a warning)
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';

export interface HandlerFinding {
  file: string;
  line: number;
  name: string;
  /** `safe` = has try/catch or marker; `unsafe` = neither. */
  status: 'safe' | 'unsafe';
  /** Why the handler was classified as safe, when applicable. */
  safeReason?: 'try-catch' | 'handler-safe-marker';
}

/**
 * Scan a single file's source for `Promise<CommandResult>` handlers and
 * classify each one as safe or unsafe.
 *
 * Pure over content — tests can pass synthetic source without touching
 * the filesystem.
 */
export function scanHandlers(filePath: string, content: string): HandlerFinding[] {
  const lines = content.split('\n');
  const findings: HandlerFinding[] = [];
  const rel = filePath === '/fake' ? '/fake' : relative(PROJECT_ROOT, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for `async function <name>(` — accept standalone or `export async`
    const sigMatch = line.match(/\basync\s+function\s+(\w+)\s*\(/);
    if (!sigMatch) continue;

    // Confirm this is a CommandResult handler. The return-type annotation
    // may be on the same line or up to ~5 lines below (multi-line sigs).
    let returnTypeLine = -1;
    for (let j = i; j < Math.min(i + 8, lines.length); j++) {
      if (lines[j].includes('Promise<CommandResult>')) {
        returnTypeLine = j;
        break;
      }
      // Stop if we hit a body brace before seeing the return type
      if (lines[j].includes('{') && j > i) break;
    }
    if (returnTypeLine < 0) continue;

    const name = sigMatch[1];

    // Check for `// handler-safe` marker on the line directly above the sig.
    const prev = i > 0 ? lines[i - 1].trim() : '';
    if (/\/\/\s*handler-safe\b/.test(prev)) {
      findings.push({ file: rel, line: i + 1, name, status: 'safe', safeReason: 'handler-safe-marker' });
      continue;
    }

    // Find the body-opening brace — the `{` that starts the function body.
    let braceLine = -1;
    for (let j = returnTypeLine; j < Math.min(returnTypeLine + 3, lines.length); j++) {
      if (lines[j].trimEnd().endsWith('{')) {
        braceLine = j;
        break;
      }
    }
    if (braceLine < 0) continue;

    // Walk the body, tracking brace depth, looking for a `try {` at
    // the body's top level (depth 1 relative to body start).
    // We use a simple character scan because handler bodies rarely
    // contain regex literals or template strings with unbalanced braces.
    const bodyEnd = findMatchingBrace(lines, braceLine);
    const hasTry = bodyContainsTopLevelTry(lines, braceLine, bodyEnd);

    findings.push({
      file: rel,
      line: i + 1,
      name,
      status: hasTry ? 'safe' : 'unsafe',
      safeReason: hasTry ? 'try-catch' : undefined,
    });

    // Skip past the body we just processed to avoid re-matching nested
    // async functions (rare for handlers, but possible).
    i = bodyEnd;
  }

  return findings;
}

/**
 * Given the line index of a function body's opening `{`, find the line
 * index of its matching `}`. Best-effort: counts `{` / `}` occurrences
 * without respecting strings or comments. Good enough for handler bodies.
 */
function findMatchingBrace(lines: string[], openLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = openLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth += 1; started = true; }
      else if (ch === '}') {
        depth -= 1;
        if (started && depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/**
 * True if the body spanning [openLine+1, endLine) contains a `try` token
 * at body-level depth (depth 1 relative to the body's opening `{`).
 */
function bodyContainsTopLevelTry(lines: string[], openLine: number, endLine: number): boolean {
  let depth = 0;
  let started = false;
  for (let i = openLine; i <= endLine && i < lines.length; i++) {
    const line = lines[i];
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '{') { depth += 1; started = true; continue; }
      if (ch === '}') { depth -= 1; continue; }
      if (!started) continue;
      // Only look for top-level `try` at depth === 1 (inside the body,
      // not inside a nested block). Check for word-boundary `try`.
      if (depth === 1 && ch === 't' && line.slice(k, k + 4) === 'try ') {
        // Require preceding char to be whitespace, `;`, or start of line
        const prev = k > 0 ? line[k - 1] : '\n';
        if (/\s|;|^/.test(prev)) {
          // Must be followed by `{` on this line or the next (after whitespace)
          const after = line.slice(k + 3).trim();
          if (after.startsWith('{') || after === '') return true;
        }
      }
    }
  }
  return false;
}

function collectCommandFiles(root: string): string[] {
  const out: string[] = [];
  try {
    if (!statSync(root).isDirectory()) return out;
  } catch { return out; }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push(join(root, entry.name));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI entrypoint — advisory only
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const commandsDir = join(PROJECT_ROOT, 'crux/commands');
  const files = collectCommandFiles(commandsDir);
  const allFindings: HandlerFinding[] = [];
  for (const f of files) {
    allFindings.push(...scanHandlers(f, readFileSync(f, 'utf-8')));
  }

  const unsafe = allFindings.filter((f) => f.status === 'unsafe');
  const safe = allFindings.filter((f) => f.status === 'safe');

  console.log(
    `Command handler error boundary: ${safe.length} safe, ${unsafe.length} without try/catch (advisory)`,
  );

  if (unsafe.length > 0) {
    console.log('');
    console.log('Handlers without top-level try/catch or `// handler-safe` marker:');
    // Cap output — advisory, not blocking; don't flood the gate log.
    for (const f of unsafe.slice(0, 30)) {
      console.log(`  ${f.file}:${f.line} — ${f.name}`);
    }
    if (unsafe.length > 30) {
      console.log(`  … ${unsafe.length - 30} more`);
    }
    console.log('');
    console.log('Fix options:');
    console.log('  1. Wrap body in try/catch, return { exitCode: 1, output: msg }');
    console.log('  2. Annotate `// handler-safe` on the line above if body cannot throw');
    console.log('');
    console.log('See QUA-339 PR #4256 for the pattern.');
  }

  // Advisory: always exit 0. Gate parses stdout to surface the count.
  process.exit(0);
}
