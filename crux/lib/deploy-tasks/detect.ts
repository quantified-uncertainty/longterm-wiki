import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { basename } from "path";

// Import from api-types (worker container copies this file). The route
// file mount-registry.ts is NOT in the worker image and importing from
// it causes ERR_MODULE_NOT_FOUND on crux.mjs load.
import { TABLEBASE_NON_ROUTE_FILES } from "../../../apps/wiki-server/src/api-types.ts";

import type {
  DeployTask,
  DeployTaskCategory,
  DeployTaskDetectionResult,
  DeployTaskPhase,
} from "./types.ts";

/** Env vars that are standard/expected and don't need deploy tasks */
const KNOWN_ENV_VARS = new Set([
  "NODE_ENV",
  "CI",
  "PORT",
  "HOME",
  "PATH",
  "PWD",
  "SHELL",
  "USER",
  "TERM",
  "HOSTNAME",
  "LANG",
  "TZ",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "NEXT_PUBLIC_VERCEL_URL",
  "NEXT_PUBLIC_VERCEL_ENV",
  "npm_lifecycle_event",
  "npm_package_name",
]);

export interface ChangedFile {
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U";
  path: string;
  /** For renames, the original path */
  oldPath?: string;
}

/**
 * Run a git command and return stdout. Returns null on failure.
 */
function gitCommand(args: string[], cwd?: string): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"], // suppress stderr from git
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse `git diff --name-status` output into structured ChangedFile entries.
 */
function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const lines = output.split("\n").filter((l) => l.length > 0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Status codes: A, M, D, or R/C followed by a number (similarity %)
    // Renames/copies have two paths: old\tnew
    const renameMatch = line.match(/^([RC])\d*\t(.+)\t(.+)$/);
    if (renameMatch) {
      files.push({
        status: renameMatch[1] as ChangedFile["status"],
        oldPath: renameMatch[2],
        path: renameMatch[3],
      });
      continue;
    }

    const simpleMatch = line.match(/^([AMDTU])\t(.+)$/);
    if (simpleMatch) {
      files.push({
        status: simpleMatch[1] as ChangedFile["status"],
        path: simpleMatch[2],
      });
    }
  }

  return files;
}

/**
 * Check if a migration file is a no-op (contains only `SELECT 1;` or equivalent).
 */
function isMigrationNoOp(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    // Strip SQL comments and whitespace
    const stripped = content
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    return /^SELECT\s+1\s*;?\s*$/i.test(stripped);
  } catch {
    // If we can't read the file (e.g., it was deleted), assume not a no-op
    return false;
  }
}

/**
 * Extract migration number from a Drizzle migration filename.
 * Example: "0060_add_new_column.sql" -> "0060"
 */
function extractMigrationNumber(filename: string): string | null {
  const match = basename(filename).match(/^(\d+)/);
  return match ? match[1] : null;
}

/**
 * Extract the workflow name from a GitHub Actions workflow filename.
 */
function extractWorkflowName(filePath: string): string {
  return basename(filePath, ".yml").replace(/-/g, " ");
}

/**
 * Extract route name from a wiki-server route file path.
 */
function extractRouteName(filePath: string): string {
  return basename(filePath, ".ts");
}

// ────────────────────────────────────────────────────────────────────────────
// Detection Rules
// ────────────────────────────────────────────────────────────────────────────

function detectMigrations(files: ChangedFile[]): DeployTask[] {
  const tasks: DeployTask[] = [];
  const migrationFiles = files.filter(
    (f) =>
      (f.status === "A" || f.status === "M") &&
      f.path.match(/^apps\/wiki-server\/drizzle\/\d.*\.sql$/)
  );

  for (const file of migrationFiles) {
    const migNum = extractMigrationNumber(file.path);
    const isNoOp = isMigrationNoOp(file.path);
    const id = `migration-${migNum ?? basename(file.path, ".sql")}`;

    if (isNoOp) {
      tasks.push({
        id,
        description: `Migration ${migNum ?? basename(file.path)} is a no-op — verify manual migration script was applied separately`,
        category: "migration",
        phase: "post-deploy",
        automated: true,
        verifyCommand: `psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"`,
        sourceFiles: [file.path],
      });
    } else {
      tasks.push({
        id,
        description: `Verify migration ${migNum ?? basename(file.path)} applied on server start`,
        category: "migration",
        phase: "post-deploy",
        automated: true,
        verifyCommand: `psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;"`,
        sourceFiles: [file.path],
      });
    }
  }

  return tasks;
}

