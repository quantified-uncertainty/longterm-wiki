/** Validate SourceCheckDot never appears as the first column in a table. */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";

interface Violation { file: string; line: number; reason: string }
function collectTsx(dir: string): string[] {
  const r: string[] = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      try {
        if (statSync(f).isDirectory()) { if (e !== "node_modules" && e !== "__tests__") walk(f); }
        else if (e.endsWith(".tsx")) r.push(f);
      } catch {}
    }
  })(dir);
  return r;
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, "utf-8");
  if (!content.includes("SourceCheckDot")) return [];
  const lines = content.split("\n"), vs: Violation[] = [], rel = relative(PROJECT_ROOT, filePath);

  // HTML tables: check if first <td> in any <tr> contains SourceCheckDot
  let inTr = false, inFirstTd = false, tdDone = false, tdStart = -1, tdBuf = "";
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.includes("<tr")) { inTr = true; tdDone = false; }
    if (inTr && !tdDone && !inFirstTd && ln.includes("<td")) {
      inFirstTd = true; tdStart = i; tdBuf = ln;
    } else if (inFirstTd) { tdBuf += "\n" + ln; }
    if (inFirstTd && ln.includes("</td")) {
      if (tdBuf.includes("SourceCheckDot"))
        vs.push({ file: rel, line: tdStart + 1, reason: "SourceCheckDot in first <td> of table row" });
      inFirstTd = false; tdDone = true; tdBuf = "";
    }
    if (ln.includes("</tr")) { inTr = false; inFirstTd = false; tdDone = false; tdBuf = ""; }
  }
  // TanStack columns: SourceCheckDot column before name/title column
  let dotLine = -1, nameLine = -1; for (let i = 0; i < lines.length; i++) {
    if (dotLine === -1 && /SourceCheckDot/.test(lines[i])) dotLine = i;
    if (nameLine === -1 && /accessorKey:\s*["'](name|title)["']/.test(lines[i])) nameLine = i;
  }
  if (dotLine !== -1 && nameLine !== -1 && dotLine < nameLine)
    vs.push({ file: rel, line: dotLine + 1, reason: "SourceCheckDot column before name/title column" });
  return vs;
}

export function runCheck() {
  const dirs = [join(PROJECT_ROOT, "apps/web/src/app"), join(PROJECT_ROOT, "apps/web/src/components")];
  const vs = dirs.flatMap(collectTsx).flatMap(checkFile);
  if (vs.length === 0) console.log("SourceCheckDot position check passed");
  else { console.error(`SourceCheckDot position violations (${vs.length}):\n`);
    for (const v of vs) console.error(`  ${v.file}:${v.line} — ${v.reason}`); }
  return { passed: vs.length === 0, errors: vs.length, violations: vs };
}

if (process.argv[1]?.includes("validate-dot-position")) process.exit(runCheck().passed ? 0 : 1);
