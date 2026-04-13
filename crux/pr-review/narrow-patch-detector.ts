/**
 * Narrow-patch detector (QUA-356)
 *
 * Flags a diff pattern that has historically masked a class-shaped bug behind a
 * one-component, column-name-gated check. The canonical example is QUA-346:
 * masking raw FactBase `f_xxx` IDs in `CellValue` only when the column name is
 * `fact_id` / `factId`, instead of doing content-based detection regardless of
 * column. QUA-316 was the first narrow patch in the same class; QUA-354 / PR
 * #4268 is the proper systemic fix that replaced both with a regex on the value.
 *
 * This detector is an advisory review-time hint, not a gate check. It fires at
 * MEDIUM severity when the added lines contain BOTH:
 *   1. A column-name-literal equality gate — the column identifier
 *      (columnName, fieldName, column.name, field.name, etc.) compared for
 *      strict equality against a quoted literal.
 *   2. A value-signature probe — one of the string/regex methods startsWith,
 *      endsWith, includes, test, match, search, or exec called on the value.
 *
 * The examples are deliberately written in prose here instead of as code
 * fragments, so the detector does not self-fire on its own docstring. See the
 * tests for the canonical code shapes.
 *
 * False-positive guards:
 *   - Both patterns must appear in the same CONTIGUOUS run of added lines.
 *     Two unrelated changes in one hunk (one adding a column gate elsewhere,
 *     one adding a value probe) never co-fire.
 *   - Diffs without both a column-name gate AND a value probe never fire.
 *   - Test files are skipped (test fixtures deliberately contain the signature).
 *   - Non-code files (markdown, YAML, SQL, config) are skipped.
 *
 * Output shape matches the hostile-reviewer finding format in
 * `.claude/commands/agent-review-pr.md` Phase 3.
 */

export interface NarrowPatchFinding {
  severity: "MEDIUM";
  file: string;
  line: number;
  message: string;
  snippet: string;
  relatedIncidents: string[];
}

// Matches a column identifier (columnName, fieldName, column.name, col.name,
// field.name, colName, or any `<receiver>.column`) strict-equality tested
// against a quoted string literal. The `key` alternative was removed after
// review — too broad (common object-lookup idiom).
const COLUMN_NAME_GATE_RE =
  /\b(?:columnName|fieldName|colName|column\.name|col\.name|field\.name|\w+\.column)\s*===?\s*["'`][A-Za-z_][\w-]*["'`]/;

// Matches a method call that probes a value's signature: one of startsWith,
// endsWith, includes, test, match, search, or exec invoked via dot-call on any
// receiver. This is the exact anti-pattern in QUA-316/QUA-346.
const VALUE_SIGNATURE_RE =
  /\.\s*(?:startsWith|endsWith|includes|test|match|search|exec)\s*\(/;

// File paths that look like generic renderers/column rules/formatters/validators.
// Used only to strengthen the message — the detector fires regardless of path.
const RENDERER_PATH_RE =
  /(?:render|cell|column|viewer|display|formatter|format-|validate-|validator)/i;

interface ParsedHunk {
  file: string;
  newStartLine: number;
  addedLines: Array<{ line: number; text: string }>;
}

/**
 * Parse a unified diff into per-file hunks with line numbers for the added side.
 *
 * Uses the `+++ b/<path>` line for the filename (NOT the `diff --git a/X b/Y`
 * header) because the `diff --git` header is whitespace-split and breaks on
 * paths that contain spaces or `/b/` segments. The `+++ b/<path>` line is the
 * canonical new-file path and is always present for modified/added files.
 *
 * CRLF line endings are normalized at input so Windows-sourced diffs parse
 * identically to Unix diffs.
 */
export function parseDiff(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  // Normalize CRLF → LF so trailing \r doesn't fall through to the unknown-line
  // branch and silently abort a hunk.
  const normalized = diff.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const parts = normalized.split(/^diff --git /m);

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const lines = block.split("\n");

    // Walk once: pick up the `+++ b/<path>` filename, then parse hunks. If the
    // block has `+++ /dev/null` (file deleted), skip — there are no added lines.
    let file: string | null = null;
    let j = 0;
    while (j < lines.length) {
      const line = lines[j];
      if (line.startsWith("+++ b/")) {
        file = line.slice("+++ b/".length);
        j++;
        break;
      }
      if (line.startsWith("+++ /dev/null")) {
        file = null;
        j++;
        break;
      }
      if (line.startsWith("@@ ")) {
        // Reached hunks without finding a +++ b/ line (binary diff, rename with
        // no content change, etc.) — nothing to collect.
        break;
      }
      j++;
    }
    if (file == null) continue;

    // Now parse hunks.
    while (j < lines.length) {
      const line = lines[j];
      const hunkHeader = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!hunkHeader) {
        j++;
        continue;
      }
      const newStart = Number(hunkHeader[1]);
      const added: Array<{ line: number; text: string }> = [];
      let cursor = newStart;
      j++;
      while (j < lines.length && !lines[j].startsWith("@@ ")) {
        const raw = lines[j];
        if (raw.startsWith("+")) {
          added.push({ line: cursor, text: raw.slice(1) });
          cursor++;
        } else if (raw.startsWith("-")) {
          // removal — does not advance the new-file cursor
        } else if (raw.startsWith(" ")) {
          cursor++;
        } else if (raw === "\\ No newline at end of file") {
          // ignore
        } else if (raw === "") {
          // Blank entry from trailing split — don't advance cursor (empty
          // context lines show up as a single space in unified diff, not as "").
        } else {
          // Unknown content — we've walked off the hunk (rare).
          break;
        }
        j++;
      }
      if (added.length > 0) {
        hunks.push({ file, newStartLine: newStart, addedLines: added });
      }
    }
  }
  return hunks;
}