function detectManualMigrations(files: ChangedFile[]): DeployTask[] {
  const tasks: DeployTask[] = [];
  const scriptFiles = files.filter(
    (f) =>
      f.status === "A" &&
      f.path.match(/^apps\/wiki-server\/scripts\/.*\.sql$/)
  );

  for (const file of scriptFiles) {
    const filename = basename(file.path);
    tasks.push({
      id: `manual-migration-${filename.replace(/\.sql$/, "")}`,
      description: `Run manual migration script: psql "$DATABASE_MIGRATION_URL" -f ${file.path}`,
      category: "manual-migration",
      phase: "manual",
      automated: false,
      sourceFiles: [file.path],
    });
  }

  return tasks;
}

function detectNewEnvVars(baseRef: string): DeployTask[] {
  const tasks: DeployTask[] = [];

  // Get added lines in TS/TSX/MJS files
  const diff = gitCommand([
    "diff",
    baseRef,
    "--",
    "*.ts",
    "*.tsx",
    "*.mjs",
  ]);
  if (!diff) return tasks;

  // Extract env var names from added lines (lines starting with +)
  const addedEnvVars = new Set<string>();
  const envVarPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;

  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    let match;
    while ((match = envVarPattern.exec(line)) !== null) {
      const varName = match[1];
      if (!KNOWN_ENV_VARS.has(varName)) {
        addedEnvVars.add(varName);
      }
    }
  }

  if (addedEnvVars.size === 0) return tasks;

  // Check which env vars already exist in the base ref
  const existingEnvVars = new Set<string>();
  for (const varName of addedEnvVars) {
    const grepResult = gitCommand([
      "grep",
      "-l",
      `process.env.${varName}`,
      baseRef,
      "--",
      "*.ts",
      "*.tsx",
      "*.mjs",
    ]);
    if (grepResult && grepResult.length > 0) {
      existingEnvVars.add(varName);
    }
  }

  // Create tasks for truly new env vars
  for (const varName of addedEnvVars) {
    if (existingEnvVars.has(varName)) continue;

    tasks.push({
      id: `env-${varName.toLowerCase().replace(/_/g, "-")}`,
      description: `Set env var ${varName} in production`,
      category: "env",
      phase: "pre-merge",
      automated: false,
      sourceFiles: [], // Tracked via diff, not specific files
    });
  }

  return tasks;
}

function detectWorkflowChanges(files: ChangedFile[]): DeployTask[] {
  const tasks: DeployTask[] = [];
  const workflowFiles = files.filter(
    (f) =>
      (f.status === "A" || f.status === "M") &&
      f.path.match(/^\.github\/workflows\/.*\.yml$/)
  );

  for (const file of workflowFiles) {
    const name = extractWorkflowName(file.path);
    const action = file.status === "A" ? "New" : "Modified";

    tasks.push({
      id: `ci-${basename(file.path, ".yml")}`,
      description: `${action} workflow "${name}" — verify it runs successfully after merge`,
      category: "ci",
      phase: "post-deploy",
      automated: true,
      verifyCommand: `gh run list --workflow="${basename(file.path)}" --limit=1 --json status,conclusion`,
      sourceFiles: [file.path],
    });
  }

  return tasks;
}

