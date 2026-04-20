#!/usr/bin/env node

/**
 * Validate that every `@longterm-wiki/*` workspace package imported from
 * `apps/<name>/src/` or `apps/<name>/scripts/` is declared in that app's
 * `package.json` (in any dependency section).
 *
 * Also validates the worker Docker image: every `@longterm-wiki/*` package
 * imported from `crux/` (which `Dockerfile.worker` copies wholesale into the
 * image) must be declared in `docker/worker/package.json`.
 *
 * ## Why this exists
 *
 * pnpm's workspace hoisting makes undeclared workspace imports work locally
 * and in CI (because the monorepo root has all packages installed). But the
 * prod Docker build uses `pnpm install --filter <app>...`, which only
 * resolves declared workspace dependencies. An undeclared `@longterm-wiki/*`
 * import will pass every local and CI check, then fail at runtime inside the
 * Docker container with `ERR_MODULE_NOT_FOUND`.
 *
 * This bug class has recurred four times:
 *   - `@longterm-wiki/id-utils` (earliest incident, referenced in QUA-449)
 *   - `@longterm-wiki/factbase` (2026-04-14, QUA-449)
 *   - `@longterm-wiki/url-utils` in wiki-server (2026-04-18, QUA-598)
 *   - `@longterm-wiki/url-utils` in the worker image (2026-04-19, QUA-605) —
 *     missed by the earlier validator because it only covered apps/*, not
 *     the standalone worker manifest at `docker/worker/package.json`.
 *
 * Each previous occurrence was fixed instance-by-instance. This validator is
 * the systemic fix — a blocking gate check so the 5th recurrence is impossible.
 *
 * ## What it checks
 *
 * For every `apps/<name>/package.json`:
 *   1. Scan `apps/<name>/src/` AND `apps/<name>/scripts/` recursively for any
 *      `@longterm-wiki/<pkg>` import.
 *   2. Compare the used set against every declared-dependency section in
 *      `package.json` (dependencies, devDependencies, peerDependencies,
 *      optionalDependencies).
 *   3. Fail if any used package is not declared in any section.
 *
 * For `docker/worker/package.json` (standalone, not a workspace member):
 *   1. Scan `crux/` recursively (excluding `*.test.*` and `__tests__/`) for
 *      any `@longterm-wiki/<pkg>` import. The worker Dockerfile copies all of
 *      `crux/` into the image, so any import reachable via lazy handler load
 *      needs the dep declared.
 *   2. Same declared-vs-used comparison as apps.
 *
 * Imports in scope: quote-anchored `from '@longterm-wiki/X'`, `import('…')`,
 * and `require('…')` — plus subpath imports like `@longterm-wiki/factbase/types`
 * (the package name is the first path segment). The quote anchor prevents
 * false positives from bare mentions in comments or docstrings. Note: a
 * commented-out *import statement* (e.g. `// import { x } from '@longterm-wiki/EXAMPLE'`)
 * is still flagged — treating that as a real import is intentional since
 * commented-out code should be removed, not left behind. (Note: EXAMPLE is
 * uppercase so this docstring itself doesn't match the regex below, which
 * restricts package names to lowercase per npm naming rules.)
 *
 * Why "any section" and not just `dependencies`: the Dockerfiles in this
 * repo install with `pnpm install --filter <app>...` (no `--prod`), so
 * devDependencies are present in the image. The failure mode we target is
 * "not declared anywhere", which is what makes pnpm's filter prune the
 * package entirely.
 *
 * ## What it does NOT check
 *
 * - `apps/<name>/tests/`, `e2e/` — not part of the production install graph.
 * - `packages/` — workspace packages importing each other is allowed in the
 *   monorepo graph; pnpm resolves those transitively via the root install.
 * - Declared-but-unused packages — reported as a warning, not an error.
 *
 * Usage: `npx tsx crux/validate/validate-workspace-dep-coverage.ts`
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SCAN_SUBDIRS = ['src', 'scripts'] as const;
const WORKSPACE_PREFIX = '@longterm-wiki/';
const WORKER_MANIFEST_PATH = 'docker/worker/package.json';
const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

// Matches import / import() / require() for `@longterm-wiki/<pkg>` with a
// quote anchor so stray mentions in comments ("see @longterm-wiki/foo docs")
// don't count. Package names are lowercase/digits/hyphens (npm naming rules).
// Captures just the first path segment, so subpath imports like
// `@longterm-wiki/factbase/types` correctly resolve to `@longterm-wiki/factbase`.
const IMPORT_RE = /(?:from|import|require)\s*\(?\s*['"]@longterm-wiki\/([a-z0-9][a-z0-9-]*)(?:\/[^'"]*)?['"]/g;

interface AppCoverage {
  app: string;
  used: Set<string>;       // @longterm-wiki/X packages imported from src/ or scripts/
  declared: Set<string>;   // @longterm-wiki/X packages declared in any dep section
  missing: string[];       // used but not declared anywhere (blocking)
  unused: string[];        // declared but not used (warning)
  /** Repo-relative path to the package.json that must be edited to fix a violation. */
  manifestPath: string;
  /** Bare dep-spec to suggest for a missing import (without surrounding JSON
   *  quotes — those are added at print time). Apps use `workspace:*`; the
   *  standalone worker manifest uses `file:./packages/<pkg>`. */
  depSuggestion: (pkg: string) => string;
}

