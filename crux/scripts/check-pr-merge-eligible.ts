#!/usr/bin/env node
/**
 * PreToolUse hook helper — invoked by `.claude/hooks/require-stage-approved.sh`
 * to decide whether a `gh pr merge ...` Bash call should proceed.
 *
 * Exit codes:
 *   0 = allow the tool call (or not applicable to this hook)
 *   2 = block; stderr is shown to Claude as the reason
 *
 * Two gates:
 *   1. PR has the `stage:approved` label.
 *   2. PR has zero unresolved CodeRabbit Major / Critical / Potential-issue
 *      review threads. We use GitHub's GraphQL `reviewThreads` (it exposes
 *      `isResolved`); the REST `/pulls/:n/comments` endpoint doesn't, so a
 *      previous bash-only version blocked even after threads were resolved.
 *
 * Override: `ALLOW_UNAPPROVED_MERGE=1 gh pr merge ...`
 *
 * The Bash command is passed in via the `COMMAND` env var (set by the hook
 * wrapper from stdin JSON `tool_input.command`). We use env, not argv, to
 * avoid shell quoting fragility on commands containing pipes / quotes.
 *
 * Fail-open on transport errors (missing token, GraphQL down, etc.) — the
 * hook is a guardrail, not a security boundary; if we can't query, we let
 * `gh pr merge` itself report any errors.
 */

import {
  githubGraphQL,
  REPO,
  isMissingTokenError,
} from "../lib/github.ts";

interface PrData {
  labels: { nodes: { name: string }[] };
  reviewThreads: {
    nodes: {
      isResolved: boolean;
      comments: { nodes: { author: { login: string } | null; body: string }[] };
    }[];
  };
}

const SEVERITY_RE = /Major|Critical|Potential issue/;
const STAGE_APPROVED = "stage:approved";

/**
 * Detect whether the command is a `gh pr merge` invocation we should gate.
 * Allows pnpm/npx prefix and accepts `gh pr merge` as the leading meaningful
 * token (or after a `;`/`&&`/`||` separator). Conservatively avoids blocking
 * commands that *mention* `gh pr merge` in a string literal — those are rare
 * and the false-positive cost (blocking) is higher than the false-negative
 * cost (one un-gated merge slips through).
 */
function isMergeCommand(command: string): boolean {
  return /(^|[;&|]\s*)(?:pnpm\s+|npx\s+)?gh\s+pr\s+merge\b/.test(command);
}

/**
 * Pull the target PR number out of a `gh pr merge` invocation. Recognised:
 *   - `gh pr merge 1234`
 *   - `gh pr merge --auto 1234`
 *   - `gh pr merge owner/repo#1234`
 *   - `gh pr merge https://github.com/owner/repo/pull/1234`
 *
 * Returns null if no PR can be inferred from the command itself; the caller
 * may then fall back to `gh pr view` for the current branch.
 */
export function extractPrNumber(command: string): number | null {
  // Pull URL — most specific, check first.
  const urlMatch = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/.exec(command);
  if (urlMatch) return Number(urlMatch[1]);

  // owner/repo#1234 form (e.g. `gh pr merge quri/lw#4576`)
  const hashed = /\bgh\s+pr\s+merge\b[^\n]*?\b\S+#(\d+)\b/.exec(command);
  if (hashed) return Number(hashed[1]);

  // Generic: take the FIRST standalone integer token after `gh pr merge`.
  // This tolerates flag/value pairs like `gh pr merge -R owner/repo 4576`
  // or `--auto` / `--squash` interleaving with the PR number.
  const merge = /\bgh\s+pr\s+merge\b/.exec(command);
  if (!merge) return null;
  const tail = command.slice(merge.index + merge[0].length);
  for (const tok of tail.split(/\s+/)) {
    if (/^\d+$/.test(tok)) return Number(tok);
  }

  return null;
}

export function hasStageApproved(pr: PrData): boolean {
  return pr.labels.nodes.some((l) => l.name === STAGE_APPROVED);
}

