#!/usr/bin/env node
/**
 * Backfill `createdAt` frontmatter for MDX/MD pages that don't have it.
 *
 * Uses `git log --follow` to find the earliest commit that added each file,
 * following renames. Inserts `createdAt: YYYY-MM-DD` (unquoted YAML date)
 * after `lastEdited:`, or before the closing `---` if `lastEdited:` is absent.
 *
 * Note: ~88% of pages were added in the initial repo import on 2026-02-09.
 * Those pages will receive that date — it reflects when they entered git, not
 * the original content creation date (which predates this repo).
 *
 * Usage:
 *   node apps/web/scripts/backfill-created-at.mjs           # dry run (shows changes)
 *   node apps/web/scripts/backfill-created-at.mjs --apply   # write changes to disk
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { resolve, relative, join } from "path";

const APPLY = process.argv.includes("--apply");
const REPO_ROOT = resolve(import.meta.dirname, "../../../");
const CONTENT_DIR = resolve(REPO_ROOT, "content/docs");

/** Return earliest git commit date for a file (YYYY-MM-DD), or null. */
function getGitCreatedDate(filePath) {
  const relPath = relative(REPO_ROOT, filePath);
  try {
    // --follow handles renames so we find the true origin date
    const output = execFileSync(
      "git",
      ["log", "--follow", "--format=%ad", "--date=short", "--", relPath],
      { cwd: REPO_ROOT, encoding: "utf8" }
    ).trim();
    if (!output) return null;
    // Last line is the oldest commit date
    const lines = output.split("\n").filter(Boolean);
    return lines[lines.length - 1] ?? null;
  } catch {
    return null;
  }
}

/** Insert createdAt after lastEdited line, or before closing --- */
function insertCreatedAt(content, date) {
  const lines = content.split("\n");

  // Find frontmatter boundaries
  if (lines[0] !== "---") return null; // No frontmatter
  const closingIdx = lines.indexOf("---", 1);
  if (closingIdx === -1) return null;

  // Find where to insert (after lastEdited if present)
  const lastEditedIdx = lines
    .slice(0, closingIdx)
    .findIndex((l) => l.startsWith("lastEdited:"));

  const insertAfter = lastEditedIdx !== -1 ? lastEditedIdx : closingIdx - 1;

  lines.splice(insertAfter + 1, 0, `createdAt: ${date}`);
  return lines.join("\n");
}

/** Recursively find all .mdx and .md files under a directory. */
function findContentFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findContentFiles(full));
    } else if (entry.endsWith(".mdx") || entry.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function main() {
  const files = findContentFiles(CONTENT_DIR);
  files.sort();

  console.log(`Found ${files.length} content files.`);

  let missing = 0;
  let updated = 0;
  let skipped = 0;
  let noGit = 0;

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf8");

    // Check if createdAt already present in frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      skipped++;
      continue;
    }
    if (/^createdAt:/m.test(frontmatterMatch[1])) {
      // Already has createdAt — skip
      continue;
    }

    missing++;
    const date = getGitCreatedDate(filePath);
    if (!date) {
      noGit++;
      console.warn(`  [NO GIT DATE] ${relative(REPO_ROOT, filePath)}`);
      continue;
    }

    const newContent = insertCreatedAt(content, date);
    if (!newContent) {
      skipped++;
      continue;
    }

    const rel = relative(REPO_ROOT, filePath);
    if (APPLY) {
      writeFileSync(filePath, newContent, "utf8");
      console.log(`  [UPDATED] ${rel} → createdAt: ${date}`);
    } else {
      console.log(`  [DRY RUN] ${rel} → createdAt: ${date}`);
    }
    updated++;
  }

  const alreadyHad = files.length - missing - skipped;
  console.log(`\nSummary:`);
  console.log(`  Total files:            ${files.length}`);
  console.log(`  Already have createdAt: ${alreadyHad}`);
  console.log(`  Missing createdAt:      ${missing}`);
  console.log(`  ${APPLY ? "Updated" : "Would update"}:            ${updated}`);
  if (noGit > 0) console.log(`  No git date found:      ${noGit}`);
  if (skipped > 0) console.log(`  Skipped (no FM):        ${skipped}`);

  if (!APPLY && missing > 0) {
    console.log(`\nRun with --apply to write changes.`);
  }
}

main();
