#!/usr/bin/env node

/**
 * Validate that no AIID report-body fields are persisted.
 *
 * The MIT AI Incident Database snapshot is CC-BY-SA 4.0 with EXCLUSIONS:
 * `submissions` collection and `reports.text` / `reports.plain_text` are
 * explicitly NOT under CC-BY-SA and we must not mirror them.
 *
 * This validator is static — it greps the AIID ingest code paths for
 * symptoms of re-introducing those fields. A runtime check against the DB
 * would be nice to have but slow; the static check is enough to fail PR.
 *
 * Symptoms that fail:
 *   - `ai_incident_reports` schema referencing a `text` / `plain_text` column
 *   - Route handlers on `/api/ai-incidents` inserting either of those keys
 *   - Transform code mapping `plain_text` / `text` into output
 *
 * Scope (file allowlist):
 *   - apps/wiki-server/src/schema.ts                          (just the ai_incident_reports block)
 *   - apps/wiki-server/src/routes/tablebase/ai-incidents.ts
 *   - apps/wiki-server/drizzle/0205_qua_693_ai_incidents.sql
 *   - crux/lib/aiid/**.ts
 *
 * Escape hatch: add `// aiid-report-text-ok: <reason>` at the end of the line
 * (e.g. for the validator's own test fixtures or the sanitizeRawReport
 * function which mentions these keys by design).
 *
 * Usage: npx tsx crux/validate/validate-aiid-no-report-text.ts
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { getColors } from "../lib/output.ts";

// Files to scan. Keep narrow — this is a targeted defence.
const FILES: string[] = [
  "apps/wiki-server/src/routes/tablebase/ai-incidents.ts",
  "apps/wiki-server/drizzle/0205_qua_693_ai_incidents.sql",
];

const DIRS: string[] = ["crux/lib/aiid"];

// The schema.ts file is large; we only care about the ai_incident_reports
// block. Extract it by looking for `aiIncidentReports = pgTable` and the next
// `);` balanced closer (first line starting with `);` after the declaration).
const SCHEMA_FILE = "apps/wiki-server/src/schema.ts";

// Patterns that indicate we're persisting report body text.
const BANNED_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Column on a reports-like table named `text` or `plain_text`.
  {
    re: /\b(text|plain_text|plainText)\s*:\s*text\(/g,
    label: "Drizzle column `text`/`plain_text` on reports table",
  },
  // SQL column declaration.
  {
    re: /\b"(text|plain_text)"\s+text\b/gi,
    label: "SQL column `text`/`plain_text` on reports table",
  },
  // Object literal key that would land in a sync payload.
  {
    re: /\b(text|plainText|plain_text)\s*:\s*r\.(text|plain_text|plainText)\b/g,
    label: "Object literal mapping report body to output",
  },
];

const OK_MARKER = "aiid-report-text-ok";

interface Violation {
  file: string;
  line: number;
  label: string;
  snippet: string;
}

interface CheckResult {
  passed: boolean;
  errors: number;
  violations: Violation[];
}

function scanContent(
  path: string,
  content: string,
  violations: Violation[],
): void {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(OK_MARKER)) continue;
    for (const { re, label } of BANNED_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) {
        violations.push({
          file: path,
          line: i + 1,
          label,
          snippet: line.trim().slice(0, 200),
        });
      }
    }
  }
}

function extractAiIncidentReportsBlock(content: string): string | null {
  const re = /export const aiIncidentReports = pgTable\([\s\S]*?\n\);/m;
  const match = content.match(re);
  return match ? match[0] : null;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const stack: string[] = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
        out.push(full);
    }
  }
  return out;
}

export function runCheck(): CheckResult {
  const c = getColors();
  console.log(
    `${c.blue}Checking AIID ingest paths for CC-BY-SA-excluded report body persistence...${c.reset}\n`,
  );

  const violations: Violation[] = [];

  // 1. Explicit file list.
  for (const path of FILES) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    scanContent(path, content, violations);
  }

  // 2. Schema block.
  if (existsSync(SCHEMA_FILE)) {
    const schemaContent = readFileSync(SCHEMA_FILE, "utf-8");
    const block = extractAiIncidentReportsBlock(schemaContent);
    if (block) scanContent(SCHEMA_FILE, block, violations);
  }

  // 3. AIID lib dirs.
  for (const dir of DIRS) {
    for (const path of walkTs(dir)) {
      const content = readFileSync(path, "utf-8");
      scanContent(path, content, violations);
    }
  }

  if (violations.length === 0) {
    console.log(
      `${c.green}No banned AIID report-body patterns found.${c.reset}`,
    );
    return { passed: true, errors: 0, violations: [] };
  }

  console.log(
    `${c.red}Found ${violations.length} AIID report-body violation(s):${c.reset}\n`,
  );
  for (const v of violations) {
    console.log(`  ${c.red}${v.file}:${v.line}${c.reset}  ${v.label}`);
    console.log(`    ${c.dim}${v.snippet}${c.reset}`);
  }
  console.log();
  console.log(
    `${c.dim}AIID snapshots are CC-BY-SA 4.0 EXCEPT for \`submissions\` and \`reports.text\`/\`reports.plain_text\`.${c.reset}`,
  );
  console.log(
    `${c.dim}We must not mirror those fields. If this is a false positive, append \`// ${OK_MARKER}: <reason>\` to the line.${c.reset}`,
  );

  return { passed: false, errors: violations.length, violations };
}

function main(): void {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly = (() => {
  try {
    const self = new URL(import.meta.url).pathname;
    return (
      process.argv[1] === self || process.argv[1]?.endsWith("validate-aiid-no-report-text.ts")
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
