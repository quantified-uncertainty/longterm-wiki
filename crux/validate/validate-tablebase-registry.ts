#!/usr/bin/env node

/**
 * Validate that the crux `TABLE_CONFIGS` registry and the wiki-server
 * tablebase route filesystem stay in sync. Part 3 of 3 replacing QUA-146
 * (QUA-456).
 *
 * Three failure modes this catches:
 *
 * 1. **Registry entry with no route file** — CLI tries to hit a nonexistent
 *    endpoint. Either the route was deleted and the registry was forgotten,
 *    or the registry entry was typoed.
 *
 * 2. **Route file with `/sync` but no registry entry** — new route added
 *    without wiring the CLI-side registry. Tools that iterate `TABLE_CONFIGS`
 *    (scanner, enrichment, sync orchestrators) silently skip the new table.
 *
 * 3. **`syncPath` / `deletePath` drift** — registry points at a URL the
 *    route file doesn't actually serve. Common after a route rename or a
 *    refactor that changed the path prefix.
 *
 * Pairs with `apps/wiki-server/src/__tests__/mount-registry.test.ts`
 * (QUA-454), which checks the *wiki-server* mount registry against the
 * filesystem. This validator is the cross-file step — it proves that both
 * sides of the registry (crux client + wiki-server server) agree.
 *
 * Usage: npx tsx crux/validate/validate-tablebase-registry.ts
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getColors } from "../lib/output.ts";
import { TABLEBASE_NON_ROUTE_FILES } from "../../apps/wiki-server/src/api-types.ts";

const ROUTES_DIR = "apps/wiki-server/src/routes/tablebase";
const REGISTRY_PATH = "crux/tablebase/table-registry.ts";

// Non-route files sourced from the canonical list in mount-registry.ts
// so all three consumers share one source of truth.
const NON_ROUTE_FILES = new Set<string>(TABLEBASE_NON_ROUTE_FILES);

// Route files that exist on disk but are INTENTIONALLY not in
// `crux/tablebase/table-registry.ts`. Each has a reason; keep this list
// in sync with the manual-mount list in
// `apps/wiki-server/src/routes/tablebase/mount-registry.ts`
// (TABLEBASE_MANUAL_MOUNTS) and the sync-factory exclusions in
// `docs/agent-rules/tablebase-sync-factory.md`.
const REGISTRY_EXCLUSIONS = new Set<string>([
  // Custom ID allocation via nextval('entity_id_seq') — not a bulk-sync path.
  "ids",
  // Slug displacement + statement_timeout overrides, hand-written /sync.
  // entities.ts has its own /sync but the semantics diverge enough that the
  // generic registry-driven client wouldn't work correctly.
  "entities",
  // IT IS the cross-base index — not a TableBase member.
  "things",
  // External-API variant: only `/sync/:did`, not the standard `/sync`.
  "bluesky",
  // Has NO /sync endpoint — read-only dispatch across tables.
  "entity-profile",
  // Has NO /sync endpoint — single-record utility.
  "record-lookup",
  // Has NO /sync endpoint — people directory alias over the entities table.
  "people",
  // Has NO /sync endpoint — hallucination-risk coverage scanner output.
  "coverage-scans",
  // Scanner output — its /sync is driven by groundskeeper, not the tablebase CLI.
  "scanner-results",
  // Talent-flow reads — aggregated queries, no /sync.
  "talent-flows",
]);

interface RegistryEntry {
  /** The canonical kebab-case key used in TABLE_CONFIGS. */
  key: string;
  /** The `syncPath` literal from the registry. Null if the field was set to null. */
  syncPath: string | null;
  /** The HTTP method the syncPath uses. Default POST. */
  syncMethod: "POST" | "PATCH";
  /** The `deletePath` literal from the registry. Null if set to null. */
  deletePath: string | null;
}

interface CheckResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  registryKeys: string[];
  routeFiles: string[];
  checkedPaths: number;
}

