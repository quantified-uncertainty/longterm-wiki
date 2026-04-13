/**
 * Review pattern registry — single source of truth for bug shapes the
 * `/agent-review-pr` skill should consider.
 *
 * Each pattern declares:
 *   - id             stable identifier used in checklist items + gate IDs
 *   - label          human-readable name shown in review plan / checklist
 *   - detect(diff)   pure function: does this diff exhibit the pattern?
 *   - mechanical     true if there is a standalone gate validator that
 *                    catches the bug (no reviewer judgment needed);
 *                    false if only a human/LLM can decide
 *   - reason         one-line explanation of WHY the pattern matters
 *                    (gets printed in the checklist item and review plan)
 *   - origin         Linear ticket that seeded the pattern (optional),
 *                    so the provenance is inspectable
 *
 * The registry is consumed by:
 *   1. `crux/validate/validate-review-patterns.ts` — the gate (option A).
 *      Runs every `mechanical: true` pattern and fails on hits.
 *   2. `crux sys agent-checklist init` — option B. Scans the current
 *      diff, and for each triggered pattern (mechanical or not),
 *      appends a forced checklist item the reviewer must explicitly
 *      check off or mark `--na` with reason.
 *   3. `/agent-review-pr` skill — option E. Reads the triggered
 *      patterns from the checklist and produces an attestation block
 *      ("[x] pattern-id — no findings" / "[x] pattern-id — <file:line>").
 *
 * Adding a new pattern is a one-file change: drop an entry in
 * PATTERNS below. All three consumers pick it up automatically.
 */

export interface ReviewPattern {
  /** Stable kebab-case id. Used as checklist item id and gate check id. */
  id: string;
  /** Human-readable label shown in the checklist. */
  label: string;
  /** One-line explanation of the bug class (rendered next to the item). */
  reason: string;
  /** Origin ticket for provenance. */
  origin?: string;
  /**
   * Detect whether this pattern's bug shape is present in a unified
   * diff blob (output of `git diff origin/main...HEAD`).
   *
   * This MUST be pure — no filesystem, no shell. Tests depend on it.
   */
  detect(diff: DiffBlob): PatternHit[];
  /**
   * If true, a separate gate validator exists that blocks the PR when
   * the bug is present. The checklist item is still added but serves
   * as a belt-and-suspenders attestation.
   *
   * If false, the bug class is shape-dependent or semantic; only the
   * checklist item and reviewer judgment catch it.
   */
  mechanical: boolean;
}

/**
 * Parsed unified diff — the detect() shape. Not a full parser; just
 * enough structure to grep + locate. Builds cheaply with `parseDiff()`.
 */
export interface DiffBlob {
  /** Full raw unified diff text (for regex searches). */
  raw: string;
  /** Per-file changes, parsed from the diff headers. */
  files: DiffFile[];
}

export interface DiffFile {
  /** Path relative to repo root. */
  path: string;
  /** True if the file was newly added in this diff. */
  added: boolean;
  /** Lines added in this file (prefix `+` stripped). */
  addedLines: AddedLine[];
}

export interface AddedLine {
  /** Line number in the NEW file (best-effort; 0 if unknown). */
  newLineNumber: number;
  /** The line content (no leading `+`). */
  content: string;
}

export interface PatternHit {
  /** Path of the file where the pattern was detected. */
  file: string;
  /** Line number in the new file, or 0 if file-level. */
  line: number;
  /** The matched snippet (trimmed), for logging. */
  snippet: string;
}

// ---------------------------------------------------------------------------
// Pattern registry
// ---------------------------------------------------------------------------

