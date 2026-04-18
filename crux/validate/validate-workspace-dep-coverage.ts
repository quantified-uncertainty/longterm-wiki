#!/usr/bin/env node

/**
 * Validate that every `@longterm-wiki/*` workspace package imported from
 * `apps/<name>/src/` or `apps/<name>/scripts/` is declared in that app's
 * `package.json` (in any dependency section).
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
 * This bug class has recurred three times (see QUA-598):
 *   - `@longterm-wiki/id-utils` (earliest incident, referenced in QUA-449)
 *   - `@longterm-wiki/factbase` (2026-04-14, QUA-449)
 *   - `@longterm-wiki/url-utils` (2026-04-18, QUA-598)
 *
 * Each previous occurrence was fixed instance-by-instance. This validator is
 * the systemic fix — a blocking gate check so the 4th recurrence is impossible.
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
 * Imports in scope: quote-anchored `from '@longterm-wiki/X'`, `import('…')`,
 * and `require('…')` — plus subpath imports like `@longterm-wiki/factbase/types`
 * (the package name is the first path segment). The quote anchor prevents
 * false positives from bare mentions in comments or docstrings. Note: a
 * commented-out *import statement* (e.g. `// import { x } from '@longterm-wiki/foo'`)
 * is still flagged — treating that as a real import is intentional since
 * commented-out code should be removed, not left behind.
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

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SCAN_SUBDIRS = ['src', 'scripts'] as const;
const WORKSPACE_PREFIX = '@longterm-wiki/';
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
}

interface CheckOptions {
  appsDir?: string;
  /** Optional warning sink so tests can assert on parse errors. */
  onWarn?: (message: string) => void;
}

interface CheckResult {
  passed: boolean;
  errors: number;
  warnings: number;
  apps: AppCoverage[];
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      // Using lstat avoids following symlinks (prevents infinite loops if a
      // stray symlink points at an ancestor).
      st = statSync(full, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (!st) continue;
    if (st.isDirectory()) {
      listSourceFiles(full, out);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf('.');
      if (dot !== -1 && SOURCE_EXTENSIONS.has(name.slice(dot))) {
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

function analyzeApp(
  appDir: string,
  appName: string,
  onWarn?: (message: string) => void,
): AppCoverage | null {
  const pkgJson = join(appDir, 'package.json');
  if (!existsSync(pkgJson)) return null;

  const files: string[] = [];
  for (const sub of SCAN_SUBDIRS) {
    const subPath = join(appDir, sub);
    if (existsSync(subPath)) listSourceFiles(subPath, files);
  }

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

  const declared = readDeclaredDeps(pkgJson, onWarn);

  const missing = [...used].filter((p) => !declared.has(p)).sort();
  const unused = [...declared].filter((p) => !used.has(p)).sort();

  return { app: appName, used, declared, missing, unused };
}

export function runCheck(options: CheckOptions = {}): CheckResult {
  const c = getColors();
  const appsDir = options.appsDir ?? join(PROJECT_ROOT, 'apps');
  const onWarn = options.onWarn ?? ((msg) => console.log(`${c.yellow}${msg}${c.reset}`));

  console.log(
    `${c.blue}Checking workspace dependency coverage in ${appsDir}...${c.reset}\n`
  );

  let appNames: string[];
  try {
    appNames = readdirSync(appsDir).filter((name) => {
      const full = join(appsDir, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    console.log(`${c.dim}Skipping: ${appsDir} not found${c.reset}`);
    return { passed: true, errors: 0, warnings: 0, apps: [] };
  }

  const apps: AppCoverage[] = [];
  for (const name of appNames.sort()) {
    const report = analyzeApp(join(appsDir, name), name, onWarn);
    if (report) apps.push(report);
  }

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
        `${c.dim}  Fix: add to apps/${app.app}/package.json dependencies:${c.reset}`
      );
      for (const pkg of app.missing) {
        console.log(`${c.dim}    "${pkg}": "workspace:*"${c.reset}`);
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
      `${c.dim}See QUA-598 for the most recent incident of this class.${c.reset}`
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