/**
 * Parse `crux/tablebase/table-registry.ts` into a list of `RegistryEntry`s
 * by regex. We avoid `import()` because:
 *   1. It'd pull in the full crux module graph for a lint check
 *   2. Errors inside the imported file should be separate failures, not
 *      show up as "registry parse error"
 *   3. A regex over the source text is resilient to dependency breakage.
 */
function parseRegistry(): RegistryEntry[] {
  const source = readFileSync(REGISTRY_PATH, "utf-8");
  const entries: RegistryEntry[] = [];

  // Match each `'key-name': { ... }` block within TABLE_CONFIGS. Start at
  // the `TABLE_CONFIGS = {` line and walk forward.
  const configStart = source.indexOf("TABLE_CONFIGS");
  if (configStart < 0) {
    throw new Error(`Could not find TABLE_CONFIGS in ${REGISTRY_PATH}`);
  }

  // Use a simple brace walker scoped to TABLE_CONFIGS. Entries look like:
  //   'key-name': {
  //     fetchByEntityPath: ...,
  //     syncPath: '/api/foo/sync',
  //     deletePath: '/api/foo/delete-batch',
  //     ...
  //   },
  const configBody = source.slice(configStart);

  // Match entry keys: single-quoted or bare identifier followed by `:` + `{`
  // then capture the object body up to the balanced closing brace.
  const entryRe = /^  (?:'([a-z0-9-]+)'|([a-zA-Z][a-zA-Z0-9_-]*))\s*:\s*\{/gm;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(configBody)) !== null) {
    const key = (match[1] ?? match[2])!;
    // Walk from the matched `{` to find the balanced closing `}`.
    const openBrace = match.index + match[0].length - 1;
    let depth = 1;
    let i = openBrace + 1;
    while (i < configBody.length && depth > 0) {
      const ch = configBody[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth !== 0) {
      // Unbalanced — bail out rather than silently mis-parsing.
      throw new Error(
        `Unbalanced braces in ${REGISTRY_PATH} near key "${key}"`,
      );
    }
    const body = configBody.slice(openBrace + 1, i - 1);

    // Extract syncPath and deletePath. They can be either a string literal
    // or `null`. Template literals (like `/api/foo/bar/${...}`) are not
    // expected for these two fields — if they show up, we treat them as
    // "unknown" and skip path validation.
    const syncPathMatch = /\bsyncPath\s*:\s*(?:'([^']*)'|"([^"]*)"|(null))/.exec(
      body,
    );
    const deletePathMatch = /\bdeletePath\s*:\s*(?:'([^']*)'|"([^"]*)"|(null))/.exec(
      body,
    );
    const syncMethodMatch = /\bsyncMethod\s*:\s*(?:'([^']*)'|"([^"]*)")/.exec(body);

    const syncPath =
      syncPathMatch == null
        ? null
        : syncPathMatch[3] === "null"
          ? null
          : (syncPathMatch[1] ?? syncPathMatch[2] ?? null);
    const deletePath =
      deletePathMatch == null
        ? null
        : deletePathMatch[3] === "null"
          ? null
          : (deletePathMatch[1] ?? deletePathMatch[2] ?? null);
    const syncMethodRaw = syncMethodMatch?.[1] ?? syncMethodMatch?.[2] ?? "POST";
    const syncMethod: "POST" | "PATCH" =
      syncMethodRaw === "PATCH" ? "PATCH" : "POST";

    // Guard against `TABLE_ALIASES` below — stop parsing when we leave
    // the TABLE_CONFIGS object. We detect this by checking whether the
    // next non-whitespace after the closing `},` is another entry-like
    // pattern or something else (e.g. `};` followed by `TABLE_ALIASES`).
    entries.push({ key, syncPath, syncMethod, deletePath });

    // Look ahead: if we hit `};` (end of TABLE_CONFIGS), break out early.
    // The regex lastIndex is inside `entryRe`; we nudge it past our walker.
    entryRe.lastIndex = i;

    const afterBrace = configBody.slice(i).trimStart();
    if (afterBrace.startsWith("};")) {
      break;
    }
  }

  return entries;
}