function detectSchemaChanges(files: ChangedFile[]): DeployTask[] {
  const schemaFile = files.find(
    (f) =>
      (f.status === "M" || f.status === "A") &&
      f.path === "apps/wiki-server/src/schema.ts"
  );

  if (!schemaFile) return [];

  return [
    {
      id: "schema-change",
      description:
        "Drizzle schema changed — verify wiki-server redeployed and schema is in sync",
      category: "schema",
      phase: "post-deploy",
      automated: true,
      verifyCommand: `curl -sf "$WIKI_SERVER_URL/health" | jq .`,
      sourceFiles: [schemaFile.path],
    },
  ];
}

function detectConfigChanges(files: ChangedFile[]): DeployTask[] {
  const tasks: DeployTask[] = [];

  const configPatterns: Array<{
    pattern: string;
    description: string;
    phase: DeployTaskPhase;
    automated: boolean;
    verifyCommand?: string;
    idSuffix: string;
  }> = [
    {
      pattern: "data/auto-update/sources.yaml",
      description:
        "Auto-update sources config changed — verify next auto-update run uses new sources",
      phase: "post-deploy",
      automated: false,
      idSuffix: "auto-update-sources",
    },
    {
      pattern: "apps/web/vercel.json",
      description:
        "Vercel config changed — verify deployment reflects new configuration",
      phase: "post-deploy",
      automated: true,
      verifyCommand: `curl -sf "https://www.longtermwiki.com" -o /dev/null -w "%{http_code}"`,
      idSuffix: "vercel-config",
    },
    {
      pattern: "apps/web/next.config.mjs",
      description:
        "Next.js config changed — verify production build uses new configuration",
      phase: "post-deploy",
      automated: true,
      verifyCommand: `curl -sf "https://www.longtermwiki.com" -o /dev/null -w "%{http_code}"`,
      idSuffix: "next-config",
    },
  ];

  for (const config of configPatterns) {
    const match = files.find(
      (f) =>
        (f.status === "A" || f.status === "M") && f.path === config.pattern
    );
    if (match) {
      tasks.push({
        id: `config-${config.idSuffix}`,
        description: config.description,
        category: "config",
        phase: config.phase,
        automated: config.automated,
        verifyCommand: config.verifyCommand,
        sourceFiles: [match.path],
      });
    }
  }

  return tasks;
}

const TABLEBASE_PREFIX = "apps/wiki-server/src/routes/tablebase/";
const SHARED_PREFIX = "apps/wiki-server/src/routes/shared/";

/**
 * Set of TableBase filenames that are NOT routes (helpers, schemas, the
 * registry itself). Mirrors the canonical list maintained in `mount-registry.ts`
 * and consumed by `validate-tablebase-completeness.ts`,
 * `validate-tablebase-registry.ts`, and `mount-registry.test.ts` — drift in
 * either direction is prevented by the mount-registry test pair.
 */
const TABLEBASE_NON_ROUTES = new Set<string>(TABLEBASE_NON_ROUTE_FILES);

/**
 * Detect new wiki-server routes from added files.
 *
 * The detector excludes obvious non-routes:
 *   - `index.ts` (re-export hubs)
 *   - anything under `apps/wiki-server/src/routes/shared/` (utility helpers)
 *   - tablebase files in `TABLEBASE_NON_ROUTE_FILES` (QUA-712 — these are
 *     helpers like `system-card-benchmark-linker.ts` colocated with routes)
 *
 * Exported so tests can drive it with a controlled set of changed files.
 */