interface CheckOptions {
  appsDir?: string;
  /** Path to the worker's standalone package.json. Defaults to
   *  `<repo>/docker/worker/package.json`. */
  workerPkgJson?: string;
  /** Source tree to scan for the worker manifest check. Defaults to `<repo>/crux`. */
  workerSourceDir?: string;
  /** Optional warning sink so tests can assert on parse errors. */
  onWarn?: (message: string) => void;
}

interface CheckResult {
  passed: boolean;
  errors: number;
  warnings: number;
  apps: AppCoverage[];
}

interface ListOptions {
  /** Skip test directories (`__tests__/`, `tests/`) and test files (`*.test.*`,
   *  `*.spec.*`, `*.test-d.*`). Used for crux scanning where test imports
   *  shouldn't require deps in the worker image. */
  excludeTests?: boolean;
}

// Matches `foo.test.ts`, `foo.spec.ts`, `foo.test-d.ts` and their .js/.mjs/.jsx
// siblings. Single source of truth so tests and the scanner agree.
const TEST_FILE_RE = /\.(test|spec)(-d)?\.[a-z]+$/;

function listSourceFiles(
  dir: string,
  out: string[] = [],
  options: ListOptions = {},
): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  // Dirent.isDirectory()/isFile() check the link itself (like lstat), so
  // symbolic links are naturally skipped — no infinite recursion on loops.
  for (const dirent of entries) {
    const name = dirent.name;
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (options.excludeTests && (name === '__tests__' || name === 'tests')) continue;
    const full = join(dir, name);
    if (dirent.isDirectory()) {
      listSourceFiles(full, out, options);
    } else if (dirent.isFile()) {
      const dot = name.lastIndexOf('.');
      if (dot !== -1 && SOURCE_EXTENSIONS.has(name.slice(dot))) {
        if (options.excludeTests && TEST_FILE_RE.test(name)) continue;
        out.push(full);
      }
    }
  }
  return out;
}

export function extractWorkspaceImports(content: string): Set<string> {
  const used = new Set<string>();
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    used.add(`${WORKSPACE_PREFIX}${m[1]}`);
  }
  return used;
}

function readDeclaredDeps(
  packageJsonPath: string,
  onWarn?: (message: string) => void,
): Set<string> {
  const declared = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, 'utf-8');
  } catch (err) {
    onWarn?.(
      `Unreadable package.json at ${packageJsonPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return declared;
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    onWarn?.(
      `Malformed package.json at ${packageJsonPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return declared;
  }
  for (const section of DEP_SECTIONS) {
    const block = pkg[section];
    if (!block || typeof block !== 'object') continue;
    for (const name of Object.keys(block as Record<string, unknown>)) {
      if (name.startsWith(WORKSPACE_PREFIX)) declared.add(name);
    }
  }
  return declared;
}

function scanImports(files: string[]): Set<string> {
  const used = new Set<string>();
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (!content.includes(WORKSPACE_PREFIX)) continue;
    for (const pkg of extractWorkspaceImports(content)) used.add(pkg);
  }
  return used;
}

function buildCoverage(
  label: string,
  manifestPath: string,
  depSuggestion: (pkg: string) => string,
  used: Set<string>,
  declared: Set<string>,
): AppCoverage {
  const missing = [...used].filter((p) => !declared.has(p)).sort();
  const unused = [...declared].filter((p) => !used.has(p)).sort();
  return { app: label, used, declared, missing, unused, manifestPath, depSuggestion };
}

function analyzeApp(
  appDir: string,
  appName: string,
  onWarn?: (message: string) => void,
): AppCoverage | null {
  const pkgJson = join(appDir, 'package.json');
  if (!existsSync(pkgJson)) return null;

  const files: string[] = [];
  for (const sub of SCAN_SUBDIRS) {
    // listSourceFiles silently returns [] if the subdir is missing.
    listSourceFiles(join(appDir, sub), files);
  }

  return buildCoverage(
    appName,
    `apps/${appName}/package.json`,
    () => 'workspace:*',
    scanImports(files),
    readDeclaredDeps(pkgJson, onWarn),
  );
}

