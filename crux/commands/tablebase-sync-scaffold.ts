/**
 * `crux tb sync-scaffold <route-name>` — emits a starter TableBase sync route
 * file using the createSyncHandler factory.
 *
 * Without this command, agents adding new sync routes will copy-paste an
 * existing 200-line handler instead of using the factory. The scaffolder
 * gives them a 60-line starting point with the minimum config filled in,
 * plus comments pointing to the optional fields they can add later.
 *
 * Usage:
 *
 *   crux tb sync-scaffold widgets
 *     → emits scaffolded route to stdout
 *
 *   crux tb sync-scaffold widgets --table-name=widgets
 *     → uses --table-name as the Drizzle table identifier
 *       (defaults to camelCased route-name)
 *
 *   crux tb sync-scaffold widgets --output=apps/wiki-server/src/routes/tablebase/widgets.ts
 *     → writes to file (errors if file already exists; pass --force to overwrite)
 *
 *   crux tb sync-scaffold widgets --tier=2
 *     → adds tier-appropriate optional fields (entityRefFields, toThing, toVerdict, ...)
 *       Default: tier 2. Tier 1 adds auditRecordType + claimSupport. Tier 3 minimal.
 */

import { existsSync, writeFileSync } from "node:fs";
import type { CommandOptions as BaseOptions, CommandResult } from "../lib/command-types.ts";

