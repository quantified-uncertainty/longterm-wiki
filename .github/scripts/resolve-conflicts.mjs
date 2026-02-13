#!/usr/bin/env node

/**
 * Claude-powered merge conflict resolver.
 *
 * Called by the resolve-conflicts GitHub Action when a PR has merge conflicts.
 * Attempts `git merge main`, reads conflict markers, sends each file to Claude
 * for resolution, then commits and pushes the result.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY — required
 *   PR_BRANCH        — the branch to resolve conflicts on
 *   PR_NUMBER         — PR number (for commit message)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PR_BRANCH = process.env.PR_BRANCH;
const PR_NUMBER = process.env.PR_NUMBER;

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set — skipping conflict resolution.");
  process.exit(0);
}
if (!PR_BRANCH) {
  console.error("PR_BRANCH is not set.");
  process.exit(1);
}

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts });
}

function runSafe(cmd) {
  try {
    return { ok: true, output: run(cmd) };
  } catch (e) {
    return { ok: false, output: e.stdout || "", stderr: e.stderr || "", code: e.status };
  }
}

// ── Step 1: Attempt the merge ──────────────────────────────────────────

console.log(`\n=== Resolving conflicts for PR #${PR_NUMBER} on branch ${PR_BRANCH} ===\n`);

run("git fetch origin main");
run(`git fetch origin ${PR_BRANCH}`);
run(`git checkout ${PR_BRANCH}`);
// Reset to remote state to ensure clean starting point
run(`git reset --hard origin/${PR_BRANCH}`);

const mergeResult = runSafe("git merge origin/main --no-edit");

if (mergeResult.ok) {
  console.log("No conflicts — merge succeeded cleanly.");
  process.exit(0);
}

// ── Step 2: Identify conflicted files ──────────────────────────────────

const conflictedFiles = run("git diff --name-only --diff-filter=U").trim().split("\n").filter(Boolean);

if (conflictedFiles.length === 0) {
  console.log("Merge failed but no conflicted files detected — aborting.");
  run("git merge --abort");
  process.exit(1);
}

console.log(`\nConflicted files (${conflictedFiles.length}):`);
conflictedFiles.forEach((f) => console.log(`  - ${f}`));

// ── Step 3: Resolve each file with Claude ──────────────────────────────

const SYSTEM_PROMPT = `You are a merge conflict resolver for a wiki repository containing MDX pages and YAML data files.

You will receive a file with Git merge conflict markers (<<<<<<< HEAD, =======, >>>>>>> origin/main).

Rules:
1. KEEP BOTH SIDES' changes whenever possible — both the PR's changes and main's changes are intentional.
2. For MDX content files: preserve all content from both sides. If both sides added different sections, include both. If both modified the same section, merge the intent of both changes.
3. For YAML data files: merge entries from both sides. If the same key was modified differently, prefer the PR's version but include any new entries from main.
4. For JSON files (like package.json): merge carefully, keeping both sides' additions. For version conflicts, prefer the higher version.
5. For frontmatter: merge all fields from both sides. If the same field has different values, prefer the PR's version.
6. NEVER leave conflict markers (<<<<<<, =======, >>>>>>>) in the output.
7. Output ONLY the resolved file content — no explanations, no markdown code fences.

Think carefully about the semantic intent of both sides before resolving.`;

async function resolveFile(filePath) {
  const content = readFileSync(filePath, "utf-8");

  // Skip binary files
  if (content.includes("\0")) {
    console.log(`  Skipping binary file: ${filePath}`);
    return false;
  }

  // Verify it actually has conflict markers
  if (!content.includes("<<<<<<<")) {
    console.log(`  No conflict markers in ${filePath} — skipping.`);
    run(`git add "${filePath}"`);
    return true;
  }

  console.log(`  Resolving: ${filePath} (${content.length} chars)`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 16384,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Resolve the merge conflicts in this file (${filePath}):\n\n${content}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`  API error for ${filePath}: ${response.status} ${errText}`);
    return false;
  }

  const data = await response.json();
  const resolvedContent = data.content?.[0]?.text;

  if (!resolvedContent) {
    console.error(`  Empty response for ${filePath}`);
    return false;
  }

  // Safety check: make sure no conflict markers remain
  if (resolvedContent.includes("<<<<<<<") || resolvedContent.includes(">>>>>>>")) {
    console.error(`  Resolution for ${filePath} still contains conflict markers — skipping.`);
    return false;
  }

  writeFileSync(filePath, resolvedContent);
  run(`git add "${filePath}"`);
  console.log(`  Resolved: ${filePath}`);
  return true;
}

let resolved = 0;
let failed = 0;

for (const file of conflictedFiles) {
  try {
    const success = await resolveFile(file);
    if (success) resolved++;
    else failed++;
  } catch (err) {
    console.error(`  Error resolving ${file}: ${err.message}`);
    failed++;
  }
}

console.log(`\n=== Results: ${resolved} resolved, ${failed} failed ===\n`);

// ── Step 4: Commit and push, or abort ──────────────────────────────────

if (failed > 0) {
  console.error("Some files could not be resolved — aborting merge.");
  run("git merge --abort");
  process.exit(1);
}

// Check if there are still unresolved conflicts
const remaining = runSafe("git diff --name-only --diff-filter=U");
if (remaining.ok && remaining.output.trim()) {
  console.error("Unresolved files remain — aborting merge.");
  run("git merge --abort");
  process.exit(1);
}

// Commit the merge
run(`git commit --no-edit`);
console.log("Merge committed successfully.");

// Push
const pushResult = runSafe(`git push origin ${PR_BRANCH}`);
if (!pushResult.ok) {
  console.error(`Push failed: ${pushResult.stderr}`);
  process.exit(1);
}

console.log(`\nConflicts resolved and pushed to ${PR_BRANCH}.`);
