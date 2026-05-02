#!/usr/bin/env node
/**
 * Pre-build crux/ TypeScript to crux/dist/ JavaScript (QUA-1053).
 *
 * Replaces the per-invocation `node --import tsx/esm crux/crux.mjs` runtime
 * compilation. Eliminates tsx-cache contention across concurrent agent
 * slots (the 25-min `linear create` hangs and multi-hour pr-patrol stalls)
 * and drops `pnpm crux --help` startup from ~1.5s to ~300ms.
 *
 * Hybrid output:
 *   1. Per-file: every crux/<rel>.ts → crux/dist/<rel>.js. Relative imports
 *      stay external (just .ts → .js rewrite); npm packages stay external;
 *      cross-workspace .ts (packages/factbase, apps/wiki-server) is bundled
 *      inline since those workspaces don't ship .js. lib/cli.ts's
 *      runScript() spawns these directly with plain `node`.
 *   2. Single bundle: crux/dist/crux.js collapses crux.mjs + all 140+
 *      command modules into one file. ESM cold start is dominated by
 *      file-open cost; one large bundle is ~3x faster than per-file mode
 *      for the main CLI entry.
 *
 * Usage:
 *   node crux/build.mjs            # one-shot build
 *   node crux/build.mjs --watch    # rebuild on change (per-file only)
 */

import { build, context } from 'esbuild';
import { glob } from 'tinyglobby';
import { rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, sep } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CRUX_SRC = HERE;
const DIST = join(CRUX_SRC, 'dist');

const WATCH = process.argv.includes('--watch');

/**
 * Resolution rules:
 *
 *   1. Relative imports inside crux/ → externalize, rewrite .ts/.tsx → .js.
 *      Each crux .ts gets its own .js sibling in dist/, and the import
 *      graph between them stays as plain ESM imports.
 *
 *   2. Relative imports out of crux/ (e.g. ../../packages/factbase/src/*.ts,
 *      ../../apps/wiki-server/src/*.ts) → bundle inline. Those workspaces
 *      don't ship .js outputs — their `exports` point directly at .ts —
 *      so plain node can't load them. Bundling pulls the source in.
 *
 *   3. npm packages imported by crux/ files → externalize. Resolved at
 *      runtime via node_modules.
 *
 *   4. npm packages imported by *cross-workspace bundled* files → bundle.
 *      Those packages live in apps/<x>/node_modules and aren't reachable
 *      from crux/dist/ via node's resolver. Bundling avoids the lookup.
 *
 * Entry points are skipped from rule 1 (esbuild rejects externalizing them).
 */
const cruxResolver = {
  name: 'crux-resolver',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (args.kind === 'entry-point') return null;
      const abs = resolve(dirname(args.importer), args.path);
      const insideCrux = abs === CRUX_SRC || abs.startsWith(CRUX_SRC + sep);
      if (!insideCrux) {
        // Cross-workspace relative import — let esbuild bundle.
        return null;
      }
      let path = args.path;
      if (path.endsWith('.ts')) path = path.slice(0, -3) + '.js';
      else if (path.endsWith('.tsx')) path = path.slice(0, -4) + '.js';
      else if (path.endsWith('.mjs')) path = path.slice(0, -4) + '.js';
      return { path, external: true };
    });

    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      // Node builtins always external.
      if (args.path.startsWith('node:')) return { path: args.path, external: true };
      // Workspace packages (@longterm-wiki/*) always bundle: their
      // package.json `exports` point at .ts source, which plain node
      // can't load.
      if (args.path.startsWith('@longterm-wiki/')) return null;
      // npm package imports from inside crux → externalize so runtime
      // node resolves them via root node_modules (these packages must
      // be declared in root package.json).
      const importerInsideCrux =
        args.importer === CRUX_SRC ||
        args.importer.startsWith(CRUX_SRC + sep);
      if (importerInsideCrux) {
        return { path: args.path, external: true };
      }
      // npm package imports reached transitively through a bundled
      // workspace file (e.g. drizzle-orm pulled in by an
      // apps/wiki-server/* file we're bundling). Bundle them inline so
      // we don't depend on apps/<x>/node_modules being on the import
      // search path at runtime.
      return null;
    });
  },
};

async function gatherEntries() {
  const patterns = [
    'crux/**/*.ts',
    'crux/**/*.mjs',
  ];
  const ignore = [
    'crux/dist/**',
    'crux/node_modules/**',
    'crux/build.mjs',
    'crux/**/__tests__/**',
    'crux/**/*.test.ts',
    'crux/**/*.test-d.ts',
    'crux/**/*.d.ts',
  ];
  const files = await glob(patterns, { cwd: ROOT, ignore });
  return files.map((f) => join(ROOT, f));
}