/**
 * List Hono route files in `apps/wiki-server/src/routes/tablebase/`,
 * excluding non-route helper modules.
 */
function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test-d.ts") &&
        !NON_ROUTE_FILES.has(f),
    )
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
}

/**
 * Check whether a route file declares a POST handler matching the given
 * path suffix. `suffix` is the part AFTER the route's mount prefix —
 * e.g. for `syncPath: '/api/foo/sync'` mounted at `/api/foo`, we look for
 * `.post("/sync", ...)` in the file.
 *
 * Also accepts nested paths like `/questions/sync` (prediction-markets).
 */
function routeDeclaresPath(
  routeSource: string,
  method: "post" | "patch" | "delete",
  suffix: string,
): boolean {
  // Normalize: ensure leading slash, escape regex metacharacters.
  const normalized = suffix.startsWith("/") ? suffix : `/${suffix}`;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Matches `.post("/path", ...)` or `.post('/path', ...)`.
  const re = new RegExp(`\\.${method}\\(\\s*["']${escaped}["']`);
  return re.test(routeSource);
}

/**
 * Given a registry entry's `syncPath` like `/api/grants/sync` or
 * `/api/prediction-markets/questions/sync`, determine:
 *   - the wiki-server mount prefix (the filename on disk)
 *   - the post-mount suffix inside the file
 *
 * Returns null if the path doesn't start with `/api/`.
 */
function splitPath(fullPath: string): { routeFile: string; suffix: string } | null {
  const match = /^\/api\/([a-z0-9-]+)(\/.*)$/.exec(fullPath);
  if (!match) return null;
  return { routeFile: match[1]!, suffix: match[2]! };
}

