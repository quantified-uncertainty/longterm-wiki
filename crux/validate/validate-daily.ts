#!/usr/bin/env node

/**
 * Daily Validation Runner
 *
 * Runs all validators (local-only and server-dependent) and produces a unified
 * summary report. This is the local equivalent of the `data-validation.yml`
 * GitHub Actions workflow.
 *
 * Validators are split into two tiers:
 *   - Local: run against local YAML/MDX data (no server needed)
 *   - Server: require wiki-server access (WIKI_SERVER_ENV=prod for production)
 *
 * Each validator is classified as either "blocking" or "advisory":
 *   - Blocking validators cause a non-zero exit code on failure
 *   - Advisory validators report issues but never fail the run
 *
 * Usage:
 *   npx tsx crux/validate/validate-daily.ts              # human-readable
 *   npx tsx crux/validate/validate-daily.ts --ci          # JSON + GITHUB_STEP_SUMMARY
 *   npx tsx crux/validate/validate-daily.ts --local-only  # skip server-dependent checks
 *
 * Exit codes:
 *   0 = All blocking checks passed
 *   1 = One or more blocking checks failed
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, appendFileSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

const args = process.argv.slice(2);
const CI_MODE = args.includes("--ci") || process.env.CI === "true";
const LOCAL_ONLY = args.includes("--local-only");
const c = getColors(CI_MODE);

// ── Validator Definitions ───────────────────────────────────────────────────

interface ValidatorDef {
  id: string;
  name: string;
  script: string;
  /** If true, failure causes overall exit code 1 */
  blocking: boolean;
  /** If true, requires wiki-server access */
  requiresServer: boolean;
  /** Extra CLI args */
  extraArgs?: string[];
}

const VALIDATORS: ValidatorDef[] = [
  // ── Local validators (no server needed) ──────────────────────────────────
  {
    id: "yaml-entity-refs",
    name: "YAML Entity References",
    script: "crux/validate/validate-yaml-entity-refs.ts",
    blocking: true,
    requiresServer: false,
  },
  {
    id: "temporal",
    name: "Temporal Invariants",
    script: "crux/validate/validate-temporal.ts",
    blocking: true,
    requiresServer: false,
  },
  {
    id: "cross-base",
    name: "Cross-Base Consistency",
    script: "crux/validate/validate-cross-base.ts",
    blocking: true,
    requiresServer: false,
  },
  {
    id: "data",
    name: "Data Integrity",
    script: "crux/validate/validate-data.ts",
    blocking: true,
    requiresServer: false,
  },

  // ── Server-dependent validators ──────────────────────────────────────────
  {
    id: "orphan-entities",
    name: "Orphan Entity Detection",
    script: "crux/validate/validate-orphan-entities.ts",
    blocking: false,
    requiresServer: true,
  },
  {
    id: "soft-fks",
    name: "Soft Foreign Keys",
    script: "crux/validate/validate-soft-fks.ts",
    blocking: false,
    requiresServer: true,
  },
  {
    id: "controlled-vocab",
    name: "Controlled Vocabulary",
    script: "crux/validate/validate-controlled-vocab.ts",
    blocking: true,
    requiresServer: true,
  },
  {
    id: "resource-refs",
    name: "Resource References",
    script: "crux/validate/validate-resource-refs.ts",
    blocking: false,
    requiresServer: true,
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────

interface ValidatorResult {
  id: string;
  name: string;
  blocking: boolean;
  requiresServer: boolean;
  passed: boolean;
  skipped: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

function runValidator(validator: ValidatorDef): Promise<ValidatorResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const scriptPath = join(PROJECT_ROOT, validator.script);

    if (!existsSync(scriptPath)) {
      resolve({
        id: validator.id,
        name: validator.name,
        blocking: validator.blocking,
        requiresServer: validator.requiresServer,
        passed: false,
        skipped: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        durationMs: 0,
        error: `Script not found: ${validator.script} — this is a bug, the validator definition references a missing file`,
      });
      return;
    }

    const childArgs = ["--import", "tsx/esm", "--no-warnings", scriptPath, "--ci"];
    if (validator.extraArgs) {
      childArgs.push(...validator.extraArgs);
    }

    // For server-dependent validators, ensure WIKI_SERVER_ENV is set
    const env = { ...process.env };
    if (validator.requiresServer && !env.WIKI_SERVER_ENV) {
      // Default to prod for server checks when running in CI
      if (process.env.CI === "true") {
        env.WIKI_SERVER_ENV = "prod";
      }
    }

    const VALIDATOR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    const child: ChildProcess = spawn("node", childArgs, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeoutId = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, VALIDATOR_TIMEOUT_MS);

    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (!CI_MODE) {
        process.stdout.write(data);
      }
    });

    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (!CI_MODE) {
        process.stderr.write(data);
      }
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      if (killed) {
        resolve({
          id: validator.id,
          name: validator.name,
          blocking: validator.blocking,
          requiresServer: validator.requiresServer,
          passed: false,
          skipped: false,
          exitCode: code,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          error: `Timed out after ${VALIDATOR_TIMEOUT_MS / 1000}s`,
        });
      } else {
        resolve({
          id: validator.id,
          name: validator.name,
          blocking: validator.blocking,
          requiresServer: validator.requiresServer,
          passed: code === 0,
          skipped: false,
          exitCode: code,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
        });
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      resolve({
        id: validator.id,
        name: validator.name,
        blocking: validator.blocking,
        requiresServer: validator.requiresServer,
        passed: false,
        skipped: false,
        exitCode: 1,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        error: err.message,
      });
    });
  });
}