/**
 * Main-entry resolver — bundles ALL relative imports inline (whether
 * inside crux/ or cross-workspace). Used only for the single-bundle
 * main build. Same npm-package logic as cruxResolver.
 */
const mainBundleResolver = {
  name: 'main-bundle-resolver',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      if (args.path.startsWith('node:')) return { path: args.path, external: true };
      if (args.path.startsWith('@longterm-wiki/')) return null;
      // Same split as cruxResolver: npm pkgs from inside crux → external,
      // pkgs reached transitively through workspace files → bundle.
      const importerInsideCrux =
        args.importer === CRUX_SRC ||
        args.importer.startsWith(CRUX_SRC + sep);
      if (importerInsideCrux) {
        return { path: args.path, external: true };
      }
      return null;
    });
  },
};

/**
 * Bake source paths AND neutralize self-invocation guards at load time.
 *
 * Two transforms in one plugin so we read each source file only once:
 *
 *   1. Rewrite `import.meta.dirname` and `import.meta.url` to literal
 *      strings of the SOURCE file's location. Many files compute
 *      PROJECT_ROOT via `join(import.meta.dirname, '../..')` (47 callsites
 *      across crux/) which assumes the source-tree depth. From dist/,
 *      that math goes one level wrong. Baking source paths makes the
 *      computations behave as if running from source.
 *
 *      Skip lib/cli.ts — it deliberately uses `import.meta.url` to detect
 *      whether it's running from dist/ vs source. Its dist-mode answer is
 *      injected separately via `define: __CRUX_DIST_DIR__`.
 *
 *   2. In the single-bundle main, rewrite `process.argv[1] === fileURLToPath(import.meta.url)`
 *      to `false` for non-entry modules. Without this, all 83 guards fire
 *      because the bundle shares one `import.meta.url`. Per-file builds
 *      do NOT need this rewrite (each .ts gets its own .js sibling, so
 *      the runtime URL still maps 1:1 to the source).
 *
 * Accepts both `fileURLToPath` and aliased identifiers like
 * `_fileURLToPath` (`import { fileURLToPath as _fileURLToPath }` shows up
 * in several files to dodge a name conflict).
 */
const SELF_INVOKE_RE =
  /process\.argv\[1\]\s*===\s*[A-Za-z_$][A-Za-z0-9_$]*\(\s*import\.meta\.url\s*\)/g;
const ENTRY_BASENAME = 'crux.mjs';
const CLI_LIB_BASENAME = 'cli.ts';

// Match `dirname(fileURLToPath(import.meta.url))` and the `path.dirname(...)`
// variant. Used to recover the source dir in files that didn't migrate to
// `import.meta.dirname` (~13 callsites). Aliased fileURLToPath imports are
// permitted (see SELF_INVOKE_RE for the same idiom).
const DIRNAME_FROM_URL_RE =
  /(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?dirname\(\s*[A-Za-z_$][A-Za-z0-9_$]*\(\s*import\.meta\.url\s*\)\s*\)/g;

function makeSourceTransform({ stripGuards }) {
  return {
    name: stripGuards ? 'bake-paths-and-strip-guards' : 'bake-source-paths',
    setup(b) {
      b.onLoad({ filter: /\.(ts|mjs|js)$/ }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        let modified = source;

        // Skip path-baking for lib/cli.ts. It uses `import.meta.url` to
        // probe its own runtime location for dist detection; baking
        // source paths here would defeat that. SCRIPTS_DIR in dist mode
        // is supplied via the `__CRUX_DIST_DIR__` define instead.
        const isCliLib = args.path.endsWith(`${sep}lib${sep}${CLI_LIB_BASENAME}`);
        if (!isCliLib) {
          const sourceDir = JSON.stringify(dirname(args.path));
          // Bake `import.meta.dirname` and the equivalent
          // `dirname(fileURLToPath(import.meta.url))` idiom to a literal
          // string of the SOURCE file's dirname. This makes
          // `join(import.meta.dirname, '../..')` (47 callsites) and
          // `path.join(__dirname, '../../..')` (~13 callsites where
          // __dirname comes from fileURLToPath) compute the project
          // root correctly even when the file is loaded from dist/.
          //
          // We deliberately do NOT bake bare `import.meta.url` —
          // self-invocation guards (`process.argv[1] === fileURLToPath(import.meta.url)`)
          // must compare against the runtime URL of the dist file so
          // direct `node dist/foo.js` invocation still triggers main().
          modified = modified
            .replace(/\bimport\.meta\.dirname\b/g, sourceDir)
            .replace(DIRNAME_FROM_URL_RE, sourceDir);
        }

        if (stripGuards && !args.path.endsWith(sep + ENTRY_BASENAME)) {
          // In single-bundle mode every module shares the bundle's
          // `import.meta.url`, so every guard would match. Replace the
          // comparison with `false` for non-entry modules.
          modified = modified.replace(SELF_INVOKE_RE, 'false');
        }

        if (modified === source) return null;
        const ext = args.path.endsWith('.ts') ? 'ts' : 'js';
        return { contents: modified, loader: ext };
      });
    },
  };
}