/**
 * Scan `crux/` and compare its `@longterm-wiki/*` imports against
 * `docker/worker/package.json`. The worker manifest is NOT a pnpm workspace
 * member (the reason QUA-605 existed), so missing-dep suggestions use the
 * `file:./packages/<pkg>` protocol that the Dockerfile wires up, not
 * `workspace:*`.
 */
function analyzeWorkerManifest(
  sourceDir: string,
  pkgJsonPath: string,
  onWarn?: (message: string) => void,
): AppCoverage | null {
  if (!existsSync(pkgJsonPath)) return null;
  if (!existsSync(sourceDir)) return null;

  const files = listSourceFiles(sourceDir, [], { excludeTests: true });
  return buildCoverage(
    dirname(WORKER_MANIFEST_PATH),  // "docker/worker"
    WORKER_MANIFEST_PATH,
    (pkg) => `file:./packages/${pkg.slice(WORKSPACE_PREFIX.length)}`,
    scanImports(files),
    readDeclaredDeps(pkgJsonPath, onWarn),
  );
}

export function runCheck(options: CheckOptions = {}): CheckResult {
  const c = getColors();
  const appsDir = options.appsDir ?? join(PROJECT_ROOT, 'apps');
  const workerPkgJson =
    options.workerPkgJson ?? join(PROJECT_ROOT, WORKER_MANIFEST_PATH);
  const workerSourceDir = options.workerSourceDir ?? join(PROJECT_ROOT, 'crux');
  const onWarn = options.onWarn ?? ((msg) => console.log(`${c.yellow}${msg}${c.reset}`));

  console.log(
    `${c.blue}Checking workspace dependency coverage in ${appsDir}...${c.reset}\n`
  );

  let appNames: string[] = [];
  try {
    appNames = readdirSync(appsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
  } catch {
    console.log(`${c.dim}Skipping apps: ${appsDir} not found${c.reset}`);
  }

  const apps: AppCoverage[] = [];
  for (const name of appNames.sort()) {
    const report = analyzeApp(join(appsDir, name), name, onWarn);
    if (report) apps.push(report);
  }

  const workerReport = analyzeWorkerManifest(workerSourceDir, workerPkgJson, onWarn);
  if (workerReport) apps.push(workerReport);

  let errors = 0;
  let warnings = 0;

  for (const app of apps) {
    if (app.missing.length === 0 && app.unused.length === 0) {
      console.log(
        `${c.green}${app.app}: OK${c.reset}${c.dim} (${app.used.size} used / ${app.declared.size} declared)${c.reset}`
      );
      continue;
    }

    if (app.missing.length > 0) {
      errors += app.missing.length;
      console.log(
        `${c.red}${app.app}: ${app.missing.length} undeclared workspace import${app.missing.length > 1 ? 's' : ''}:${c.reset}`
      );
      for (const pkg of app.missing) {
        console.log(`  ${c.red}${pkg}${c.reset}`);
      }
      console.log(
        `${c.dim}  Fix: add to ${app.manifestPath} dependencies:${c.reset}`
      );
      for (const pkg of app.missing) {
        console.log(`${c.dim}    "${pkg}": "${app.depSuggestion(pkg)}"${c.reset}`);
      }
    }

    if (app.unused.length > 0) {
      warnings += app.unused.length;
      console.log(
        `${c.yellow}${app.app}: ${app.unused.length} declared but unused workspace dep${app.unused.length > 1 ? 's' : ''} (warning):${c.reset}`
      );
      for (const pkg of app.unused) {
        console.log(`  ${c.yellow}${pkg}${c.reset}`);
      }
    }
  }

  console.log();
  if (errors > 0) {
    console.log(
      `${c.red}Found ${errors} undeclared workspace import${errors > 1 ? 's' : ''}.${c.reset}`
    );
    console.log(
      `${c.dim}Prod Docker builds use \`pnpm install --filter <app>...\` which only resolves declared dependencies.${c.reset}`
    );
    console.log(
      `${c.dim}Undeclared imports pass locally (pnpm hoists) but fail at runtime with ERR_MODULE_NOT_FOUND.${c.reset}`
    );
    console.log(
      `${c.dim}See QUA-598 (wiki-server) and QUA-605 (worker image) for prior incidents of this class.${c.reset}`
    );
  } else {
    console.log(
      `${c.green}All workspace imports are declared.${c.reset}`
    );
  }

  return {
    passed: errors === 0,
    errors,
    warnings,
    apps,
  };
}

// Entry-point guard: only run as a script when node invokes this file directly.
// Comparing import.meta.url to process.argv[1] avoids the substring-match
// brittleness where a sibling test file path would also trigger a side-effect run.
const invokedDirectly =
  import.meta.url.startsWith('file://') &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