export function unresolvedMajorBotCount(pr: PrData): number {
  let count = 0;
  for (const thread of pr.reviewThreads.nodes) {
    if (thread.isResolved) continue;
    const first = thread.comments.nodes[0];
    if (!first) continue;
    if (first.author?.login !== "coderabbitai") continue;
    if (SEVERITY_RE.test(first.body)) count += 1;
  }
  return count;
}

async function loadPr(prNumber: number): Promise<PrData> {
  const [owner, name] = REPO.split("/");
  const data = await githubGraphQL<{
    repository: { pullRequest: PrData };
  }>(
    `query($owner:String!,$name:String!,$pr:Int!) {
       repository(owner:$owner, name:$name) {
         pullRequest(number:$pr) {
           labels(first:50) { nodes { name } }
           reviewThreads(first:100) {
             nodes {
               isResolved
               comments(first:1) {
                 nodes { author { login } body }
               }
             }
           }
         }
       }
     }`,
    { owner, name, pr: prNumber },
  );
  return data.repository.pullRequest;
}

function block(message: string): never {
  process.stderr.write(message);
  if (!message.endsWith("\n")) process.stderr.write("\n");
  process.exit(2);
}

async function main(): Promise<void> {
  const command = process.env.COMMAND ?? "";
  if (!command || !isMergeCommand(command)) {
    process.exit(0);
  }

  if (process.env.ALLOW_UNAPPROVED_MERGE === "1") {
    process.stderr.write(
      "[require-stage-approved] Override: ALLOW_UNAPPROVED_MERGE=1 — skipping label/review checks.\n",
    );
    process.exit(0);
  }

  const prNumber = extractPrNumber(command);
  if (prNumber == null) {
    // Couldn't infer the PR from the command. Conservative fail-open — the
    // user could be running `gh pr merge` interactively for a branch that
    // doesn't have a number on the cmdline; let `gh` resolve and report.
    process.exit(0);
  }

  let pr: PrData;
  try {
    pr = await loadPr(prNumber);
  } catch (e) {
    if (isMissingTokenError(e)) {
      process.stderr.write(
        "[require-stage-approved] No GITHUB_TOKEN — letting through.\n",
      );
      process.exit(0);
    }
    process.stderr.write(
      `[require-stage-approved] Could not fetch PR #${prNumber} metadata — letting through. (${e instanceof Error ? e.message : String(e)})\n`,
    );
    process.exit(0);
  }

  if (!hasStageApproved(pr)) {
    block(
      `BLOCKED: PR #${prNumber} is missing the \`${STAGE_APPROVED}\` label.\n\n` +
        `Coord sessions must not merge PRs without explicit human approval (the\n` +
        `label is set by the user, not by agents). PR-patrol follows the same rule.\n\n` +
        `Current labels: [${pr.labels.nodes.map((l) => l.name).join(", ")}]\n\n` +
        `If the user explicitly told you to merge this PR anyway, override with:\n` +
        `  ALLOW_UNAPPROVED_MERGE=1 gh pr merge ${prNumber} ...\n\n` +
        `See: $CLAUDE_PROJECT_DIR/.claude/memory/feedback_pr_merge_authority.md`,
    );
  }

  const unresolved = unresolvedMajorBotCount(pr);
  if (unresolved > 0) {
    block(
      `BLOCKED: PR #${prNumber} has ${unresolved} unresolved CodeRabbit Major/Critical/Potential-issue review thread(s).\n\n` +
        `Either address them (push fix commits, then re-merge) or — if they've\n` +
        `been verified as already-handled / out-of-scope and the user has\n` +
        `approved shipping anyway — override with:\n` +
        `  ALLOW_UNAPPROVED_MERGE=1 gh pr merge ${prNumber} ...\n\n` +
        `Inspect threads in the PR's "Conversation" tab; resolved threads don't count.`,
    );
  }

  process.exit(0);
}

// Only run main() when invoked as a script (not when imported for testing).
// `import.meta.url === ...` works under tsx/Node ESM; we detect via process.argv[1].
const isMainScript =
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith("check-pr-merge-eligible.ts");

if (isMainScript) {
  main().catch((e) => {
    process.stderr.write(
      `[require-stage-approved] Unexpected error — letting through: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(0);
  });
}