// ── Summary Formatting ──────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildMarkdownSummary(results: ValidatorResult[], totalDurationMs: number): string {
  const lines: string[] = [];

  lines.push("# Daily Validation Report");
  lines.push("");
  lines.push(`**Date**: ${new Date().toISOString().split("T")[0]}`);
  lines.push(`**Duration**: ${formatDuration(totalDurationMs)}`);
  lines.push("");

  // Count results
  const passed = results.filter((r) => r.passed && !r.skipped);
  const failed = results.filter((r) => !r.passed && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const blockingFailed = failed.filter((r) => r.blocking);
  const advisoryFailed = failed.filter((r) => !r.blocking);

  if (blockingFailed.length > 0) {
    lines.push(`> **Status**: :x: ${blockingFailed.length} blocking failure(s)`);
  } else if (advisoryFailed.length > 0) {
    lines.push(`> **Status**: :warning: All blocking checks passed, ${advisoryFailed.length} advisory issue(s)`);
  } else {
    lines.push(`> **Status**: :white_check_mark: All checks passed`);
  }
  lines.push("");

  // Results table
  lines.push("| Validator | Type | Status | Duration |");
  lines.push("|-----------|------|--------|----------|");

  for (const r of results) {
    const type = r.blocking ? "Blocking" : "Advisory";
    let status: string;
    if (r.skipped) {
      status = ":fast_forward: Skipped";
    } else if (r.passed) {
      status = ":white_check_mark: Passed";
    } else if (r.blocking) {
      status = ":x: **FAILED**";
    } else {
      status = ":warning: Issues found";
    }
    const duration = r.skipped ? "-" : formatDuration(r.durationMs);
    lines.push(`| ${r.name} | ${type} | ${status} | ${duration} |`);
  }

  lines.push("");

  // Details for failures
  if (failed.length > 0) {
    lines.push("## Failure Details");
    lines.push("");

    for (const r of failed) {
      lines.push(`### ${r.name} (${r.blocking ? "blocking" : "advisory"})`);
      lines.push("");

      // Try to extract meaningful output
      const output = r.stdout || r.stderr || r.error || "No output captured";
      // Limit output length
      const trimmed = output.length > 2000
        ? output.slice(0, 2000) + "\n... (truncated)"
        : output;

      lines.push("```");
      lines.push(trimmed.trim());
      lines.push("```");
      lines.push("");
    }
  }

  // Summary stats
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Passed**: ${passed.length}`);
  lines.push(`- **Failed (blocking)**: ${blockingFailed.length}`);
  lines.push(`- **Failed (advisory)**: ${advisoryFailed.length}`);
  lines.push(`- **Skipped**: ${skipped.length}`);

  return lines.join("\n");
}

function printConsoleSummary(results: ValidatorResult[], totalDurationMs: number): void {
  console.log(
    `\n${c.bold}${c.blue}${"=".repeat(60)}${c.reset}`
  );
  console.log(`${c.bold}${c.blue}  Daily Validation Report${c.reset}`);
  console.log(
    `${c.bold}${c.blue}${"=".repeat(60)}${c.reset}\n`
  );

  for (const r of results) {
    const type = r.blocking ? "blocking" : "advisory";
    if (r.skipped) {
      console.log(`  ${c.dim}- ${r.name} (skipped)${c.reset}`);
    } else if (r.passed) {
      console.log(`  ${c.green}+ ${r.name}${c.reset} ${c.dim}(${type}, ${formatDuration(r.durationMs)})${c.reset}`);
    } else if (r.blocking) {
      console.log(`  ${c.red}x ${r.name}${c.reset} ${c.red}(${type}, FAILED)${c.reset}`);
    } else {
      console.log(`  ${c.yellow}! ${r.name}${c.reset} ${c.dim}(${type}, issues found)${c.reset}`);
    }
  }

  const passed = results.filter((r) => r.passed && !r.skipped).length;
  const blockingFailed = results.filter((r) => !r.passed && !r.skipped && r.blocking).length;
  const advisoryFailed = results.filter((r) => !r.passed && !r.skipped && !r.blocking).length;
  const skipped = results.filter((r) => r.skipped).length;

  console.log(
    `\n${c.bold}${c.blue}${"=".repeat(60)}${c.reset}`
  );
  console.log(`  Passed: ${c.green}${passed}${c.reset}`);
  if (blockingFailed > 0) {
    console.log(`  Failed (blocking): ${c.red}${blockingFailed}${c.reset}`);
  }
  if (advisoryFailed > 0) {
    console.log(`  Failed (advisory): ${c.yellow}${advisoryFailed}${c.reset}`);
  }
  if (skipped > 0) {
    console.log(`  Skipped: ${c.dim}${skipped}${c.reset}`);
  }
  console.log(`  Duration: ${formatDuration(totalDurationMs)}`);
  console.log(
    `${c.bold}${c.blue}${"=".repeat(60)}${c.reset}\n`
  );

  if (blockingFailed > 0) {
    console.log(`${c.red}${c.bold}FAILED: ${blockingFailed} blocking check(s) failed${c.reset}\n`);
  } else if (advisoryFailed > 0) {
    console.log(`${c.yellow}${c.bold}PASSED with ${advisoryFailed} advisory issue(s)${c.reset}\n`);
  } else {
    console.log(`${c.green}${c.bold}All checks passed!${c.reset}\n`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();

  // Filter validators based on --local-only flag
  const validatorsToRun = LOCAL_ONLY
    ? VALIDATORS.filter((v) => !v.requiresServer)
    : VALIDATORS;

  if (!CI_MODE) {
    console.log(
      `${c.bold}${c.blue}Daily Validation Suite${c.reset}`
    );
    console.log(
      `${c.dim}Running ${validatorsToRun.length} validators${LOCAL_ONLY ? " (local-only)" : ""}${c.reset}\n`
    );
  }

  const results: ValidatorResult[] = [];

  for (const validator of validatorsToRun) {
    if (!CI_MODE) {
      console.log(
        `\n${c.cyan}> ${validator.name}${c.reset} ${c.dim}(${validator.blocking ? "blocking" : "advisory"})${c.reset}`
      );
    }

    const result = await runValidator(validator);
    results.push(result);

    if (!CI_MODE && result.skipped) {
      console.log(`  ${c.dim}Skipped: ${result.error || "not found"}${c.reset}`);
    }
  }

  // Add skip records for server validators when --local-only
  if (LOCAL_ONLY) {
    for (const validator of VALIDATORS.filter((v) => v.requiresServer)) {
      results.push({
        id: validator.id,
        name: validator.name,
        blocking: validator.blocking,
        requiresServer: validator.requiresServer,
        passed: true,
        skipped: true,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        error: "Skipped (--local-only)",
      });
    }
  }

  const totalDurationMs = Date.now() - startTime;

  // Output results
  if (CI_MODE) {
    const blockingFailed = results.filter(
      (r) => !r.passed && !r.skipped && r.blocking
    );

    const jsonOutput = {
      timestamp: new Date().toISOString(),
      duration: formatDuration(totalDurationMs),
      passed: blockingFailed.length === 0,
      results: results.map((r) => ({
        id: r.id,
        name: r.name,
        blocking: r.blocking,
        requiresServer: r.requiresServer,
        passed: r.passed,
        skipped: r.skipped,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        error: r.error,
      })),
      summary: {
        total: results.length,
        passed: results.filter((r) => r.passed && !r.skipped).length,
        blockingFailed: blockingFailed.length,
        advisoryFailed: results.filter(
          (r) => !r.passed && !r.skipped && !r.blocking
        ).length,
        skipped: results.filter((r) => r.skipped).length,
      },
    };

    console.log(JSON.stringify(jsonOutput, null, 2));
  } else {
    printConsoleSummary(results, totalDurationMs);
  }

  // Write GitHub Actions step summary if available
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const markdown = buildMarkdownSummary(results, totalDurationMs);
    appendFileSync(summaryPath, markdown + "\n");
  }

  // Exit code: only fail on blocking check failures
  const blockingFailed = results.filter(
    (r) => !r.passed && !r.skipped && r.blocking
  );
  process.exit(blockingFailed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("validate-daily crashed:", err);
  process.exit(1);
});
