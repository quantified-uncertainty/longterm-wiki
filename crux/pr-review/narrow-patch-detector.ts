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
 *   1. A column-name-literal equality gate, e.g. `columnName === "fact_id"` or
 *      `column.name === "x"` or `field.name === "y"`.
 *   2. A value-signature probe: `.startsWith(`, `.endsWith(`, `.test(`,
 *      `.match(`, `.includes(` on the value itself.
 *
 * False-positive guards:
 *   - Pure formatting blocks (`toFixed`, `Intl.NumberFormat`, `formatCurrency`,
 *     `formatPercent`, `toLocaleString`) that do NOT probe the value's signature
 *     are allowed through — they transform the value rather than masking it.
 *   - Diffs without both a column-name gate AND a value probe never fire.
 *   - Test files are skipped (test fixtures deliberately contain the signature).
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

// Matches `columnName === "fact_id"`, `column.name === 'x'`, `field.name === \`y\``,
// and the loose `key === "literal"` shape. Uses `===` or `==`.
const COLUMN_NAME_GATE_RE =
  /\b(?:columnName|fieldName|column\.name|col\.name|field\.name|colName|key)\s*===?\s*["'`][A-Za-z_][\w-]*["'`]/;

// Matches `.startsWith(`, `.endsWith(`, `.test(`, `.match(`, `.includes(` on any
// receiver. These are "probe the value for a signature" calls — the exact
// anti-pattern in QUA-316/QUA-346.
const VALUE_SIGNATURE_RE = /\.\s*(?:startsWith|endsWith|includes|test|match)\s*\(/;

// Pure-formatting calls that transform (not probe) the value. If an added block
// only contains these (and no VALUE_SIGNATURE_RE match), we ignore it. This is
// defensive — the primary filter is requiring a VALUE_SIGNATURE_RE hit.
const FORMATTING_RE =
  /\b(?:toFixed|toLocaleString|Intl\.NumberFormat|formatCurrency|formatPercent|formatNumber|formatValue)\b/;

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
 */
export function parseDiff(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  const parts = diff.split(/^diff --git /m);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const firstNewline = block.indexOf("\n");
    const header = firstNewline === -1 ? block : block.slice(0, firstNewline);
    const bMatch = header.match(/\bb\/(.+)$/);
    if (!bMatch) continue;
    const file = bMatch[1].trim();

    const lines = block.split("\n");
    let j = 0;
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
        if (raw.startsWith("+++") || raw.startsWith("---")) {
          j++;
          continue;
        }
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
          cursor++;
        } else {
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
 * Scans a unified diff for the narrow-patch signature and returns MEDIUM
 * findings for each match. Never returns CRITICAL/HIGH — this rule is a hint,
 * not a blocker.
 */
export function detectNarrowPatches(diff: string): NarrowPatchFinding[] {
  const findings: NarrowPatchFinding[] = [];
  const hunks = parseDiff(diff);

  for (const hunk of hunks) {
    if (hunk.addedLines.length === 0) continue;
    if (!isCodeFile(hunk.file)) continue;
    if (isTestFile(hunk.file)) continue;

    const addedText = hunk.addedLines.map((l) => l.text).join("\n");

    const hasColumnGate = COLUMN_NAME_GATE_RE.test(addedText);
    const hasValueProbe = VALUE_SIGNATURE_RE.test(addedText);

    if (!hasColumnGate || !hasValueProbe) continue;

    const isPureFormatter =
      FORMATTING_RE.test(addedText) && !VALUE_SIGNATURE_RE.test(addedText);
    if (isPureFormatter) continue;

    let lineNo = hunk.newStartLine;
    for (const entry of hunk.addedLines) {
      if (COLUMN_NAME_GATE_RE.test(entry.text)) {
        lineNo = entry.line;
        break;
      }
    }

    const snippet = trimmedSnippet(addedText);
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