interface CommandOptions extends BaseOptions {
  "table-name"?: string;
  output?: string;
  force?: boolean;
  tier?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert kebab-case or snake_case to camelCase. */
function camelCase(name: string): string {
  return name.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
}

/** Convert kebab-case to PascalCase for type identifiers. */
function pascalCase(name: string): string {
  const camel = camelCase(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

interface ScaffoldOptions {
  routeName: string; // kebab-case, e.g. "widgets" or "political-scores"
  tableName: string; // Drizzle camelCase identifier, e.g. "widgets"
  tier: 1 | 2 | 3;
}

function renderTemplate(opts: ScaffoldOptions): string {
  const { routeName, tableName, tier } = opts;
  const PascalName = pascalCase(routeName);
  const camelName = camelCase(routeName);

  // Tier 1: full features (audit + claims + verdicts + things + FK resolve)
  // Tier 2: standard (FK validation + things + verdicts)
  // Tier 3: minimal (FK validation only)
  const auditField =
    tier === 1
      ? `      auditRecordType: ${JSON.stringify(routeName)},\n`
      : "";
  const claimField =
    tier === 1
      ? `      claimSupport: {
        recordType: ${JSON.stringify(routeName)},
        getClaimIds: (item) => item.claimIds ?? [],
      },\n`
      : "";
  const fkResolveField =
    tier === 1
      ? `      fkResolve: {
        tableName: ${JSON.stringify(routeName.replace(/-/g, "_"))},
        fields: [
          // TODO: list FK columns to resolve, e.g.:
          // { rawIdColumn: "entity_id", entityIdColumn: "entity_stable_id", displayNameColumn: "entity_display_name" },
        ],
      },\n`
      : "";
  const thingsField =
    tier <= 2
      ? `      // Things dual-write — TODO: replace ${camelName}Title with the field that
      // has a human-readable name, and remove if this route doesn't sync to things.
      thingsTitleIds: (items) => [...new Set(items.map((i) => i.entityId))],
      toThing: (item, titleMap) => ({
        id: item.id,
        thingType: ${JSON.stringify(routeName)},
        title: item.${camelName}Title ?? item.id,
        sourceTable: ${JSON.stringify(routeName.replace(/-/g, "_"))},
        sourceId: item.id,
        sourceUrl: item.sourceUrl ?? null,
        parentTitle: titleMap.get(item.entityId) ?? item.entityId,
      }),\n`
      : "";
  const verdictField =
    tier <= 2
      ? `      toVerdict: (item) => ({
        recordType: ${JSON.stringify(routeName)},
        recordId: item.id,
        entityId: item.entityId,
        sourceUrl: item.sourceUrl ?? null,
        sourcing: item.sourcing ?? null,
      }),\n`
      : "";
  const sourcingField =
    tier <= 2 ? "  sourcing: InlineSourcingSchema.optional(),\n" : "";
  const sourcingImport =
    tier <= 2
      ? `import { InlineSourcingSchema } from "./sourcing-schema.js";\n`
      : "";

  return `import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { ${tableName} } from "../../schema.js";
import { zv, clampedLimit, noDuplicateIds } from "../shared/utils.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";
${sourcingImport}
// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const ListQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----
//
// TODO: replace these placeholder fields with the real schema for the
// ${routeName} table. Every field that should be settable by sync clients
// must be listed here.

const SyncItemSchema = z.object({
  id: z.string().length(10),
  // TODO: add fields here
  entityId: z.string().min(1).max(200),
${sourcingField}});

const SyncBatchSchema = z.object({
  items: z
    .array(SyncItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

type SyncItem = z.infer<typeof SyncItemSchema>;

// ---- Helpers ----

function formatRow(r: typeof ${tableName}.$inferSelect) {
  return {
    id: r.id,
    // TODO: add the fields you want exposed by GET /all and /by-entity
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route ----

const ${camelName}App = new Hono()

  // GET /stats
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [row] = await db.select({ total: count() }).from(${tableName});
    return c.json({ total: row.total });
  })

  // GET /all
  .get("/all", zv("query", ListQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(${tableName})
      .orderBy(desc(${tableName}.syncedAt), ${tableName}.id)
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db.select({ total: count() }).from(${tableName});

    return c.json({ ${camelName}: rows.map(formatRow), total, limit, offset });
  })

  // POST /sync — uses sync-factory
  .post(
    "/sync",
    createSyncHandler({
      name: ${JSON.stringify(routeName)},
      table: ${tableName},
      batchSchema: SyncBatchSchema,
      // toRow: maps a validated SyncItem to a row that can be inserted.
      // The factory uses these keys to auto-derive the ON CONFLICT SET clause.
      toRow: (item, now) => ({
        id: item.id,
        // TODO: map the rest of your item fields to row fields
        entityId: item.entityId,
        syncedAt: now,
        updatedAt: now,
      }),
${auditField}${claimField}      // entityRefFields: validates that referenced entities exist before insert.
      entityRefFields: (items) => [
        { fieldName: "entityId", ids: items.map((i) => i.entityId) },
      ],
${fkResolveField}${thingsField}${verdictField}    }),
  )

  .post("/delete-batch", deleteBatchHandler(${tableName}, ${JSON.stringify(routeName.replace(/-/g, "_"))}));

// ---- Exports ----

export const ${camelName}Route = ${camelName}App;
export type ${PascalName}Route = typeof ${camelName}App;
`;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function scaffoldCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const routeName = args.find((a) => !a.startsWith("--"));

  if (!routeName) {
    return {
      exitCode: 1,
      output: `Usage: crux tb sync-scaffold <route-name> [options]

  Emits a starter TableBase sync route file using createSyncHandler.
  Without this command, agents will copy-paste existing 200-line handlers
  instead of using the factory.

Options:
  --table-name=<name>   Drizzle table identifier (default: camelCased route name)
  --output=<path>       Write to file instead of stdout
  --force               Overwrite existing file (use with --output)
  --tier=<1|2|3>        Feature tier (default: 2)
                          1 = full features (audit, claims, FK resolve, things, verdicts)
                          2 = standard (FK validation + things + verdicts)
                          3 = minimal (FK validation only)

Examples:
  crux tb sync-scaffold widgets
  crux tb sync-scaffold widgets --table-name=widgets --tier=2
  crux tb sync-scaffold widgets --output=apps/wiki-server/src/routes/tablebase/widgets.ts`,
    };
  }

  // Validate route name format (kebab-case)
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(routeName)) {
    return {
      exitCode: 1,
      output: `Error: route name must be kebab-case (lowercase, hyphens only). Got: ${routeName}`,
    };
  }

  const tableName = options["table-name"] ?? camelCase(routeName);
  const tierRaw = options.tier ?? "2";
  const tierNum = Number(tierRaw);
  if (![1, 2, 3].includes(tierNum)) {
    return {
      exitCode: 1,
      output: `Error: --tier must be 1, 2, or 3. Got: ${tierRaw}`,
    };
  }
  const tier = tierNum as 1 | 2 | 3;

  const content = renderTemplate({ routeName, tableName, tier });

  if (options.output) {
    if (existsSync(options.output) && !options.force) {
      return {
        exitCode: 1,
        output: `Error: ${options.output} already exists. Use --force to overwrite.`,
      };
    }
    writeFileSync(options.output, content);
    return {
      exitCode: 0,
      output: `Wrote ${content.split("\n").length} lines to ${options.output}

Next steps:
  1. Replace TODO placeholders in the schema (item shape + row mapping)
  2. Add the route to apps/wiki-server/src/routes/tablebase/index.ts
  3. Mount the route in apps/wiki-server/src/app.ts
  4. Add a test in apps/wiki-server/src/__tests__/${routeName}.test.ts
  5. Run \`pnpm crux w validate gate\` to verify it compiles`,
    };
  }

  return { exitCode: 0, output: content };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands = {
  default: scaffoldCommand,
  scaffold: scaffoldCommand,
};