export const PATTERNS: ReviewPattern[] = [
  {
    id: 'github-conclusion-enum',
    label: 'GitHub check conclusions handled exhaustively',
    reason:
      'Regex-matching conclusion fields (e.g. /failure|cancelled/) routinely misses timed_out and action_required. Use the FAILING_CONCLUSIONS allowlist.',
    origin: 'QUA-339 pass-2 bug HIGH-2',
    mechanical: true,
    detect(diff) {
      // Match regex literals or string patterns applied to a `conclusion`
      // field. We're looking for two shapes:
      //   /failure|cancelled/.test(x.conclusion)
      //   /fail|cancel/i.test(conclusion)
      //   'failure' === conclusion etc
      //
      // The detection is intentionally loose: any regex that mentions
      // conclusion-like variants without including ALL failing ones is
      // a candidate. The validator then verifies exhaustiveness.
      const hits: PatternHit[] = [];
      // A JS regex literal that alludes to check-conclusion names.
      // Intentionally loose — the mechanical validator then verifies
      // exhaustiveness against the full FAILING_CONCLUSIONS allowlist.
      const RE = /\/[^/\n]*(failure|fail|cancel|error|timed_out|action_required)[^/\n]*\//;
      for (const file of diff.files) {
        if (!/\.(ts|tsx|mjs|js)$/.test(file.path)) continue;
        if (file.path.includes('/__tests__/') || file.path.endsWith('.test.ts')) continue;
        for (const line of file.addedLines) {
          if (!RE.test(line.content)) continue;
          // Require the line (or a 2-line context window — caller passes
          // us only individual lines, so fall back to the line itself)
          // to mention "conclusion" somewhere nearby.
          if (!/conclusion|statusCheck|check[_\s]?run/i.test(line.content)) continue;
          hits.push({ file: file.path, line: line.newLineNumber, snippet: line.content.trim() });
        }
      }
      return hits;
    },
  },
  {
    id: 'command-handler-error-boundary',
    label: 'New crux command handlers have a top-level try/catch',
    reason:
      'Handler bodies that throw surface as raw Node stack traces instead of CommandResult errors, breaking calling skills. Wrap with try/catch or annotate `// handler-safe`.',
    origin: 'QUA-339 pass-2 bug MED-3',
    mechanical: true,
    detect(diff) {
      // Look for new `async function <name>(..., options: ...Options): Promise<CommandResult>`
      // entries in crux/commands/*.ts that don't start with a `try {`.
      const hits: PatternHit[] = [];
      const HANDLER_RE =
        /^\+\s*(?:export\s+)?async\s+function\s+(\w+)\s*\([^)]*\)\s*:\s*Promise<CommandResult>/;
      for (const file of diff.files) {
        if (!file.path.startsWith('crux/commands/')) continue;
        if (!file.path.endsWith('.ts') || file.path.endsWith('.test.ts')) continue;
        // Scan the raw diff for added handler signatures; we'll verify
        // the handler body at gate time (the mechanical validator has
        // full file context).
        const lines = diff.raw.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(HANDLER_RE);
          if (!m) continue;
          // Only count if this line is part of the current file's hunk
          // (simple heuristic: look backward for the last `diff --git`).
          let j = i;
          while (j > 0 && !lines[j].startsWith('diff --git')) j--;
          if (!lines[j].includes(file.path)) continue;
          hits.push({ file: file.path, line: 0, snippet: m[0].slice(1).trim() });
        }
      }
      return hits;
    },
  },
  {
    id: 'readdir-iteration-determinism',
    label: 'readdir / listMatching calls in priority loops',
    reason:
      "readdirSync returns entries in filesystem order (unsorted on Linux). If the caller uses the first 'matching' entry for priority logic, iteration order masks the real answer. Either sort explicitly or walk all entries and track both sides.",
    origin: 'QUA-339 pass-2 bug HIGH-1',
    mechanical: false,
    detect(diff) {
      const hits: PatternHit[] = [];
      for (const file of diff.files) {
        if (!/\.(ts|tsx|mjs|js)$/.test(file.path)) continue;
        for (const line of file.addedLines) {
          if (!/\breaddirSync\b|\blistMatching\b/.test(line.content)) continue;
          hits.push({ file: file.path, line: line.newLineNumber, snippet: line.content.trim() });
        }
      }
      return hits;
    },
  },
  {
    id: 'numeric-id-substring-match',
    label: 'String .includes() against numeric IDs / paths',
    reason:
      'Substring matching on numeric identifiers causes prefix collisions (e.g. `"/lw/a10".includes("/lw/a1")` is true). Use path boundaries or exact equality instead.',
    origin: 'QUA-339 pass-2 bug MED-4',
    mechanical: false,
    detect(diff) {
      const hits: PatternHit[] = [];
      // Shape: `.includes(<identifier>)` where the identifier's name
      // hints at a path or numeric id (path, slotPath, id, pid, port).
      const RE = /\.includes\(\s*[a-z][\w.]*(?:path|Path|id|Id|pid|Pid|port|Port)\b\s*\)/;
      for (const file of diff.files) {
        if (!/\.(ts|tsx|mjs|js)$/.test(file.path)) continue;
        if (file.path.includes('/__tests__/') || file.path.endsWith('.test.ts')) continue;
        for (const line of file.addedLines) {
          if (!RE.test(line.content)) continue;
          hits.push({ file: file.path, line: line.newLineNumber, snippet: line.content.trim() });
        }
      }
      return hits;
    },
  },
  {
    id: 'test-fake-silent-default',
    label: 'Test fakes/stubs with permissive default returns',
    reason:
      'Fake env/mock methods that default to success on unregistered keys silently let tests pass when setup is missing. Fail closed: throw with the unregistered key name.',
    origin: 'QUA-339 pass-2 bug MED-5',
    mechanical: false,
    detect(diff) {
      const hits: PatternHit[] = [];
      // Trigger on new Fake*Env / *FakeEnv class declarations in
      // test directories. Cheap shape-match; the reviewer decides
      // whether the defaults are sound.
      const CLASS_RE = /\bclass\s+\w*[Ff]ake\w*\s*(?:extends|\{|implements)/;
      for (const file of diff.files) {
        if (!file.path.endsWith('.ts') && !file.path.endsWith('.tsx')) continue;
        const isTest = file.path.includes('/__tests__/') || file.path.endsWith('.test.ts');
        if (!isTest && !file.added) continue;
        for (const line of file.addedLines) {
          if (!CLASS_RE.test(line.content)) continue;
          hits.push({ file: file.path, line: line.newLineNumber, snippet: line.content.trim() });
        }
      }
      return hits;
    },
  },
];