export function detectNewRoutes(files: ChangedFile[]): DeployTask[] {
  const tasks: DeployTask[] = [];
  const routeFiles = files.filter(
    (f) =>
      f.status === "A" &&
      f.path.match(/^apps\/wiki-server\/src\/routes\/.*\.ts$/)
  );

  for (const file of routeFiles) {
    const filename = basename(file.path);

    // Re-export hubs, test files, and shared helpers are never routes.
    if (filename === "index.ts") continue;
    if (filename.endsWith(".test.ts") || filename.endsWith(".test-d.ts")) continue;
    if (file.path.startsWith(SHARED_PREFIX)) continue;

    // Tablebase helpers (system-card-benchmark-linker, sync-factory, schemas, etc.)
    // are colocated with route files. The canonical exclusion list lives in
    // mount-registry.ts and is enforced by the mount-registry test pair.
    if (
      file.path.startsWith(TABLEBASE_PREFIX) &&
      TABLEBASE_NON_ROUTES.has(filename)
    ) {
      continue;
    }

    const routeName = extractRouteName(file.path);
    tasks.push({
      id: `route-${routeName}`,
      description: `New API route "${routeName}" added — verify endpoint is accessible after deploy`,
      category: "route",
      phase: "post-deploy",
      automated: true,
      verifyCommand: `curl -sf "$WIKI_SERVER_URL/${routeName}" -o /dev/null -w "%{http_code}"`,
      sourceFiles: [file.path],
    });
  }

  return tasks;
}

function detectBuildChanges(files: ChangedFile[]): DeployTask[] {
  const buildFile = files.find(
    (f) =>
      (f.status === "M" || f.status === "A") &&
      f.path === "apps/web/scripts/build-data.mjs"
  );

  if (!buildFile) return [];

  return [
    {
      id: "build-data-change",
      description:
        "build-data.mjs changed — verify build-data produces correct database.json after deploy",
      category: "build",
      phase: "post-deploy",
      automated: true,
      verifyCommand: `pnpm build-data:content && echo "Build data OK"`,
      sourceFiles: [buildFile.path],
    },
  ];
}

function detectDockerChanges(files: ChangedFile[]): DeployTask[] {
  const tasks: DeployTask[] = [];
  const dockerFiles = files.filter(
    (f) =>
      (f.status === "A" || f.status === "M") &&
      (f.path.match(/Dockerfile/) || f.path.match(/docker-compose/))
  );

  if (dockerFiles.length === 0) return [];

  // Group all Dockerfile changes into one task
  tasks.push({
    id: "docker-change",
    description:
      "Docker configuration changed — verify container builds and starts correctly",
    category: "docker",
    phase: "post-deploy",
    automated: true,
    verifyCommand: `curl -sf "$WIKI_SERVER_URL/health" | jq .`,
    sourceFiles: dockerFiles.map((f) => f.path),
  });

  return tasks;
}

