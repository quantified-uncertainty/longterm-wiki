#!/usr/bin/env node

/**
 * Claude-powered merge conflict resolver.
 *
 * Called by the resolve-conflicts GitHub Action when a PR has merge conflicts.
 * Attempts `git merge main`, reads conflict markers, sends each file to Claude
 * for resolution, then commits and pushes the result.
 *
 * For small files (<32K chars): sends the entire file to Claude.
 * For large files (>=32K chars): extracts individual conflict hunks with
 * surrounding context and resolves each one separately. This avoids API
 * timeouts (502 errors) on large YAML data files.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY — required
 *   PR_BRANCH        — the branch to resolve conflicts on
 *   PR_NUMBER         — PR number (for commit message)
 *   GITHUB_OUTPUT     — (optional) path to write diagnostic summary for the workflow
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { findConflictBlocks, tryResolveFrontmatterOnly } from "./lib/conflict-resolution.mjs";

const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/^["'\s]+|["'\s]+$/g, '');
const PR_BRANCH = process.env.PR_BRANCH;
const PR_NUMBER = process.env.PR_NUMBER;

// ── Input validation ───────────────────────────────────────────────────

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set — cannot resolve conflicts.");
  process.exit(1); // Exit non-zero so the workflow posts a failure comment, not a success one
}
if (!PR_BRANCH) {
  console.error("PR_BRANCH is not set.");
  process.exit(1);
}

// Validate branch name to prevent any injection via crafted ref names.
// Git branch names can contain alphanumeric, /, -, _, and .
if (!/^[a-zA-Z0-9._\/-]+$/.test(PR_BRANCH)) {
  console.error(`Invalid branch name: ${PR_BRANCH}`);
  process.exit(1);
}

const MAX_CONFLICTED_FILES = 50;
const LARGE_FILE_THRESHOLD = 32_000; // chars — files above this use hunk-by-hunk resolution
const CONTEXT_LINES = 20; // lines of context around each conflict hunk

// ── Diagnostic tracking ──────────────────────────────────────────────

// Collects per-file diagnostics for the failure comment
const diagnostics = [];

function addDiagnostic(file, status, reason) {
  diagnostics.push({ file, status, reason });
}

// Write a summary to GITHUB_OUTPUT so the workflow can include it in PR comments
function writeDiagnosticSummary() {
  if (!process.env.GITHUB_OUTPUT) return;

  const lines = diagnostics.map((d) => `- \`${d.file}\`: ${d.status} — ${d.reason}`);
  const summary = lines.join("\\n");

  try {
    appendFileSync(process.env.GITHUB_OUTPUT, `diagnostic_summary<<DIAGEOF\n${lines.join("\n")}\nDIAGEOF\n`);
  } catch {
    // Not critical — workflow comment will just lack detail
  }
}

// ── Shell-free git helpers ─────────────────────────────────────────────

// Use execFileSync (no shell) to prevent command injection.
function git(...args) {
  const display = `$ git ${args.join(" ")}`;
  console.log(display);
  return execFileSync("git", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function gitSafe(...args) {
  try {
    return { ok: true, output: git(...args) };
  } catch (e) {
    return { ok: false, output: e.stdout || "", stderr: e.stderr || "", code: e.status };
  }
}

// ── Step 1: Attempt the merge ──────────────────────────────────────────

console.log(`\n=== Resolving conflicts for PR #${PR_NUMBER} on branch ${PR_BRANCH} ===\n`);

git("fetch", "origin", "main");
git("fetch", "origin", PR_BRANCH);
git("checkout", PR_BRANCH);
// Reset to remote state to ensure clean starting point
git("reset", "--hard", `origin/${PR_BRANCH}`);

const mergeResult = gitSafe("merge", "origin/main", "--no-edit");

if (mergeResult.ok) {
  console.log("No conflicts — merge succeeded cleanly.");
  process.exit(0);
}

// ── Step 2: Identify conflicted files ──────────────────────────────────

const conflictedFiles = git("diff", "--name-only", "--diff-filter=U").trim().split("\n").filter(Boolean);

if (conflictedFiles.length === 0) {
  console.log("Merge failed but no conflicted files detected — aborting.");
  gitSafe("merge", "--abort");
  process.exit(1);
}

if (conflictedFiles.length > MAX_CONFLICTED_FILES) {
  console.error(
    `Too many conflicted files (${conflictedFiles.length} > ${MAX_CONFLICTED_FILES}) — aborting to avoid excessive API cost.`
  );
  gitSafe("merge", "--abort");
  process.exit(1);
}

console.log(`\nConflicted files (${conflictedFiles.length}):`);
conflictedFiles.forEach((f) => console.log(`  - ${f}`));

// ── Step 3: Resolve each file with Claude ──────────────────────────────

const SYSTEM_PROMPT = `You are a merge conflict resolver for a wiki repository containing MDX pages, TypeScript source code, and YAML data files.

You will receive a file with Git merge conflict markers (<<<<<<< HEAD, =======, >>>>>>> origin/main).

Rules:
1. KEEP BOTH SIDES' changes whenever possible — both the PR's changes and main's changes are intentional.
2. For TypeScript/JavaScript source code: understand the semantic intent of both sides. If main refactored interfaces into type aliases, shared utilities, etc., prefer main's cleaner approach but keep any new functionality from the PR side. Pay attention to imports and ensure all used symbols are imported.
3. For MDX content files: preserve all content from both sides. If both sides added different sections, include both. If both modified the same section, merge the intent of both changes.
4. For YAML data files: merge entries from both sides. If the same key was modified differently, prefer the PR's version but include any new entries from main.
5. For JSON files (like package.json): merge carefully, keeping both sides' additions. For version conflicts, prefer the higher version.
6. For frontmatter: merge all fields from both sides. If the same field has different values, prefer the PR's version.
7. NEVER leave conflict markers (<<<<<<, =======, >>>>>>>) in the output.
8. Output ONLY the resolved file content — no explanations, no markdown code fences, no \`\`\` wrappers.

Think carefully about the semantic intent of both sides before resolving.`;

const HUNK_SYSTEM_PROMPT = `You are a merge conflict resolver for a wiki repository.

You will receive a SECTION of a larger file. The section contains a Git merge conflict (<<<<<<< HEAD, =======, >>>>>>> origin/main) surrounded by context lines for reference.

Rules:
1. KEEP BOTH SIDES' changes whenever possible.
2. For TypeScript/JavaScript: understand refactoring intent. If one side simplified code, prefer the cleaner version but keep new functionality from the other side.
3. For YAML data: merge entries from both sides. If the same key was modified differently, prefer HEAD's version but include any new entries from the other side.
4. For MDX content: preserve all content from both sides.
5. NEVER leave conflict markers (<<<<<<, =======, >>>>>>>) in the output.
6. Output the ENTIRE section (including the unchanged context lines before and after) with the conflict resolved.
7. Do NOT add any explanations, commentary, or markdown code fences.
8. Preserve indentation and formatting exactly.

Output the complete resolved section — context lines unchanged, conflict region merged.`;

// ── API call with robust retry ─────────────────────────────────────────

async function callAPIWithRetry(body, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000), // 5 minute timeout per request
      });

      if (response.ok) {
        return { ok: true, data: await response.json() };
      }

      const status = response.status;
      const errText = await response.text();

      // Retry on transient errors (429 rate limit, 5xx server errors)
      if ((status === 429 || status >= 500) && attempt < retries) {
        const delay = Math.min(Math.pow(2, attempt + 1) * 1000, 60_000); // 4s, 8s, 16s, 32s, 60s
        console.error(`  API ${status} (attempt ${attempt}/${retries}) — retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return { ok: false, status, error: errText };
    } catch (fetchErr) {
      // Handle network errors (DNS failures, connection resets, timeouts, "fetch failed")
      if (attempt < retries) {
        const delay = Math.min(Math.pow(2, attempt + 1) * 1000, 60_000);
        console.error(
          `  Network error (attempt ${attempt}/${retries}): ${fetchErr.message} — retrying in ${delay / 1000}s...`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return { ok: false, status: 0, error: `Network error: ${fetchErr.message}` };
    }
  }
}

// ── Strip markdown code fences ──────────────────────────────────────────

/**
 * Models sometimes wrap output in ```lang ... ``` despite being told not to.
 * Strip those fences if present so we get clean file content.
 */