export function runCheck(): CheckResult {
  const c = getColors();
  console.log(
    `${c.blue}Cross-checking crux TABLE_CONFIGS ↔ wiki-server tablebase routes...${c.reset}\n`,
  );

  const errors: string[] = [];
  const warnings: string[] = [];

  // Parse crux registry
  let entries: RegistryEntry[];
  try {
    entries = parseRegistry();
  } catch (e) {
    errors.push(
      `Failed to parse ${REGISTRY_PATH}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {
      passed: false,
      errors,
      warnings,
      registryKeys: [],
      routeFiles: [],
      checkedPaths: 0,
    };
  }

  const registryKeys = entries.map((e) => e.key).sort();
  const routeFiles = listRouteFiles();
  const routeFilesSet = new Set(routeFiles);
  const registryKeysSet = new Set(registryKeys);

  // ── Check 1: Every registry key has a corresponding route file ──
  // The route-file name matches the registry key by convention.
  // Some keys can reference a nested path (prediction-market-questions
  // lives inside prediction-markets.ts) — handle those by checking the
  // top-level directory prefix of the syncPath.
  for (const entry of entries) {
    if (entry.syncPath == null) {
      // Skipping: registry entry with no syncPath (rare, but legal for
      // read-only tables).
      continue;
    }
    const split = splitPath(entry.syncPath);
    if (!split) {
      errors.push(
        `Registry key "${entry.key}": syncPath "${entry.syncPath}" does not match the /api/<slug>/... pattern`,
      );
      continue;
    }
    if (!routeFilesSet.has(split.routeFile)) {
      errors.push(
        `Registry key "${entry.key}": syncPath "${entry.syncPath}" points at route file "${split.routeFile}.ts" which does not exist`,
      );
    }
  }

  // ── Check 2: Every route file with /sync has a registry entry (or is excluded) ──
  // For each route file, read the source and see if it declares a
  // POST /sync endpoint. If so, require either a registry key matching
  // the filename, OR an entry in REGISTRY_EXCLUSIONS.
  for (const routeFile of routeFiles) {
    if (REGISTRY_EXCLUSIONS.has(routeFile)) continue;

    const filePath = join(ROUTES_DIR, `${routeFile}.ts`);
    let source: string;
    try {
      source = readFileSync(filePath, "utf-8");
    } catch {
      warnings.push(`Could not read ${filePath}`);
      continue;
    }

    // Does this file declare any POST /sync endpoint? We look for the
    // literal ".post(\"/sync\"" or ".post('/sync'" pattern anywhere in
    // the source. Nested sync paths like /questions/sync also count.
    const hasAnySync = /\.post\(\s*["'](?:\/[a-z0-9-]+)?\/sync["']/.test(source);
    if (!hasAnySync) {
      // No /sync endpoint in this route file. Fine — many routes are
      // read-only or dispatch-only. Skip without complaint.
      continue;
    }

    // The route declares at least one /sync. Check whether any registry
    // entry points at this file.
    const hasRegistryEntry = entries.some((e) => {
      if (e.syncPath == null) return false;
      const split = splitPath(e.syncPath);
      return split?.routeFile === routeFile;
    });

    if (!hasRegistryEntry) {
      errors.push(
        `Route file "${routeFile}.ts": declares POST /sync but has no entry in crux/tablebase/table-registry.ts (add one, or add "${routeFile}" to REGISTRY_EXCLUSIONS in validate-tablebase-registry.ts with a reason)`,
      );
    }
  }

  // ── Check 3: Every registry syncPath/deletePath resolves to a real endpoint ──
  // The route file must actually declare the POST/delete handler at that
  // path. Catches registry entries that were updated incorrectly after a
  // route renamed its `.post('/sync', ...)` to `.post('/batch', ...)` or
  // similar.
  let checkedPaths = 0;
  for (const entry of entries) {
    if (entry.syncPath != null) {
      const split = splitPath(entry.syncPath);
      if (split && routeFilesSet.has(split.routeFile)) {
        const filePath = join(ROUTES_DIR, `${split.routeFile}.ts`);
        let source: string;
        try {
          source = readFileSync(filePath, "utf-8");
        } catch {
          continue;
        }
        checkedPaths++;
        const method = entry.syncMethod === "PATCH" ? "patch" : "post";
        if (!routeDeclaresPath(source, method, split.suffix)) {
          errors.push(
            `Registry key "${entry.key}": syncPath "${entry.syncPath}" (${entry.syncMethod}) but ${split.routeFile}.ts has no \`.${method}("${split.suffix}", ...)\` declaration`,
          );
        }
      }
    }
    if (entry.deletePath != null) {
      const split = splitPath(entry.deletePath);
      if (split && routeFilesSet.has(split.routeFile)) {
        const filePath = join(ROUTES_DIR, `${split.routeFile}.ts`);
        let source: string;
        try {
          source = readFileSync(filePath, "utf-8");
        } catch {
          continue;
        }
        checkedPaths++;
        // deletePath usually maps to `.post('/delete-batch', ...)`
        // (deleteBatchHandler factory) but some routes hand-roll a
        // plain `.post('/delete', ...)`. Accept either.
        if (!routeDeclaresPath(source, "post", split.suffix)) {
          errors.push(
            `Registry key "${entry.key}": deletePath "${entry.deletePath}" but ${split.routeFile}.ts has no \`.post("${split.suffix}", ...)\` declaration`,
          );
        }
      }
    }
  }

  // Print summary
  if (errors.length === 0) {
    console.log(
      `  ${c.green}✓${c.reset} ${registryKeys.length} registry entries, ${routeFiles.length} route files, ${checkedPaths} paths checked`,
    );
  } else {
    console.log(`  ${c.red}✗ ${errors.length} error(s):${c.reset}\n`);
    for (const err of errors) {
      console.log(`  ${c.red}•${c.reset} ${err}`);
    }
  }
  if (warnings.length > 0) {
    console.log(`\n  ${c.yellow}${warnings.length} warning(s):${c.reset}`);
    for (const warn of warnings) {
      console.log(`  ${c.yellow}•${c.reset} ${warn}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    registryKeys,
    routeFiles,
    checkedPaths,
  };
}

if (process.argv[1]?.includes("validate-tablebase-registry")) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
