#!/usr/bin/env node

/**
 * Validate that every `@longterm-wiki/*` workspace package imported from
 * `apps/<name>/src/` or `apps/<name>/scripts/` is declared in that app's
 * `package.json` (in any dependency section).
 *
 * Also validates the worker Docker image: every `@longterm-wiki/*` package
 * imported from `crux/` (which `Dockerfile.worker` copies wholesale into the
 * image) must be declared in `docker/worker/package.json`, AND every
 * `file:./packages/<pkg>` dep in that manifest must have a matching
 * `COPY packages/<pkg>/` line in `Dockerfile.worker` before
 * `pnpm install --prod`.
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
 * This bug class has recurred five times:
 *   - `@longterm-wiki/id-utils` (earliest incident, referenced in QUA-449)
 *   - `@longterm-wiki/factbase` (2026-04-14, QUA-449)
 *   - `@longterm-wiki/url-utils` in wiki-server (2026-04-18, QUA-598)
 *   - `@longterm-wiki/url-utils` in the worker image (2026-04-19, QUA-605) —
 *     missed by the earlier validator because it only covered apps/*, not
 *     the standalone worker manifest at `docker/worker/package.json`.
 *   - Worker Dockerfile COPY gap (2026-04-20, QUA-654) — QUA-605's fix added
 *     the dep to the manifest but left the matching `COPY packages/<pkg>/`
 *     line in Dockerfile.worker as a manual step. Adding a new `file:` dep
 *     without the COPY line would break the image build (stage-1 pnpm
 *     install can't resolve a `file:` path whose source isn't staged).
 *
 * Each previous occurrence was fixed instance-by-instance. This validator is
 * the systemic fix — a blocking gate check so the 6th recurrence is impossible.
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
 * For `Dockerfile.worker` (QUA-654):
 *   1. For every `@longterm-wiki/<pkg>` dep in docker/worker/package.json
 *      with a `file:./packages/<pkg>` spec, verify the Dockerfile has a
 *      matching `COPY packages/<pkg>/` line.
 *   2. Only file: deps require a COPY — workspace:* / version deps resolve
 *      via pnpm and don't need staging.
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
const WORKER_DOCKERFILE_PATH = 'Dockerfile.worker';
const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

// Matches `file:./packages/<pkg>` or `file:packages/<pkg>` dep specs in the
// worker package.json. The Dockerfile must copy each referenced package into
// /deps before `pnpm install --prod` or the install fails.
const FILE_DEP_RE = /^file:\.?\/?(?:packages\/)?([a-z0-9][a-z0-9-]*)\/?$/;

// Matches `COPY packages/<pkg>/` lines in the Dockerfile. The trailing slash on
// `<pkg>/` is required so `COPY packages/foo-bar/` doesn't shadow `packages/foo/`.
// Runs line-by-line to skip `#`-commented lines.
const DOCKERFILE_COPY_RE = /^\s*COPY\s+(?:--[a-z-]+=\S+\s+)*packages\/([a-z0-9][a-z0-9-]*)\//;

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

/**
 * Dockerfile COPY coverage for the worker image. Populated when checking the
 * worker: every `file:./packages/<pkg>` dep in docker/worker/package.json must
 * have a matching `COPY packages/<pkg>/` line in Dockerfile.worker, or
 * `pnpm install --prod` fails at image build because the file: path doesn't
 * resolve. This is the second half of the QUA-605 invariant — the manifest
 * declares the dep, the Dockerfile must actually stage the source tree.
 */
interface DockerCopyCoverage {
  dockerfilePath: string;     // repo-relative; the file to edit to fix violations
  manifestPath: string;       // repo-relative; where the file: deps came from
  fileDeps: Set<string>;      // package basenames (e.g. "url-utils") declared as file: deps
  copied: Set<string>;        // package basenames with a `COPY packages/<pkg>/` line
  missingCopy: string[];      // declared as file: but no COPY line (blocking)
}

interface CheckOptions {
  appsDir?: string;
  /** Path to the worker's standalone package.json. Defaults to
   *  `<repo>/docker/worker/package.json`. */
  workerPkgJson?: string;
  /** Path to the worker Dockerfile. Defaults to `<repo>/Dockerfile.worker`. */
  workerDockerfile?: string;
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
  /** Worker Dockerfile COPY coverage. Only present when both the manifest and
   *  Dockerfile exist. */
  dockerCopy?: DockerCopyCoverage;
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
 * Extract the `<pkg>` names from `file:./packages/<pkg>` dep specs in the
 * worker package.json. Only `@longterm-wiki/*` deps are in scope — other
 * `file:` deps would point outside the packages/ tree and aren't our concern.
 */
function readFileDeps(
  packageJsonPath: string,
  onWarn?: (message: string) => void,
): Set<string> {
  const fileDeps = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, 'utf-8');
  } catch {
    // readDeclaredDeps already warns on the same file; stay silent here to avoid dupes.
    return fileDeps;
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fileDeps;
  }
  for (const section of DEP_SECTIONS) {
    const block = pkg[section];
    if (!block || typeof block !== 'object') continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (!name.startsWith(WORKSPACE_PREFIX)) continue;
      if (typeof spec !== 'string') continue;
      const match = FILE_DEP_RE.exec(spec);
      if (!match) continue;
      const pkgBasename = match[1];
      const declaredBasename = name.slice(WORKSPACE_PREFIX.length);
      // Sanity: the dep spec's packages/<pkg> path should match the package
      // basename. A mismatch (`"@longterm-wiki/foo": "file:./packages/bar"`)
      // would be a developer error; flag it so the mismatch can't silently
      // bypass the COPY check.
      if (pkgBasename !== declaredBasename) {
        onWarn?.(
          `${packageJsonPath}: dep "${name}" points to packages/${pkgBasename} but the package name implies packages/${declaredBasename}`
        );
      }
      fileDeps.add(declaredBasename);
    }
  }
  return fileDeps;
}