// ────────────────────────────────────────────────────────────────────────────
// Deduplication (sub-PR tasks vs diff-detected tasks)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a string for fuzzy matching: lowercase, strip backticks and
 * markdown formatting, collapse whitespace.
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/_\(from PR #\d+\)_/g, "") // strip sub-PR attribution
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract specific identifiers from a task string that can be used for
 * exact dedup matching. Returns extracted keys by category.
 *
 * Operates on normalized text (backticks stripped, lowercased) so that
 * formatting differences don't prevent matching.
 */
function extractTaskKeys(
  rawText: string
): { envVars: string[]; migrationNums: string[]; workflowNames: string[] } {
  // Strip backticks and markdown formatting before extracting keys
  const text = rawText.replace(/`/g, "");

  const envVars: string[] = [];
  const migrationNums: string[] = [];
  const workflowNames: string[] = [];

  // Env var names: "Set env var FOO_BAR" or "Set FOO_BAR in production"
  const envPattern = /\benv\s+var\s+([A-Z_][A-Z0-9_]*)\b/gi;
  let match;
  while ((match = envPattern.exec(text)) !== null) {
    envVars.push(match[1].toUpperCase());
  }
  // Also match "Set FOO_BAR in production" without "var"
  const envPattern2 = /\bset\s+([A-Z_][A-Z0-9_]*)\s+in\s+production\b/gi;
  while ((match = envPattern2.exec(text)) !== null) {
    envVars.push(match[1].toUpperCase());
  }

  // Migration numbers: "migration 0060" or "migration-0060"
  const migPattern = /\bmigration[\s-]+(\d+)/gi;
  while ((match = migPattern.exec(text)) !== null) {
    migrationNums.push(match[1]);
  }

  // Workflow names: workflow "name" or workflow name.yml
  // Handle both quoted ("auto update") and unquoted (auto-update.yml) names.
  // Normalize hyphens to spaces so "auto-update" matches "auto update".
  const wfQuotedPattern = /\bworkflow\s+["']([^"']+)["']/gi;
  while ((match = wfQuotedPattern.exec(text)) !== null) {
    workflowNames.push(
      match[1].toLowerCase().replace(/\.yml$/, "").replace(/-/g, " ")
    );
  }
  const wfUnquotedPattern = /\bworkflow\s+([a-z0-9][\w.-]*)/gi;
  while ((match = wfUnquotedPattern.exec(text)) !== null) {
    workflowNames.push(
      match[1].toLowerCase().replace(/\.yml$/, "").replace(/-/g, " ")
    );
  }

  return { envVars, migrationNums, workflowNames };
}

/**
 * Check whether a sub-PR task is a duplicate of any diff-detected task.
 *
 * Uses two strategies:
 * 1. Key-based matching: extract env var names, migration numbers, workflow names
 *    and check for overlap.
 * 2. Substring matching: check if either task description is a substring of the
 *    other (after normalization).
 */
function isSubPrTaskDuplicate(
  subPrTask: string,
  diffTasks: DeployTask[]
): boolean {
  const normalizedSubPr = normalizeForComparison(subPrTask);
  const subPrKeys = extractTaskKeys(subPrTask);

  for (const diffTask of diffTasks) {
    const normalizedDiff = normalizeForComparison(diffTask.description);

    // Strategy 1: Key-based matching
    const diffKeys = extractTaskKeys(diffTask.description);

    // Check env var overlap
    if (subPrKeys.envVars.length > 0 && diffKeys.envVars.length > 0) {
      for (const envVar of subPrKeys.envVars) {
        if (diffKeys.envVars.includes(envVar)) return true;
      }
    }

    // Check migration number overlap
    if (
      subPrKeys.migrationNums.length > 0 &&
      diffKeys.migrationNums.length > 0
    ) {
      for (const migNum of subPrKeys.migrationNums) {
        if (diffKeys.migrationNums.includes(migNum)) return true;
      }
    }

    // Check workflow name overlap
    if (
      subPrKeys.workflowNames.length > 0 &&
      diffKeys.workflowNames.length > 0
    ) {
      for (const wfName of subPrKeys.workflowNames) {
        if (diffKeys.workflowNames.includes(wfName)) return true;
      }
    }

    // Strategy 2: Substring matching on normalized descriptions
    if (
      normalizedSubPr.includes(normalizedDiff) ||
      normalizedDiff.includes(normalizedSubPr)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Remove sub-PR tasks that duplicate diff-detected tasks.
 *
 * Diff-detected tasks are preferred because they are more structured (have
 * category, phase, verify commands). Sub-PR tasks are free-text strings
 * scraped from PR bodies.
 */
export function deduplicateSubPrTasks(
  diffTasks: DeployTask[],
  subPrTasks: string[]
): string[] {
  if (diffTasks.length === 0 || subPrTasks.length === 0) return subPrTasks;
  return subPrTasks.filter((task) => !isSubPrTaskDuplicate(task, diffTasks));
}

// ────────────────────────────────────────────────────────────────────────────
// PR Body Parsing & Formatting (shared with CLI command and tests)
// ────────────────────────────────────────────────────────────────────────────

export interface ParsedDeployTasks {
  total: number;
  checked: number;
  unchecked: number;
  items: Array<{ text: string; checked: boolean }>;
}

/**
 * Extract the verification shell command embedded in a deploy task text line.
 *
 * Tasks formatted by `formatDeployTasksSection` look like:
 *   `category` Description goes here — `verify command`
 *
 * Sub-PR tasks may have a trailing attribution suffix:
 *   `category` Description — `verify command` _(from PR #1234)_
 *
 * Returns the command string (without backticks) or null if no embedded command
 * is found. Uses an em-dash (U+2014) as the command separator since that's what
 * `formatDeployTasksSection` writes.
 */
/**
 * Extract the category prefix from a deploy task line.
 * Task lines look like: `` `migration` Verify migration 0158 applied ``
 * Returns the category string (e.g. "migration") or "unknown" if no prefix.
 */
export function extractCategory(text: string): string {
  const match = text.match(/^`([a-z][\w-]*)`\s/);
  return match ? match[1] : "unknown";
}

export function extractVerifyCommand(text: string): string | null {
  // Strip trailing sub-PR attribution before matching
  const cleaned = text.replace(/\s*_\(from PR #\d+\)_\s*$/, "").trim();
  // Match the LAST `— \`...\`` segment so descriptions containing em-dashes work.
  // Backticks inside the command itself are not supported (deploy task formatter
  // doesn't produce them).
  const match = cleaned.match(/—\s+`([^`]+)`\s*$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// interpretResult — interpret a verify-command's output by category
// ---------------------------------------------------------------------------

interface CommandOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

interface InterpretedResult {
  passed: boolean;
  summary: string;
}

/**
 * Interpret a deploy-task verification command's output.
 *
 * Uses the task category to apply domain-specific parsing:
 *   - ci: parse `gh run list/view` JSON for workflow conclusion
 *   - schema: parse health-endpoint JSON for status
 *   - migration: check psql exit code and output
 *   - route: parse HTTP status code from curl output
 *   - generic: exit code 0 = pass
 */
export function interpretResult(
  category: string,
  command: string,
  output: CommandOutput,
): InterpretedResult {
  // Timeout / signal detection
  if (output.stderr.includes("timed out") || output.code === 124) {
    return { passed: false, summary: "timed out" };
  }

  // CI workflow checks (gh run list / gh run view)
  if (
    category === "ci" &&
    (command.includes("gh run list") || command.includes("gh run view"))
  ) {
    try {
      const data = JSON.parse(output.stdout);
      const run = Array.isArray(data) ? data[0] : data;
      if (!run) return { passed: false, summary: "unexpected output" };
      if (run.conclusion === "success") return { passed: true, summary: "workflow succeeded" };
      if (run.conclusion === "failure") return { passed: false, summary: "workflow failed" };
      if (run.status === "in_progress" || run.status === "queued")
        return { passed: false, summary: "workflow still running" };
      return { passed: false, summary: `unexpected: ${JSON.stringify(run).slice(0, 100)}` };
    } catch {
      return { passed: false, summary: "unexpected output" };
    }
  }

  // Health endpoint checks — only match actual health-check commands
  // (curl to /health piped to jq), not route checks that happen to
  // contain "/health" in the URL path.
  if (category === "schema" && command.includes("/health") && command.includes("jq")) {
    try {
      const health = JSON.parse(output.stdout);
      if (health.status === "healthy" || health.status === "ok")
        return { passed: true, summary: "healthy" };
      if (health.status === "degraded")
        return { passed: false, summary: "server in degraded mode" };
      // Unknown status — don't assume healthy just because exit code was 0.
      // An unexpected status like "starting" or "maintenance" should fail
      // so the operator investigates.
      return { passed: false, summary: `unexpected status: ${health.status ?? "unknown"}` };
    } catch {
      if (output.stdout.includes("ok")) return { passed: true, summary: "ok" };
      return { passed: false, summary: `could not parse health: ${output.stdout.slice(0, 120)}` };
    }
  }

  // Migration checks (psql)
  if (category === "migration" && command.includes("psql")) {
    if (output.code !== 0) {
      if (output.stderr.includes("not found") || output.stderr.includes("command not found"))
        return { passed: false, summary: "psql not available locally — use health endpoint instead" };
      if (output.stderr.includes("connection") || output.stderr.includes("could not connect"))
        return { passed: false, summary: "connection to server failed" };
      return { passed: false, summary: `psql failed (exit ${output.code})` };
    }
    return { passed: true, summary: "migration verified" };
  }

  // HTTP status checks (curl -o /dev/null -w "%{http_code}")
  if (category === "route" && command.includes("curl")) {
    const statusMatch = output.stdout.match(/^(\d{3})$/m) || output.stdout.match(/(\d{3})/);
    if (statusMatch) {
      const code = parseInt(statusMatch[1], 10);
      if (code >= 200 && code < 300) return { passed: true, summary: `HTTP ${code}` };
      return { passed: false, summary: `HTTP ${code}` };
    }
  }

  // Generic: exit code determines pass/fail
  if (output.code === 0) {
    // Use stdout content as summary if available, otherwise "ok"
    const trimmed = output.stdout.trim();
    return { passed: true, summary: trimmed ? trimmed.slice(0, 120) : "ok" };
  }
  // stderr-only output — use it as the summary
  if (output.stderr && !output.stdout.trim()) {
    return { passed: false, summary: output.stderr.slice(0, 120) };
  }
  // stdout has content — use it
  if (output.stdout.trim()) {
    return { passed: false, summary: output.stdout.trim().slice(0, 120) };
  }
  return { passed: false, summary: `exit code ${output.code}` };
}

/**
 * Parse deploy tasks from a PR body. Returns null if no deploy tasks section found.
 */
export function parseDeployTasksFromBody(body: string): ParsedDeployTasks | null {
  const startMarker = "<!-- deploy-tasks:v1 -->";
  const endMarker = "<!-- /deploy-tasks -->";
  const startIdx = body.indexOf(startMarker);
  const endIdx = body.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;

  const section = body.slice(startIdx + startMarker.length, endIdx);
  const items: Array<{ text: string; checked: boolean }> = [];

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    const uncheckedMatch = trimmed.match(/^- \[ \] (.+)$/);
    if (uncheckedMatch) {
      items.push({ text: uncheckedMatch[1], checked: false });
      continue;
    }
    const checkedMatch = trimmed.match(/^- \[x\] (.+)$/i);
    if (checkedMatch) {
      items.push({ text: checkedMatch[1], checked: true });
    }
  }

  const checked = items.filter((i) => i.checked).length;
  return {
    total: items.length,
    checked,
    unchecked: items.length - checked,
    items,
  };
}

/**
 * Format deploy tasks into a markdown section for PR descriptions.
 *
 * @param tasks - Tasks auto-detected from the file diff
 * @param subPrTasks - Pre-formatted task strings from sub-PRs (already include PR ref)
 */
export function formatDeployTasksSection(
  tasks: DeployTask[],
  subPrTasks: string[] = []
): string {
  const lines: string[] = [];
  lines.push("## Deploy Checklist");
  lines.push("<!-- deploy-tasks:v1 -->");

  if (tasks.length === 0 && subPrTasks.length === 0) {
    lines.push("No deploy tasks required.");
  } else {
    for (const task of tasks) {
      let line = `- [ ] \`${task.category}\` ${task.description}`;
      if (task.verifyCommand) {
        line += ` — \`${task.verifyCommand}\``;
      }
      lines.push(line);
    }
    for (const task of subPrTasks) {
      lines.push(`- [ ] ${task}`);
    }
  }

  lines.push("<!-- /deploy-tasks -->");
  return lines.join("\n");
}

