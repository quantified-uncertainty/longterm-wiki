/**
 * Narrow-patch detector (QUA-356). Advisory review-time scanner for the
 * "column-name-gated value probe" pattern — a diff shape that historically
 * masked class-shaped bugs behind per-column patches (QUA-316 → QUA-346 →
 * QUA-354). Fires MEDIUM when an added contiguous run contains BOTH a column
 * identifier strict-equality gate AND a value-signature probe method call.
 *
 * Skips test files and non-code files. Both patterns must land in the same
 * contiguous run so two unrelated edits in one hunk don't co-fire.
 */

export interface NarrowPatchFinding {
  severity: "MEDIUM";
  file: string;
  line: number;
  message: string;
  snippet: string;
  relatedIncidents: string[];
}

// Column identifier strict-equality tested against a quoted string literal.
// Intentionally excludes bare `key`/`name` (too broad — common object-lookup
// idioms).
const COLUMN_NAME_GATE_RE =
  /\b(?:columnName|fieldName|colName|column\.name|col\.name|field\.name|\w+\.column)\s*===?\s*["'`][A-Za-z_][\w-]*["'`]/;

// Value-signature probe: one of startsWith, endsWith, includes, test, match,
// search, or exec invoked via dot-call on any receiver.
const VALUE_SIGNATURE_RE =
  /\.\s*(?:startsWith|endsWith|includes|test|match|search|exec)\s*\(/;

// Renderer/formatter/validator path hint — used only to strengthen the
// message, not to gate firing.
const RENDERER_PATH_RE =
  /(?:render|cell|column|viewer|display|formatter|format-|validate-|validator)/i;

const RELATED_INCIDENTS: readonly string[] = ["QUA-316", "QUA-346"];

interface AddedLine {
  line: number;
  text: string;
}

interface ParsedHunk {
  file: string;
  newStartLine: number;
  addedLines: AddedLine[];
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
      const added: AddedLine[] = [];
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
function contiguousRuns(hunk: ParsedHunk): AddedLine[][] {
  const runs: AddedLine[][] = [];
  let current: AddedLine[] = [];
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
        relatedIncidents: [...RELATED_INCIDENTS],
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

const MESSAGE_BASE =
  "Narrow-patch signature detected: the added block gates on a literal column " +
  "name AND probes the value's signature (startsWith/test/match/includes). " +
  "This is the exact shape behind QUA-316 and QUA-346, where raw `f_xxx` fact " +
  "IDs were masked one column at a time until QUA-354 replaced it with a " +
  "content-based regex. ";

const MESSAGE_RENDERER_NOTE =
  "The file path looks like a generic renderer/formatter/validator, which " +
  "makes a content-based fix especially likely to be the right call. ";

const MESSAGE_CTA =
  "Before shipping, ask: can this be content-based (match the value's shape " +
  "regardless of which column it lives in) instead of column-name-gated? If " +
  "yes, do that instead — it prevents the recurring per-column patch loop.";

function buildMessage(isRendererFile: boolean): string {
  return MESSAGE_BASE + (isRendererFile ? MESSAGE_RENDERER_NOTE : "") + MESSAGE_CTA;
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