/**
 * Split a hunk's added lines into contiguous runs — groups of lines with
 * consecutive new-file line numbers. Two unrelated changes in the same hunk
 * end up as separate runs, which lets the detector avoid cross-change false
 * positives.
 */
function contiguousRuns(
  hunk: ParsedHunk
): Array<Array<{ line: number; text: string }>> {
  const runs: Array<Array<{ line: number; text: string }>> = [];
  let current: Array<{ line: number; text: string }> = [];
  let prevLine = -1;
  for (const entry of hunk.addedLines) {
    if (current.length === 0 || entry.line === prevLine + 1) {
      current.push(entry);
    } else {
      runs.push(current);
      current = [entry];
    }
    prevLine = entry.line;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Scans a unified diff for the narrow-patch signature and returns MEDIUM
 * findings for each match. Never returns CRITICAL/HIGH — this rule is a hint,
 * not a blocker.
 *
 * Fires once per contiguous added-line run (not once per hunk): two unrelated
 * edits in the same hunk do NOT co-fire unless both the column-name gate and
 * the value-signature probe appear in the SAME added-line run.
 */
export function detectNarrowPatches(diff: string): NarrowPatchFinding[] {
  const findings: NarrowPatchFinding[] = [];
  const hunks = parseDiff(diff);

  for (const hunk of hunks) {
    if (hunk.addedLines.length === 0) continue;
    if (!isCodeFile(hunk.file)) continue;
    if (isTestFile(hunk.file)) continue;

    const runs = contiguousRuns(hunk);
    for (const run of runs) {
      const runText = run.map((l) => l.text).join("\n");

      if (!COLUMN_NAME_GATE_RE.test(runText)) continue;
      if (!VALUE_SIGNATURE_RE.test(runText)) continue;

      // Locate the specific line with the column-name gate, for a precise
      // pointer. Fall back to the first line of the run if the gate spans
      // multiple lines.
      let lineNo = run[0].line;
      for (const entry of run) {
        if (COLUMN_NAME_GATE_RE.test(entry.text)) {
          lineNo = entry.line;
          break;
        }
      }

      const snippet = trimmedSnippet(runText);
      const isRendererFile = RENDERER_PATH_RE.test(hunk.file);
      const message = buildMessage(isRendererFile);

      findings.push({
        severity: "MEDIUM",
        file: hunk.file,
        line: lineNo,
        message,
        snippet,
        relatedIncidents: ["QUA-316", "QUA-346"],
      });
    }
  }

  return findings;
}

function isCodeFile(file: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file);
}

function isTestFile(file: string): boolean {
  return /\.(?:test|spec)\.[tj]sx?$/.test(file) || file.includes("/__tests__/");
}

function trimmedSnippet(text: string): string {
  const MAX = 400;
  if (text.length <= MAX) return text;
  return text.slice(0, MAX) + "\n…";
}

function buildMessage(isRendererFile: boolean): string {
  const base =
    "Narrow-patch signature detected: the added block gates on a literal column " +
    "name AND probes the value's signature (startsWith/test/match/includes). " +
    "This is the exact shape behind QUA-316 and QUA-346, where raw `f_xxx` fact " +
    "IDs were masked one column at a time until QUA-354 replaced it with a " +
    "content-based regex. ";
  const cta =
    "Before shipping, ask: can this be content-based (match the value's shape " +
    "regardless of which column it lives in) instead of column-name-gated? If " +
    "yes, do that instead — it prevents the recurring per-column patch loop.";
  if (isRendererFile) {
    return (
      base +
      "The file path looks like a generic renderer/formatter/validator, which " +
      "makes a content-based fix especially likely to be the right call. " +
      cta
    );
  }
  return base + cta;
}

/** Pretty-print findings for CLI or review output. */
export function formatFindings(findings: NarrowPatchFinding[]): string {
  if (findings.length === 0) {
    return "narrow-patch-detector: no matches";
  }
  const lines: string[] = [];
  lines.push(`narrow-patch-detector: ${findings.length} finding(s)`);
  lines.push("");
  for (const f of findings) {
    lines.push(`[${f.severity}] ${f.file}:${f.line}`);
    lines.push(`  ${f.message}`);
    lines.push(`  related: ${f.relatedIncidents.join(", ")}`);
    lines.push("  snippet:");
    for (const s of f.snippet.split("\n").slice(0, 8)) {
      lines.push(`    ${s}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
