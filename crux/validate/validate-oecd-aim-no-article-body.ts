#!/usr/bin/env node

/**
 * Validate that no OECD AI Incident Monitor (AIM) article body fields are
 * persisted.
 *
 * The OECD AIM has no explicit open-data license at oecd.ai. Per QUA-696
 * the conservative default is "metadata + link-out only" — we mirror title,
 * date, summary, evidences, and per-article URL/title/publisher/date but
 * NEVER article body text.
 *
 * Empirically the AIM detail endpoint always returns `body: ""` for
 * articles, but if upstream ever populates that field, our ingest would
 * silently start storing it. This validator is the static defence: it
 * greps the OECD AIM ingest code paths for symptoms of re-introducing
 * `body`/`thumbImage` and the `ai_incidents` route for new columns matching
 * the same pattern.
 *
 * Symptoms that fail:
 *   - `ai_incident_reports` schema referencing a `body`/`text`/`plain_text`
 *     or `thumbImage` column
 *   - Route handlers on `/api/ai-incidents` inserting any of those keys
 *   - OECD AIM transform code mapping `article.body`/`article.thumbImage`
 *     into output
 *
 * Scope (file allowlist):
 *   - apps/wiki-server/src/routes/tablebase/ai-incidents.ts
 *   - apps/wiki-server/drizzle/0214_qua_693_ai_incidents.sql
 *   - apps/wiki-server/drizzle/0219_qua_696_widen_ai_incidents_source.sql
 *   - crux/lib/oecd-aim/**.ts
 *
 * Escape hatch: append `// oecd-aim-article-body-ok: <reason>` to a line
 * (e.g. for the validator's own test fixtures or for sanitizeRawArticle
 * which mentions these keys by design).
 *
 * Usage: npx tsx crux/validate/validate-oecd-aim-no-article-body.ts
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { getColors } from "../lib/output.ts";

const FILES: string[] = [
  "apps/wiki-server/src/routes/tablebase/ai-incidents.ts",
  "apps/wiki-server/drizzle/0214_qua_693_ai_incidents.sql",
  "apps/wiki-server/drizzle/0219_qua_696_widen_ai_incidents_source.sql",
];

const DIRS: string[] = ["crux/lib/oecd-aim"];

const SCHEMA_FILE = "apps/wiki-server/src/schema.ts";

const BANNED_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Drizzle column declarations on the reports table.
  {
    re: /\b(body|text|plain_text|plainText|thumbImage|thumb_image)\s*:\s*text\(/g,
    label: "Drizzle column for article body / thumb image on reports table",
  },
  // SQL column declarations.
  {
    re: /\b"(body|text|plain_text|thumb_image)"\s+text\b/gi,
    label: "SQL column for article body / thumb image",
  },
  // Object literal keys piping article body into output.
  {
    re: /\b(body|plain_text|plainText|thumbImage|thumb_image)\s*:\s*[a-zA-Z_]+\.(body|plain_text|plainText|thumbImage|thumb_image)\b/g,
    label: "Object literal mapping article body/thumb to output",
  },
];

const OK_MARKER = "oecd-aim-article-body-ok";

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
    `${c.blue}Checking OECD AIM ingest paths for article body persistence...${c.reset}\n`,
  );

  const violations: Violation[] = [];

  for (const path of FILES) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    scanContent(path, content, violations);
  }

  if (existsSync(SCHEMA_FILE)) {
    const schemaContent = readFileSync(SCHEMA_FILE, "utf-8");
    const block = extractAiIncidentReportsBlock(schemaContent);
    if (block) scanContent(SCHEMA_FILE, block, violations);
  }

  for (const dir of DIRS) {
    for (const path of walkTs(dir)) {
      const content = readFileSync(path, "utf-8");
      scanContent(path, content, violations);
    }
  }

  if (violations.length === 0) {
    console.log(
      `${c.green}No banned OECD AIM article-body patterns found.${c.reset}`,
    );
    return { passed: true, errors: 0, violations: [] };
  }

  console.log(
    `${c.red}Found ${violations.length} OECD AIM article-body violation(s):${c.reset}\n`,
  );
  for (const v of violations) {
    console.log(`  ${c.red}${v.file}:${v.line}${c.reset}  ${v.label}`);
    console.log(`    ${c.dim}${v.snippet}${c.reset}`);
  }
  console.log();
  console.log(
    `${c.dim}OECD AIM has no explicit open-data license. We mirror metadata + link-out only — never article body text.${c.reset}`,
  );
  console.log(
    `${c.dim}If this is a false positive, append \`// ${OK_MARKER}: <reason>\` to the line.${c.reset}`,
  );

  return { passed: false, errors: violations.length, violations };
}

function main(): void {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try {
    const self = new URL(import.meta.url).pathname;
    return (
      process.argv[1] === self ||
      process.argv[1]?.endsWith("validate-oecd-aim-no-article-body.ts")
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