function stripCodeFences(text) {
  // Match opening ``` with optional language identifier, and closing ```
  const fencePattern = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/;
  const match = text.match(fencePattern);
  return match ? match[1] : text;
}

// ── Hunk-based resolution for large files ──────────────────────────────

/**
 * Merge nearby conflict blocks so their context windows don't overlap.
 * If two blocks are within 2*CONTEXT_LINES of each other, treat them
 * as a single hunk to avoid sending partial/overlapping context.
 */
function mergeNearbyBlocks(blocks) {
  if (blocks.length <= 1) return blocks;

  const merged = [{ ...blocks[0] }];
  for (let i = 1; i < blocks.length; i++) {
    const prev = merged[merged.length - 1];
    if (blocks[i].start - prev.end <= CONTEXT_LINES * 2) {
      // Merge into previous block
      prev.end = blocks[i].end;
    } else {
      merged.push({ ...blocks[i] });
    }
  }
  return merged;
}

/**
 * Resolve a large file by extracting individual conflict hunks,
 * resolving each one separately via Claude, and reassembling.
 */
async function resolveLargeFile(filePath, content) {
  const lines = content.split("\n");
  let blocks = findConflictBlocks(lines);

  if (blocks.length === 0) return content;

  blocks = mergeNearbyBlocks(blocks);
  console.log(`  Large file mode: ${blocks.length} conflict hunk(s), resolving individually`);

  // Work backwards so line indices stay valid after each replacement
  for (let b = blocks.length - 1; b >= 0; b--) {
    const block = blocks[b];
    const ctxStart = Math.max(0, block.start - CONTEXT_LINES);
    const ctxEnd = Math.min(lines.length - 1, block.end + CONTEXT_LINES);

    const hunkLines = lines.slice(ctxStart, ctxEnd + 1);
    const hunkContent = hunkLines.join("\n");

    console.log(
      `  Hunk ${blocks.length - b}/${blocks.length}: lines ${block.start + 1}-${block.end + 1} (${hunkContent.length} chars with context)`
    );

    const result = await callAPIWithRetry({
      model: "claude-sonnet-4-6",
      max_tokens: 16_000,
      system: HUNK_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Resolve the merge conflict in this section of ${filePath} (lines ${ctxStart + 1}-${ctxEnd + 1}):\n\n${hunkContent}`,
        },
      ],
    });

    if (!result.ok) {
      console.error(`  API error for hunk in ${filePath}: ${result.status} ${result.error}`);
      return null;
    }

    const data = result.data;
    let resolvedHunk = data.content?.[0]?.text;

    if (!resolvedHunk) {
      console.error(`  Empty response for hunk in ${filePath}`);
      return null;
    }

    resolvedHunk = stripCodeFences(resolvedHunk);

    if (data.stop_reason === "max_tokens") {
      console.error(`  Hunk resolution truncated for ${filePath} — skipping file.`);
      return null;
    }

    if (resolvedHunk.includes("<<<<<<<") || resolvedHunk.includes(">>>>>>>")) {
      console.error(`  Conflict markers remain in resolved hunk for ${filePath}`);
      return null;
    }

    // Replace the hunk section (context + conflict) with resolved content
    const resolvedHunkLines = resolvedHunk.split("\n");
    lines.splice(ctxStart, ctxEnd - ctxStart + 1, ...resolvedHunkLines);
  }

  return lines.join("\n");
}

// ── File resolution ────────────────────────────────────────────────────

async function resolveFile(filePath) {
  // Handle delete/modify conflicts: file may not exist on disk if one side deleted it
  if (!existsSync(filePath)) {
    // One side deleted the file, the other modified it.
    // Check if the file exists in HEAD (the PR branch) — if so, the PR kept it.
    const headHas = gitSafe("ls-tree", "--name-only", "HEAD", "--", filePath);
    const mainHas = gitSafe("ls-tree", "--name-only", "origin/main", "--", filePath);

    if (headHas.ok && headHas.output.trim()) {
      // PR kept the file, main deleted it → keep PR's version
      console.log(`  Delete/modify conflict: ${filePath} — keeping PR's version (main deleted it).`);
      git("checkout", "HEAD", "--", filePath);
      git("add", "--", filePath);
      addDiagnostic(filePath, "resolved", "delete/modify conflict — kept PR version");
      return true;
    } else if (mainHas.ok && mainHas.output.trim()) {
      // Main kept the file, PR deleted it → accept the deletion
      console.log(`  Delete/modify conflict: ${filePath} — accepting PR's deletion (main modified it).`);
      git("rm", "--", filePath);
      addDiagnostic(filePath, "resolved", "delete/modify conflict — accepted PR deletion");
      return true;
    } else {
      console.error(`  Delete/modify conflict: ${filePath} — cannot determine correct resolution.`);
      addDiagnostic(filePath, "FAILED", "delete/modify conflict — could not determine which side to keep");
      return false;
    }
  }

  const content = readFileSync(filePath, "utf-8");

  // Skip binary files
  if (content.includes("\0")) {
    console.log(`  Skipping binary file: ${filePath}`);
    addDiagnostic(filePath, "FAILED", "binary file — cannot auto-resolve");
    return false;
  }

  // Verify it actually has conflict markers
  if (!content.includes("<<<<<<<")) {
    console.log(`  No conflict markers in ${filePath} — auto-accepting.`);
    git("add", "--", filePath);
    addDiagnostic(filePath, "resolved", "no conflict markers (auto-merged by git)");
    return true;
  }

  console.log(`  Resolving: ${filePath} (${content.length} chars)`);

  // Try deterministic frontmatter resolution first (no API call needed)
  const frontmatterResolved = tryResolveFrontmatterOnly(filePath, content);
  if (frontmatterResolved !== null) {
    writeFileSync(filePath, frontmatterResolved);
    git("add", "--", filePath);
    console.log(`  Resolved: ${filePath} (deterministic frontmatter merge — no API call)`);
    addDiagnostic(filePath, "resolved", "deterministic frontmatter merge");
    return true;
  }

  let resolvedContent;

  if (content.length > LARGE_FILE_THRESHOLD) {
    // Large file — resolve conflict hunks individually to avoid API timeouts
    resolvedContent = await resolveLargeFile(filePath, content);
  } else {
    // Small file — send the whole thing
    const result = await callAPIWithRetry({
      model: "claude-sonnet-4-6",
      max_tokens: 64_000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Resolve the merge conflicts in this file (${filePath}):\n\n${content}`,
        },
      ],
    });

    if (!result.ok) {
      console.error(`  API error for ${filePath}: ${result.status} ${result.error}`);
      addDiagnostic(filePath, "FAILED", `API error: HTTP ${result.status}`);
      return false;
    }

    const data = result.data;
    resolvedContent = data.content?.[0]?.text;

    if (!resolvedContent) {
      console.error(`  Empty response for ${filePath}`);
      addDiagnostic(filePath, "FAILED", "API returned empty response");
      return false;
    }

    // Strip markdown code fences the model may have added
    resolvedContent = stripCodeFences(resolvedContent);

    // Check for truncation — if the model hit the token limit, the file is incomplete
    if (data.stop_reason === "max_tokens") {
      console.error(`  Response was truncated for ${filePath} (hit max_tokens) — skipping.`);
      addDiagnostic(filePath, "FAILED", "response truncated (file too large for single-shot resolution)");
      return false;
    }
  }

  if (resolvedContent === null) {
    addDiagnostic(filePath, "FAILED", "resolution returned null (see hunk errors above)");
    return false;
  }

  // Safety check: make sure no conflict markers remain
  if (resolvedContent.includes("<<<<<<<") || resolvedContent.includes(">>>>>>>")) {
    console.error(`  Resolution for ${filePath} still contains conflict markers — skipping.`);
    addDiagnostic(filePath, "FAILED", "resolved content still contains conflict markers");
    return false;
  }

  writeFileSync(filePath, resolvedContent);
  git("add", "--", filePath);
  console.log(`  Resolved: ${filePath}`);
  addDiagnostic(filePath, "resolved", "Claude API resolution");
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
    addDiagnostic(file, "FAILED", `exception: ${err.message}`);
    failed++;
  }
}

console.log(`\n=== Results: ${resolved} resolved, ${failed} failed ===\n`);

// Always write diagnostics so the workflow can use them
writeDiagnosticSummary();

// ── Step 4: Commit and push, or abort ──────────────────────────────────

if (failed > 0) {
  console.error("Some files could not be resolved — aborting merge.");
  diagnostics.filter((d) => d.status === "FAILED").forEach((d) => {
    console.error(`  FAILED: ${d.file} — ${d.reason}`);
  });
  gitSafe("merge", "--abort");
  process.exit(1);
}

// Check if there are still unresolved conflicts
const remaining = gitSafe("diff", "--name-only", "--diff-filter=U");
if (remaining.ok && remaining.output.trim()) {
  console.error("Unresolved files remain — aborting merge.");
  gitSafe("merge", "--abort");
  process.exit(1);
}

// Commit the merge with an informative message
git("commit", "-m", `Merge main into ${PR_BRANCH} (auto-resolved conflicts)\n\nConflicts in ${resolved} file(s) were resolved automatically by the Claude-powered conflict resolver.`);
console.log("Merge committed successfully.");

// ── Step 5: Push (unless --no-push) ───────────────────────────────────

if (process.argv.includes("--no-push")) {
  console.log("\n--no-push flag set — skipping push. Merge committed locally.");
  process.exit(0);
}

// Push with retry — the branch may have been updated concurrently
let pushOk = false;
for (let attempt = 1; attempt <= 3; attempt++) {
  const pushResult = gitSafe("push", "origin", PR_BRANCH);
  if (pushResult.ok) {
    pushOk = true;
    break;
  }

  if (attempt < 3) {
    console.error(`  Push failed (attempt ${attempt}/3): ${pushResult.stderr}`);
    console.error("  Re-fetching and retrying...");

    // Re-fetch in case the branch was updated
    gitSafe("fetch", "origin", PR_BRANCH);
    const remoteSha = gitSafe("rev-parse", `origin/${PR_BRANCH}`);
    const localBase = gitSafe("rev-parse", `HEAD~1`); // pre-merge commit

    // If remote diverged from what we based on, we need to abort
    if (remoteSha.ok && localBase.ok && remoteSha.output.trim() !== localBase.output.trim()) {
      console.error("  Branch was updated concurrently — aborting to avoid overwriting changes.");
      break;
    }

    await new Promise((r) => setTimeout(r, 2000 * attempt));
  } else {
    console.error(`  Push failed after 3 attempts: ${pushResult.stderr}`);
  }
}

if (!pushOk) {
  console.error("Push failed — resolution was computed but could not be pushed.");
  process.exit(1);
}

console.log(`\nConflicts resolved and pushed to ${PR_BRANCH}.`);