/**
 * Preserve checked state from an old PR body when generating a new one.
 *
 * When `crux gh release create` updates an existing release PR, it regenerates
 * the body from scratch — wiping any deploy tasks that a human manually checked.
 * This function merges the checked state from the old body into the new body by
 * matching task text (ignoring the checkbox prefix).
 */
export function preserveCheckedState(newBody: string, oldBody: string): string {
  const oldParsed = parseDeployTasksFromBody(oldBody);
  if (!oldParsed || oldParsed.checked === 0) {
    // Nothing was checked in the old body — no merging needed
    return newBody;
  }

  const startMarker = "<!-- deploy-tasks:v1 -->";
  const endMarker = "<!-- /deploy-tasks -->";
  const startIdx = newBody.indexOf(startMarker);
  const endIdx = newBody.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    // No deploy tasks section in the new body — nothing to merge into
    return newBody;
  }

  // Build a set of checked task texts from the old body
  const checkedTexts = new Set(
    oldParsed.items.filter((i) => i.checked).map((i) => i.text)
  );

  // Scope replacements to within the deploy tasks section only
  const sectionStart = startIdx + startMarker.length;
  const section = newBody.slice(sectionStart, endIdx);

  const updatedSection = section
    .split("\n")
    .map((line) => {
      const match = line.trimStart().match(/^- \[ \] (.+)$/);
      if (match && checkedTexts.has(match[1])) {
        return line.replace("- [ ]", "- [x]");
      }
      return line;
    })
    .join("\n");

  return newBody.slice(0, sectionStart) + updatedSection + newBody.slice(endIdx);
}