/**
 * Parse `Dockerfile.worker` and return the set of `<pkg>` names with a
 * `COPY packages/<pkg>/` line. Comments (lines starting with `#`) are skipped.
 * Continuation lines (`\\` at end of line) are not handled — a COPY that
 * straddles a backslash-continuation is exotic enough that the author should
 * prefer one COPY per line for the image cache anyway.
 */
function readDockerfileCopiedPackages(
  dockerfilePath: string,
): Set<string> {
  const copied = new Set<string>();
  let content: string;
  try {
    content = readFileSync(dockerfilePath, 'utf-8');
  } catch {
    return copied;
  }
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const match = DOCKERFILE_COPY_RE.exec(line);
    if (match) copied.add(match[1]);
  }
  return copied;
}

/**
 * Build the worker Dockerfile COPY coverage report. For every
 * `file:./packages/<pkg>` dep in docker/worker/package.json, verify the
 * Dockerfile has `COPY packages/<pkg>/`. Without the COPY line, pnpm's
 * `file:` resolution fails at image build with "ENOENT: no such file or
 * directory, scandir '/deps/packages/<pkg>'".
 *
 * This closes the second half of the QUA-605 invariant. The existing
 * analyzeWorkerManifest catches "crux imports `@longterm-wiki/foo` but
 * package.json doesn't declare it"; this catches "package.json declares
 * file:./packages/foo but the Dockerfile doesn't stage the source."
 */
function analyzeWorkerDockerfile(
  pkgJsonPath: string,
  dockerfilePath: string,
  onWarn?: (message: string) => void,
): DockerCopyCoverage | null {
  if (!existsSync(pkgJsonPath)) return null;
  if (!existsSync(dockerfilePath)) return null;

  const fileDeps = readFileDeps(pkgJsonPath, onWarn);
  const copied = readDockerfileCopiedPackages(dockerfilePath);
  const missingCopy = [...fileDeps].filter((p) => !copied.has(p)).sort();

  return {
    dockerfilePath: WORKER_DOCKERFILE_PATH,
    manifestPath: WORKER_MANIFEST_PATH,
    fileDeps,
    copied,
    missingCopy,
  };
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
  const workerDockerfile =
    options.workerDockerfile ?? join(PROJECT_ROOT, WORKER_DOCKERFILE_PATH);
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

  const dockerCopy = analyzeWorkerDockerfile(
    workerPkgJson,
    workerDockerfile,
    onWarn,
  );

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

  if (dockerCopy) {
    if (dockerCopy.missingCopy.length === 0) {
      console.log(
        `${c.green}${dockerCopy.dockerfilePath}: OK${c.reset}${c.dim} (${dockerCopy.fileDeps.size} file: dep${dockerCopy.fileDeps.size === 1 ? '' : 's'} / ${dockerCopy.copied.size} copied)${c.reset}`
      );
    } else {
      errors += dockerCopy.missingCopy.length;
      console.log(
        `${c.red}${dockerCopy.dockerfilePath}: ${dockerCopy.missingCopy.length} file: dep${dockerCopy.missingCopy.length > 1 ? 's' : ''} without a matching COPY line:${c.reset}`
      );
      for (const pkg of dockerCopy.missingCopy) {
        console.log(`  ${c.red}packages/${pkg}${c.reset}`);
      }
      console.log(
        `${c.dim}  Fix: add before \`pnpm install --prod\` in ${dockerCopy.dockerfilePath}:${c.reset}`
      );
      for (const pkg of dockerCopy.missingCopy) {
        console.log(`${c.dim}    COPY packages/${pkg}/ ./packages/${pkg}/${c.reset}`);
      }
    }
  }

  console.log();
  if (errors > 0) {
    console.log(
      `${c.red}Found ${errors} workspace dep coverage error${errors > 1 ? 's' : ''}.${c.reset}`
    );
    console.log(
      `${c.dim}Prod Docker builds use \`pnpm install --filter <app>...\` which only resolves declared dependencies.${c.reset}`
    );
    console.log(
      `${c.dim}Undeclared imports pass locally (pnpm hoists) but fail at runtime with ERR_MODULE_NOT_FOUND.${c.reset}`
    );
    console.log(
      `${c.dim}Missing worker COPY lines cause \`pnpm install --prod\` to fail during image build when the file:./packages/<pkg> dep can't resolve.${c.reset}`
    );
    console.log(
      `${c.dim}See QUA-598 (wiki-server), QUA-605 (worker image), and QUA-654 (worker Dockerfile COPY gap) for prior incidents.${c.reset}`
    );
  } else {
    console.log(
      `${c.green}All workspace imports are declared and all worker file: deps are copied.${c.reset}`
    );
  }

  return {
    passed: errors === 0,
    errors,
    warnings,
    apps,
    dockerCopy: dockerCopy ?? undefined,
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