const bakeSourcePathsPerFile = makeSourceTransform({ stripGuards: false });
const bakePathsAndStripGuardsBundle = makeSourceTransform({ stripGuards: true });

const buildOptions = {
  outdir: DIST,
  outbase: CRUX_SRC,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: 'linked',
  logLevel: WATCH ? 'info' : 'warning',
  plugins: [cruxResolver, bakeSourcePathsPerFile],
  legalComments: 'none',
  // `__CRUX_DIST_DIR__` lets lib/cli.ts know it's running from a dist
  // build (and where dist lives). Source/tsx mode leaves the identifier
  // undefined — the cli.ts code uses `typeof` to branch safely.
  define: {
    __CRUX_DIST_DIR__: JSON.stringify(DIST),
  },
  // Required for ESM bundles that pull in CJS deps (e.g. yaml). esbuild's
  // CJS interop emits `require()` calls; without this banner the runtime
  // raises "Dynamic require of X is not supported". We assign through
  // globalThis only if `require` isn't already in scope so we don't
  // shadow a legitimate per-file `require` declared in source.
  banner: {
    js: "import { createRequire as _crux_createRequire } from 'module'; const __cruxRequire = _crux_createRequire(import.meta.url); if (typeof require === 'undefined') { globalThis.require = __cruxRequire; }",
  },
};

// Main-entry bundle: collapses crux.mjs + all 140+ command modules + their
// transitive deps into a single dist/crux.js. ESM startup is dominated by
// the cost of opening + parsing many small files; one big file is
// dramatically faster (~80ms vs ~700ms for the per-file build).
const mainBundleOptions = {
  ...buildOptions,
  outdir: undefined,
  outfile: join(DIST, 'crux.js'),
  entryPoints: [join(CRUX_SRC, 'crux.mjs')],
  plugins: [mainBundleResolver, bakePathsAndStripGuardsBundle],
};

async function run() {
  // Clean prior output to avoid stale .js files lingering after .ts deletes.
  rmSync(DIST, { recursive: true, force: true });

  const entryPoints = await gatherEntries();

  if (WATCH) {
    // In watch mode only build the per-file outputs — they cover every
    // entry point (main + spawned scripts). The single-bundle dist/crux.js
    // is for production startup; dev iteration uses per-file output.
    const ctx = await context({ ...buildOptions, entryPoints });
    await ctx.watch();
    console.log(`[crux:build] watching ${entryPoints.length} files… (single-bundle main not built — run 'pnpm crux:build' for that)`);
    process.on('SIGINT', () => { ctx.dispose().then(() => process.exit(0)); });
    process.on('SIGTERM', () => { ctx.dispose().then(() => process.exit(0)); });
    // ctx.watch() resolves once watching starts; we have no other handles
    // keeping the event loop alive, so block here forever.
    await new Promise(() => {});
    return;
  }

  const start = Date.now();
  // Build per-file outputs for all .ts files. Spawned scripts (validate-*,
  // page-improver, etc.) are invoked as their own .js files and need this.
  const perFileResult = await build({ ...buildOptions, entryPoints });
  if (perFileResult.errors?.length) {
    console.error(`[crux:build] per-file build: ${perFileResult.errors.length} error(s)`);
    process.exitCode = 1;
    return;
  }
  // Build a single-bundle main entry that overwrites the per-file
  // dist/crux.js with a faster collapsed version. Subprocess scripts keep
  // their per-file form so runScript() can still spawn them directly.
  const mainResult = await build(mainBundleOptions);
  if (mainResult.errors?.length) {
    console.error(`[crux:build] main bundle: ${mainResult.errors.length} error(s)`);
    process.exitCode = 1;
    return;
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`[crux:build] built ${entryPoints.length} files + main bundle in ${elapsed}s → ${DIST}`);
}

run().catch((err) => {
  console.error('[crux:build] failed:', err);
  process.exit(1);
});