// ────────────────────────────────────────────────────────────────────────────
// Main Detection Function
// ────────────────────────────────────────────────────────────────────────────

/**
 * Detect deploy tasks from the diff between the current HEAD and a base ref.
 *
 * @param baseRef - Git ref to compare against (default: 'origin/main')
 * @returns Detection result with tasks, file count, and matched rules
 */
export function detectDeployTasks(
  baseRef: string = "origin/main"
): DeployTaskDetectionResult {
  // Verify the base ref exists before diffing
  const refCheck = gitCommand(["rev-parse", "--verify", baseRef]);
  if (!refCheck) {
    return {
      tasks: [],
      filesAnalyzed: 0,
      rulesMatched: [],
      error: `Invalid base ref '${baseRef}' — cannot resolve to a commit. Check the ref name and try again.`,
    };
  }

  // Get list of changed files
  const nameStatusOutput = gitCommand([
    "diff",
    "--name-status",
    baseRef,
  ]);

  if (!nameStatusOutput) {
    return {
      tasks: [],
      filesAnalyzed: 0,
      rulesMatched: [],
    };
  }

  const files = parseNameStatus(nameStatusOutput);

  if (files.length === 0) {
    return {
      tasks: [],
      filesAnalyzed: 0,
      rulesMatched: [],
    };
  }

  // Run all detection rules
  const ruleResults: Array<{
    name: string;
    tasks: DeployTask[];
  }> = [
    { name: "new-migrations", tasks: detectMigrations(files) },
    { name: "manual-migrations", tasks: detectManualMigrations(files) },
    { name: "new-env-vars", tasks: detectNewEnvVars(baseRef) },
    { name: "workflow-changes", tasks: detectWorkflowChanges(files) },
    { name: "schema-changes", tasks: detectSchemaChanges(files) },
    { name: "config-changes", tasks: detectConfigChanges(files) },
    { name: "new-routes", tasks: detectNewRoutes(files) },
    { name: "build-changes", tasks: detectBuildChanges(files) },
    { name: "docker-changes", tasks: detectDockerChanges(files) },
  ];

  const allTasks: DeployTask[] = [];
  const matchedRules: string[] = [];

  for (const rule of ruleResults) {
    if (rule.tasks.length > 0) {
      allTasks.push(...rule.tasks);
      matchedRules.push(rule.name);
    }
  }

  // Sort tasks by phase priority: pre-merge first, then post-deploy, then manual
  const phaseOrder: Record<DeployTaskPhase, number> = {
    "pre-merge": 0,
    "post-deploy": 1,
    manual: 2,
  };
  allTasks.sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]);

  return {
    tasks: allTasks,
    filesAnalyzed: files.length,
    rulesMatched: matchedRules,
  };
}
