/**
 * `crux tb scaffold <kebab-name>` — generate boilerplate for a new
 * TableBase entity type. Part 2 of 3 replacing QUA-146 (QUA-455).
 *
 * Generates four files/edits in one shot:
 *   1. `apps/wiki-server/src/routes/tablebase/<name>.ts` — a starter
 *      route file using `createSyncHandler` + `deleteBatchHandler`, with
 *      every table-specific field emitted as a `// TODO:` marker.
 *   2. Inserts a `TABLE_CONFIGS` entry in `crux/tablebase/table-registry.ts`.
 *   3. Inserts an import + entry into
 *      `apps/wiki-server/src/routes/tablebase/mount-registry.ts`.
 *   4. Emits a CLI client at `crux/lib/wiki-server/<name>.ts` (basic
 *      list/sync/delete).
 *
 * No inference, no magic — just boilerplate removal. The caller still
 * has to:
 *   - Add the Drizzle schema to `apps/wiki-server/src/schema.ts`
 *   - Fill in the `TODO:` markers with real field definitions
 *   - Run `validate-tablebase-completeness` and
 *     `validate-tablebase-registry` to verify wiring
 *
 * Usage:
 *   pnpm crux tb scaffold my-new-table
 *   pnpm crux tb scaffold my-new-table --dry-run
 *   pnpm crux tb scaffold my-new-table --force   # overwrite existing files
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { CommandOptions, CommandResult } from "../lib/command-types.ts";

// Paths relative to repo root. The caller (crux.mjs) runs from repo root.
const ROUTE_FILE = (name: string) =>
  join("apps/wiki-server/src/routes/tablebase", `${name}.ts`);
const CLIENT_FILE = (name: string) =>
  join("crux/lib/wiki-server", `${name}.ts`);
const TABLE_REGISTRY_FILE = "crux/tablebase/table-registry.ts";
const MOUNT_REGISTRY_FILE =
  "apps/wiki-server/src/routes/tablebase/mount-registry.ts";

interface ScaffoldOptions extends CommandOptions {
  "dry-run"?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

// ── Name validation ─────────────────────────────────────────────────

const KEBAB_NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

function validateName(name: string): string | null {
  if (!name || name.length < 3) {
    return "name must be at least 3 characters";
  }
  if (!KEBAB_NAME_RE.test(name)) {
    return "name must be kebab-case (lowercase letters, digits, hyphens; must start with a letter, end with alphanumeric)";
  }
  if (name.includes("--")) {
    return "name must not contain consecutive hyphens";
  }
  return null;
}

/** "funding-programs" → "FundingPrograms" */
function kebabToPascal(kebab: string): string {
  return kebab
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** "funding-programs" → "fundingPrograms" */
function kebabToCamel(kebab: string): string {
  const pascal = kebabToPascal(kebab);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** "funding-programs" → "funding_programs" */
function kebabToSnake(kebab: string): string {
  return kebab.replace(/-/g, "_");
}

// ── File templates ──────────────────────────────────────────────────

function routeTemplate(name: string): string {
  const pascal = kebabToPascal(name);
  const camel = kebabToCamel(name);
  const snake = kebabToSnake(name);

  return `import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
// TODO: replace with the real table import after adding the schema.
// import { ${camel} } from "../../schema.js";
import { zv, clampedLimit } from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----
//
// TODO: replace the TODO fields below with the real Zod schema. Keep it
// simple — the factory handles most of the plumbing (parse, validate,
// upsert, audit, things sync, FK resolve, verdicts, claim linking).

const Sync${pascal}ItemSchema = z.object({
  id: z.string().length(10),
  // TODO: add entity FK field(s), e.g.:
  // organizationId: z.string().min(1).max(200),
  // TODO: add data fields.
  // TODO: add optional nullable fields with .nullable().optional().
});

const Sync${pascal}BatchSchema = z.object({
  items: z.array(Sync${pascal}ItemSchema).min(1).max(500),
});

// ---- Route definition (method-chained for Hono RPC type inference) ----

// TODO: uncomment once schema import is wired up.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ${camel}App = new Hono()
  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    // TODO: replace with the real select + formatRow once the schema is added.
    // const rows = await db.select().from(${camel}).orderBy(desc(${camel}.syncedAt)).limit(limit).offset(offset);
    // const [{ total }] = await db.select({ total: count() }).from(${camel});
    const rows: Array<Record<string, unknown>> = [];
    const total = 0;
    // Referenced so the placeholder compiles even without the schema import.
    void eq;
    void desc;
    void count;
    void db;

    return c.json({ items: rows, total, limit, offset });
  })

  // ---- POST /sync — uses sync-factory ----
  // TODO: uncomment after adding the schema.
  // .post("/sync", createSyncHandler({
  //   name: "${name}",
  //   table: ${camel},
  //   batchSchema: Sync${pascal}BatchSchema,
  //   // TODO: add entityRefs for any entity FK fields in the item shape.
  //   // entityRefs: ["organizationId"],
  //   toRow: (item, now) => ({
  //     ...item,
  //     syncedAt: now,
  //     updatedAt: now,
  //   }),
  //   auditRecordType: "${snake}",
  //   // TODO: enable things dual-write if this table has a user-facing
  //   // row you want to appear in global search. If so, also register a
  //   // composer in compose-thing.ts and use it via composeThing(...).
  //   // toThing: (item, titleMap) => ({ ... }),
  // }))

  // ---- POST /delete-batch ----
  // TODO: uncomment after adding the schema.
  // .post("/delete-batch", deleteBatchHandler(${camel}, "${snake}"));
  ;

// Silence unused-import warnings until the schema is wired up.
void createSyncHandler;
void deleteBatchHandler;
void Sync${pascal}BatchSchema;

// ---- Exports ----

export const ${camel}Route = ${camel}App;
export type ${pascal}Route = typeof ${camel}App;
`;
}

function clientTemplate(name: string): string {
  const pascal = kebabToPascal(name);

  return `/**
 * ${pascal} API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via
 * InferResponseType<>, except SyncResult which comes from the shared
 * factory response type (Hono RPC can't narrow through createSyncHandler).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ${pascal}Route } from '../../../apps/wiki-server/src/routes/tablebase/${name}.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';

type RpcClient = ReturnType<typeof hc<${pascal}Route>>;

export type ${pascal}AllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type ${pascal}SyncResult = SyncResponse;

/** Fetch all ${name} rows with pagination. */
export async function getAll${pascal}(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<${pascal}AllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<${pascal}AllResult>(
    'GET',
    \`/api/${name}/all\${qs ? \`?\${qs}\` : ''}\`,
  );
}

/** Sync ${name} (upsert). */
export async function sync${pascal}(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<${pascal}SyncResult>> {
  return apiRequest<${pascal}SyncResult>('POST', '/api/${name}/sync', { items });
}
`;
}

// ── Registry edits ──────────────────────────────────────────────────

function buildTableRegistryEntry(name: string): string {
  const snake = kebabToSnake(name);
  return `  '${name}': {
    fetchByEntityPath: (id) => \`/api/${name}/by-entity/\${encodeURIComponent(id)}\`,
    resultKey: 'items', // TODO: rename to match the /all response shape
    syncPath: '/api/${name}/sync',
    syncMethod: 'POST',
    syncBodyKey: 'items',
    deletePath: '/api/${name}/delete-batch',
    thingsSourceTable: '${snake}', // TODO: set to null if this table doesn't sync to things
  },`;
}

/**
 * Insert a new entry into TABLE_CONFIGS. Find the closing `};` of the
 * object literal and insert the new block immediately before it, keeping
 * alphabetical order within the file as a best-effort — we don't re-sort
 * since the existing file is only loosely sorted by category.
 */
function insertTableRegistryEntry(
  source: string,
  name: string,
): { updated: string; inserted: boolean; alreadyExists: boolean } {
  // Bail if the key already exists.
  const keyRe = new RegExp(`^  '${escapeRegex(name)}':\\s*\\{`, "m");
  if (keyRe.test(source)) {
    return { updated: source, inserted: false, alreadyExists: true };
  }

  // Find the first `};` after `TABLE_CONFIGS`.
  const configStart = source.indexOf("TABLE_CONFIGS");
  if (configStart < 0) {
    throw new Error(
      `Could not find TABLE_CONFIGS in ${TABLE_REGISTRY_FILE}`,
    );
  }
  const closeIdx = source.indexOf("\n};", configStart);
  if (closeIdx < 0) {
    throw new Error(
      `Could not find TABLE_CONFIGS closing brace in ${TABLE_REGISTRY_FILE}`,
    );
  }

  const entry = buildTableRegistryEntry(name);
  const updated =
    source.slice(0, closeIdx + 1) + "\n" + entry + "\n" + source.slice(closeIdx + 1);

  return { updated, inserted: true, alreadyExists: false };
}

/**
 * Insert a new import + array entry into mount-registry.ts.
 */
function insertMountRegistryEntry(
  source: string,
  name: string,
): { updated: string; inserted: boolean; alreadyExists: boolean } {
  const camel = kebabToCamel(name);
  const routeSymbol = `${camel}Route`;
  const importLine = `import { ${routeSymbol} } from "./${name}.js";`;
  const mountLine = `  { path: "/api/${name}", route: ${routeSymbol} },`;

  // Already there?
  if (source.includes(importLine) || source.includes(routeSymbol)) {
    return { updated: source, inserted: false, alreadyExists: true };
  }

  // Insert import: find the last `import { ... } from "./..."` line in
  // the tablebase block, then add after it.
  const lastImportRe = /^import \{ \w+Route \} from "\.\/[a-z-]+\.js";\n/gm;
  let lastImportEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = lastImportRe.exec(source)) !== null) {
    lastImportEnd = match.index + match[0].length;
  }
  if (lastImportEnd < 0) {
    throw new Error(
      `Could not find route imports in ${MOUNT_REGISTRY_FILE}`,
    );
  }

  // Insert array entry: find the last `{ path: "/api/...", route: ... },` in
  // TABLEBASE_MOUNTS and add after it.
  const lastEntryRe = /^  \{ path: "\/api\/[a-z-]+", route: \w+Route \},\n/gm;
  let lastEntryEnd = -1;
  while ((match = lastEntryRe.exec(source)) !== null) {
    lastEntryEnd = match.index + match[0].length;
  }
  if (lastEntryEnd < 0) {
    throw new Error(
      `Could not find TABLEBASE_MOUNTS entries in ${MOUNT_REGISTRY_FILE}`,
    );
  }

  // Build the updated source: insert array entry FIRST (at the later
  // offset), then the import (at the earlier offset), so offsets don't
  // shift out from under us.
  let updated = source.slice(0, lastEntryEnd) + mountLine + "\n" + source.slice(lastEntryEnd);

  // Re-compute the import position in the updated source — it didn't
  // change because we only appended *after* the imports block.
  updated =
    updated.slice(0, lastImportEnd) +
    importLine +
    "\n" +
    updated.slice(lastImportEnd);

  return { updated, inserted: true, alreadyExists: false };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Main command ────────────────────────────────────────────────────

async function scaffoldCommand(
  args: string[],
  options: ScaffoldOptions,
): Promise<CommandResult> {
  const name = args[0];
  if (!name) {
    return {
      exitCode: 1,
      output:
        "Usage: pnpm crux tb scaffold <name> [--dry-run] [--force]\n" +
        "<name> must be kebab-case, e.g. 'research-projects'",
    };
  }

  const validationError = validateName(name);
  if (validationError) {
    return { exitCode: 1, output: `Error: ${validationError}` };
  }

  const dryRun = options["dry-run"] === true || options.dryRun === true;
  const force = options.force === true;

  const lines: string[] = [];
  lines.push(`Scaffolding tablebase entity type "${name}"${dryRun ? " (dry run)" : ""}`);
  lines.push("");

  const routeFile = ROUTE_FILE(name);
  const clientFile = CLIENT_FILE(name);

  // ── Collisions ──
  const errors: string[] = [];
  if (!force) {
    if (existsSync(routeFile)) {
      errors.push(`  ${routeFile} already exists (use --force to overwrite)`);
    }
    if (existsSync(clientFile)) {
      errors.push(`  ${clientFile} already exists (use --force to overwrite)`);
    }
  }
  if (errors.length > 0) {
    return {
      exitCode: 1,
      output: ["Aborted: file collisions:", ...errors].join("\n"),
    };
  }

  // ── Generate file contents ──
  const routeContent = routeTemplate(name);
  const clientContent = clientTemplate(name);

  // ── Read + modify registries ──
  let tableRegistrySource: string;
  try {
    tableRegistrySource = readFileSync(TABLE_REGISTRY_FILE, "utf-8");
  } catch (e) {
    return {
      exitCode: 1,
      output: `Error: could not read ${TABLE_REGISTRY_FILE}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const tableRegistryResult = insertTableRegistryEntry(tableRegistrySource, name);
  if (tableRegistryResult.alreadyExists) {
    lines.push(`  (registry) ${TABLE_REGISTRY_FILE} already has '${name}' — skipping`);
  } else {
    lines.push(`  ✓ ${TABLE_REGISTRY_FILE} — new TABLE_CONFIGS entry`);
  }

  let mountRegistrySource: string;
  try {
    mountRegistrySource = readFileSync(MOUNT_REGISTRY_FILE, "utf-8");
  } catch (e) {
    return {
      exitCode: 1,
      output: `Error: could not read ${MOUNT_REGISTRY_FILE}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const mountRegistryResult = insertMountRegistryEntry(mountRegistrySource, name);
  if (mountRegistryResult.alreadyExists) {
    lines.push(`  (registry) ${MOUNT_REGISTRY_FILE} already has ${name} — skipping`);
  } else {
    lines.push(`  ✓ ${MOUNT_REGISTRY_FILE} — new import + TABLEBASE_MOUNTS entry`);
  }

  lines.push(`  ✓ ${routeFile} — starter route file (${routeContent.split("\n").length} lines)`);
  lines.push(`  ✓ ${clientFile} — CLI client module`);

  // ── Write (or dry-run) ──
  if (!dryRun) {
    writeFileSync(routeFile, routeContent, "utf-8");
    writeFileSync(clientFile, clientContent, "utf-8");
    if (tableRegistryResult.inserted) {
      writeFileSync(TABLE_REGISTRY_FILE, tableRegistryResult.updated, "utf-8");
    }
    if (mountRegistryResult.inserted) {
      writeFileSync(MOUNT_REGISTRY_FILE, mountRegistryResult.updated, "utf-8");
    }
  } else {
    lines.push("");
    lines.push("(dry run — no files written)");
  }

  // ── Next steps ──
  lines.push("");
  lines.push("Next steps:");
  lines.push(`  1. Add the Drizzle schema for "${name}" to apps/wiki-server/src/schema.ts`);
  lines.push(`  2. Fill in the TODO: markers in ${routeFile}`);
  lines.push(`     - Zod schema (entity refs, data fields)`);
  lines.push(`     - Uncomment the .post("/sync", ...) and .post("/delete-batch", ...) blocks`);
  lines.push(`     - Replace the placeholder GET /all select with the real query`);
  lines.push(`  3. Run \`pnpm --filter wiki-server typecheck\` to verify the route compiles`);
  lines.push(`  4. Run \`npx tsx crux/validate/validate-tablebase-completeness.ts\` — all rows should be green`);
  lines.push(`  5. Run \`npx tsx crux/validate/validate-tablebase-registry.ts\` — registry ↔ route file cross-check`);
  lines.push(`  6. Write a test: \`apps/wiki-server/src/__tests__/${name}.test.ts\``);

  return { exitCode: 0, output: lines.join("\n") };
}

export const commands = {
  scaffold: scaffoldCommand,
};