// ---------------------------------------------------------------------------
// Diff parser (minimal)
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff into a DiffBlob. Only extracts what PATTERNS'
 * detect() needs: file paths, added-ness, and added lines with best-effort
 * line numbers from hunk headers.
 *
 * This is deliberately NOT a full diff parser — we don't need context
 * lines, removed lines, or rename tracking. Robust enough for the
 * output of `git diff origin/main...HEAD`.
 */
export function parseDiff(raw: string): DiffBlob {
  const files: DiffFile[] = [];
  const lines = raw.split('\n');
  let current: DiffFile | null = null;
  let newLineNo = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File boundary: `diff --git a/path b/path`
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      if (current) files.push(current);
      current = { path: fileMatch[2], added: false, addedLines: [] };
      newLineNo = 0;
      continue;
    }
    if (!current) continue;

    // Added-file marker: `new file mode` appears after the diff --git line
    if (line.startsWith('new file mode')) {
      current.added = true;
      continue;
    }

    // Hunk header: `@@ -a,b +c,d @@` — reset new-line counter
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNo = Number(hunkMatch[1]) - 1;
      continue;
    }

    // Added line (not the `+++` header)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      newLineNo += 1;
      current.addedLines.push({ newLineNumber: newLineNo, content: line.slice(1) });
      continue;
    }
    // Context line — advances new-file line counter
    if (!line.startsWith('-') && !line.startsWith('---')) {
      newLineNo += 1;
    }
  }

  if (current) files.push(current);
  return { raw, files };
}

// ---------------------------------------------------------------------------
// Convenience: detect all patterns against a diff
// ---------------------------------------------------------------------------

export interface PatternDetection {
  pattern: ReviewPattern;
  hits: PatternHit[];
}

export function detectAllPatterns(diff: DiffBlob): PatternDetection[] {
  const out: PatternDetection[] = [];
  for (const pattern of PATTERNS) {
    const hits = pattern.detect(diff);
    if (hits.length > 0) out.push({ pattern, hits });
  }
  return out;
}

export function getPatternById(id: string): ReviewPattern | undefined {
  return PATTERNS.find((p) => p.id === id);
}
