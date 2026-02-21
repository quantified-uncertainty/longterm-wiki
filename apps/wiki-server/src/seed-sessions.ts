/**
 * seed-sessions.ts — Migration: populate sessions + session_pages from YAML files
 *
 * Reads all .claude/sessions/*.yaml files and inserts them into PostgreSQL.
 * Safe to re-run: uses a transaction that truncates and re-inserts (idempotent full sync).
 *
 * Usage:
 *   DATABASE_URL=... tsx src/seed-sessions.ts
 *   DATABASE_URL=... tsx src/seed-sessions.ts --dry-run
 */

import { readdirSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { sql } from "drizzle-orm";
import { getDrizzleDb, initDb, closeDb } from "./db.js";
import { sessions, sessionPages } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

interface YamlSession {
  date: string | Date;
  branch?: string;
  title: string;
  summary?: string;
  model?: string;
  duration?: string;
  cost?: string;
  pr?: number | string;
  pages?: string[];
  issues?: unknown[];
  learnings?: unknown[];
  recommendations?: unknown[];
  checks?: Record<string, unknown>;
}

function normalizeDate(d: string | Date): string {
  if (d instanceof Date) return d.toISOString().split("T")[0];
  return String(d);
}

/**
 * Extract a PR URL string from the various formats:
 *   - number (123) → "https://github.com/quantified-uncertainty/longterm-wiki/pull/123"
 *   - string "#123" → same
 *   - string "https://..." → pass through
 */
function normalizePrUrl(pr: unknown): string | null {
  if (pr == null) return null;
  if (typeof pr === "number") {
    return `https://github.com/quantified-uncertainty/longterm-wiki/pull/${pr}`;
  }
  const s = String(pr);
  if (s.startsWith("http")) return s;
  const numMatch = s.match(/^#?(\d+)$/) || s.match(/\/pull\/(\d+)/);
  if (numMatch) {
    return `https://github.com/quantified-uncertainty/longterm-wiki/pull/${numMatch[1]}`;
  }
  return null;
}

/**
 * Serialize the checks object as YAML-like text for storage.
 */
function serializeChecks(checks: unknown): string | null {
  if (!checks || typeof checks !== "object") return null;
  try {
    // Store as compact YAML-like JSON
    return JSON.stringify(checks);
  } catch {
    return null;
  }
}

async function seedSessions() {
  const dryRun = process.argv.includes("--dry-run");
  const sessionsDir =
    process.env.SESSIONS_DIR ||
    resolve(__dirname, "../../../.claude/sessions");

  console.log(`Reading session logs from: ${sessionsDir}`);
  if (dryRun) console.log("DRY RUN — no database changes will be made\n");

  const files = readdirSync(sessionsDir).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml")
  );
  console.log(`Found ${files.length} YAML files\n`);

  let totalSessions = 0;
  let totalPages = 0;
  let errorFiles = 0;

  const allSessions: Array<{
    date: string;
    branch: string | null;
    title: string;
    summary: string | null;
    model: string | null;
    duration: string | null;
    cost: string | null;
    prUrl: string | null;
    checksYaml: string | null;
    issuesJson: unknown | null;
    learningsJson: unknown | null;
    recommendationsJson: unknown | null;
    pages: string[];
  }> = [];

  for (const file of files) {
    const filePath = join(sessionsDir, file);

    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = parseYaml(raw) as YamlSession;

      if (!parsed || typeof parsed !== "object") {
        console.warn(`  WARN: ${file} — not an object, skipping`);
        errorFiles++;
        continue;
      }

      if (!parsed.date || !parsed.title) {
        console.warn(`  WARN: ${file} — missing required fields (date, title), skipping`);
        errorFiles++;
        continue;
      }

      const pages = Array.isArray(parsed.pages)
        ? parsed.pages.filter(
            (id) => typeof id === "string" && PAGE_ID_RE.test(id)
          )
        : [];

      allSessions.push({
        date: normalizeDate(parsed.date),
        branch: parsed.branch ? String(parsed.branch) : null,
        title: String(parsed.title),
        summary: parsed.summary ? String(parsed.summary).trim() : null,
        model: parsed.model ? String(parsed.model) : null,
        duration: parsed.duration ? String(parsed.duration) : null,
        cost: parsed.cost ? String(parsed.cost) : null,
        prUrl: normalizePrUrl(parsed.pr),
        checksYaml: serializeChecks(parsed.checks),
        issuesJson:
          parsed.issues && Array.isArray(parsed.issues)
            ? parsed.issues
            : null,
        learningsJson:
          parsed.learnings && Array.isArray(parsed.learnings)
            ? parsed.learnings
            : null,
        recommendationsJson:
          parsed.recommendations && Array.isArray(parsed.recommendations)
            ? parsed.recommendations
            : null,
        pages,
      });

      totalSessions++;
      totalPages += pages.length;
    } catch (err) {
      console.warn(`  ERROR: ${file} — ${err}`);
      errorFiles++;
    }
  }

  console.log(
    `Parsed ${totalSessions} sessions with ${totalPages} page associations` +
      (errorFiles > 0 ? ` (${errorFiles} files had errors)` : "")
  );

  if (dryRun) {
    console.log("\nDry run summary:");
    console.log(`  Total sessions: ${totalSessions}`);
    console.log(`  Total page associations: ${totalPages}`);
    console.log(
      `  Sessions with pages: ${allSessions.filter((s) => s.pages.length > 0).length}`
    );

    const modelCounts: Record<string, number> = {};
    for (const s of allSessions) {
      const m = s.model || "(none)";
      modelCounts[m] = (modelCounts[m] || 0) + 1;
    }
    console.log("  By model:", modelCounts);
    return;
  }

  // Insert into database using Drizzle batch inserts
  await initDb();
  const db = getDrizzleDb();

  const BATCH_SIZE = 500;
  let insertedSessions = 0;
  let insertedPages = 0;

  await db.transaction(async (tx) => {
    // Truncate for idempotent re-runs (session_pages has ON DELETE CASCADE)
    await tx.execute(sql`TRUNCATE sessions RESTART IDENTITY CASCADE`);
    console.log("Truncated sessions + session_pages tables");

    // Batch insert sessions, collecting page associations
    const allPageAssocs: Array<{ sessionId: number; pageId: string }> = [];

    for (let i = 0; i < allSessions.length; i += BATCH_SIZE) {
      const batch = allSessions.slice(i, i + BATCH_SIZE);
      const rows = await tx
        .insert(sessions)
        .values(
          batch.map((s) => ({
            date: s.date,
            branch: s.branch,
            title: s.title,
            summary: s.summary,
            model: s.model,
            duration: s.duration,
            cost: s.cost,
            prUrl: s.prUrl,
            checksYaml: s.checksYaml,
            issuesJson: s.issuesJson,
            learningsJson: s.learningsJson,
            recommendationsJson: s.recommendationsJson,
          }))
        )
        .returning({ id: sessions.id });

      insertedSessions += rows.length;

      // Match returned IDs to input sessions (insertion order is preserved)
      for (let j = 0; j < rows.length; j++) {
        for (const pageId of batch[j].pages) {
          allPageAssocs.push({ sessionId: rows[j].id, pageId });
        }
      }

      if (insertedSessions % 50 === 0 && i + BATCH_SIZE < allSessions.length) {
        console.log(
          `  Inserted ${insertedSessions} / ${allSessions.length} sessions...`
        );
      }
    }

    // Batch insert all page associations
    for (let i = 0; i < allPageAssocs.length; i += BATCH_SIZE) {
      const batch = allPageAssocs.slice(i, i + BATCH_SIZE);
      await tx.insert(sessionPages).values(batch);
      insertedPages += batch.length;
    }
  });

  console.log(
    `\nSeed complete: ${insertedSessions} sessions, ${insertedPages} page associations`
  );

  await closeDb();
}

seedSessions().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
