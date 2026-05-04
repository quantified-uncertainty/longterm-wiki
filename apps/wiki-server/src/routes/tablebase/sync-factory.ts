/**
 * `createSyncHandler<TItem, TTable>()` — Factory for TableBase POST /sync handlers.
 *
 * Implements the 7-phase pipeline shared by all TableBase sync routes:
 *   1. Parse JSON body
 *   2. Validate (Zod schema, natural key, sourcing, entity FK, claims, custom preValidate)
 *   3. Upsert (batch INSERT...ON CONFLICT, auto-chunked for Postgres param limit)
 *   4. Audit log (single batch insert per chunk; existing-row pre-fetch in batch)
 *   5. Entity FK resolve (post-upsert backfill via resolveEntityFKs)
 *   6. Things dual-write (pointer-only upsertThingsInTx, QUA-507)
 *   7. Verdicts + claim linking (writeInlineVerdicts in tx; linkClaimsToRecords post-tx)
 *
 * Each phase is gated by config presence — a route that doesn't need a feature
 * simply omits the relevant config field. The factory returns a plain Hono
 * handler function `(c: Context) => Promise<Response>`, preserving Hono RPC
 * type inference (verified by sync-factory.test-d.ts).
 *
 * Per the Phase 0 audit (issue #4089):
 *   - Auto-chunks based on Postgres parameter limit (60000 / columnCount)
 *   - Hooks (preValidate, postUpsert) receive `tx`; throwing rolls back the entire sync
 *   - SET clause is auto-derived from toRow's output keys + getTableColumns(table)
 *   - Errors are wrapped in SyncPhaseError({ route, phase, cause }) for stack-trace context
 *
 * See discussion #4088 for the full design rationale.
 */

import type { Context } from "hono";
import { z } from "zod";
import { sql, inArray, getTableColumns } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema.js";
import { getDrizzleDb, getDb } from "../../db.js";
import { logger } from "../../logger.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zodErrorToValidationBody,
} from "../shared/utils.js";
import {
  validateEntityRefs,
  type EntityRefField,
} from "../shared/validate-entity-refs.js";
import { enforceSourcing } from "../shared/sourcing-enforcement.js";
import {
  validateClaimRefs,
  linkClaimsToRecords,
} from "../shared/validate-claims.js";
import {
  resolveEntityFKs,
  type ResolveEntityFKsOptions,
} from "../shared/resolve-entity-fks.js";
import {
  upsertThingsInTx,
  type ThingSyncInput,
} from "../shared/thing-sync.js";
import { logAuditEntries } from "./audit-log.js";
import { applyAuditContext } from "../../middleware/audit-context.js";
import {
  writeInlineVerdicts,
  logSourcingCoverage,
} from "./write-inline-verdicts.js";
import type { InlineSourcing } from "./sourcing-schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

type Db = PostgresJsDatabase<typeof schema>;

type RawDb = ReturnType<typeof getDb>;

/** A record-shaped object the factory will write to the table. */
type Row = Record<string, unknown>;

/** Inline sourcing verdict input shape (matches writeInlineVerdicts). */
export interface VerdictInput {
  recordType: string;
  recordId: string;
  entityId?: string | null;
  sourceUrl?: string | null;
  sourcing?: InlineSourcing | null;
}

/**
 * SyncConfig — declarative configuration for a TableBase sync handler.
 *
 * The minimum required fields are: name, table, and ONE of:
 *   - `batchSchema` (full batch schema outputting `{ items: TItem[] }`)
 *   - `syncSchema` (per-item schema; factory wraps in `{ items: [...] }`)
 *
 * `toRow` is optional — if omitted, the factory treats each validated item
 * as a row directly, applying `?? null` for nullable columns and adding
 * `syncedAt`/`updatedAt` from `getTableColumns(table)`.
 *
 * @typeParam TItem - The validated item shape (inferred from batchSchema).
 * @typeParam TTable - The Drizzle table type.
 */
export interface SyncConfig<TItem, TTable extends PgTable> {
  // ---- Required ----

  /** Human-readable route name; appears in logs and error messages. */
  name: string;

  /** Drizzle table the factory writes to. */
  table: TTable;

  /**
   * Zod schema for the batch body. Any schema that outputs `{ items: TItem[] }`
   * is accepted — including schemas wrapped in `.refine()` (which become
   * `ZodEffects`) and schemas with extra batch-level fields.
   *
   * The factory validates against this and unwraps `parsed.data.items`.
   *
   * Mutually exclusive with `syncSchema` — provide one or the other.
   */
  batchSchema?: z.ZodType<{ items: TItem[] }>;

  /**
   * Per-item Zod schema. The factory wraps it in `z.object({ items: z.array(schema).min(1).max(500) })`
   * automatically. Use this instead of `batchSchema` for the common case where
   * the batch body is simply `{ items: [...] }` with no batch-level refinements.
   *
   * Mutually exclusive with `batchSchema` — provide one or the other.
   */
  syncSchema?: z.ZodType<TItem>;

  /**
   * Map a validated item to a row that can be inserted into `table`.
   * The `now` parameter is a single Date passed to all items in the batch
   * so all rows have identical syncedAt/updatedAt values.
   *
   * **Optional.** If omitted, the factory treats each item as the row directly,
   * applying `?? null` for nullable columns and adding `syncedAt: now` and
   * `updatedAt: now` if those columns exist on the table. This works for routes
   * where the Zod schema's field names match the Drizzle table's JS column names
   * (the common case for simple routes).
   *
   * Provide `toRow` when you need custom coercion (e.g., `String(item.amount)`
   * for NUMERIC columns, `parseRange()` for range fields, or computed columns).
   */
  toRow?: (item: TItem, now: Date) => Row;

  // ---- Conflict resolution ----

  /**
   * Conflict target column(s) for ON CONFLICT. Default: `table.id`.
   * Pass an array for composite primary keys.
   */
  conflictTarget?: PgColumn | PgColumn[];

  /**
   * Override the auto-derived SET clause. Use for routes that need COALESCE
   * preservation (preserve existing values when new value is null) or other
   * non-default merge semantics.
   *
   * If omitted, the factory auto-derives the SET clause from `toRow`'s output
   * keys + `getTableColumns(table)`. Standard fields (id, createdAt) are
   * skipped; syncedAt and updatedAt are set to `now()`.
   */
  conflictSet?: Record<string, SQL>;

  // ---- Pre-upsert validation (each gated by presence) ----

  /**
   * Compute a string key for intra-batch duplicate detection. The factory
   * builds a Set of these keys and returns 400 on collision. Used to catch
   * malformed batches before they hit the unique constraint.
   */
  naturalKey?: (item: TItem) => string;

  /**
   * Human-readable error message prefix when natural key collision is found.
   * Default: `Duplicate natural key in batch`.
   */
  naturalKeyError?: string;

  /**
   * Source-check enforcement. Set to `true` to enforce based on the route name
   * (looked up in sourcing-enforcement.ts SOURCE_CHECK_REQUIRED). Pass a
   * string to override the table name used for the lookup.
   */
  enforceSourcing?: boolean | string;

  /**
   * Entity FK fields to validate pre-insert. Returns one EntityRefField per
   * FK field. Each field's IDs are batch-checked against the entities table.
   *
   * **Contract**: callbacks MUST be pure (no side effects, no DB calls, no
   * logging). The factory may invoke them more than once per request.
   */
  entityRefFields?: (items: TItem[]) => EntityRefField[];

  /**
   * Shorthand for `entityRefFields`: just list the field names as strings.
   * The factory will auto-build the EntityRefField array by extracting IDs
   * from `item[fieldName]`, filtering out null/undefined values.
   *
   * Example: `entityRefs: ["politicianEntityId", "scorerEntityId"]`
   *
   * Use the full `entityRefFields` callback when you need custom filtering
   * or when the field name in the item doesn't match the error message.
   * If both `entityRefs` and `entityRefFields` are provided, `entityRefFields` wins.
   */
  entityRefs?: string[];

  /**
   * Custom pre-validation hook. Runs AFTER schema validation and entity ref
   * validation, BEFORE the transaction begins. Return a Response to short-circuit
   * (factory returns it), or null to proceed.
   *
   * Use for custom FK validation against non-entities tables (e.g., grants
   * checking programIds against funding_programs).
   *
   * Hook contract: external side effects forbidden. Throwing returns a 500.
   */
  preValidate?: (c: Context, db: Db, items: TItem[]) => Promise<Response | null>;

  // ---- Audit log ----

  /**
   * Record type for audit log entries (e.g., "grants", "personnel"). Setting
   * this enables audit logging: the factory pre-fetches existing rows in a
   * single batch query before each upsert chunk, then writes audit entries
   * with operation = "insert" | "update".
   */
  auditRecordType?: string;

  /**
   * Optional accessor for the source URL on each audit entry. Default: null.
   */
  auditSourceUrl?: (item: TItem) => string | null;

  // ---- Things sync (pointer-only index) ----

  /**
   * Map an item to a `things` table row. Setting this enables things sync:
   * the factory calls `upsertThingsInTx` with the returned pointer-only rows.
   *
   * QUA-507: post denorm-column drop, `ThingSyncInput` contains only pointer
   * fields (`id`, `thingType`, `sourceTable`, `sourceId`, optional
   * `parentThingId` / `entityType` / `sourceUrl` / `wikiId`). Display fields
   * are resolved at read time from the `things_search` MV.
   */
  toThing?: (item: TItem) => ThingSyncInput;

  // ---- Entity FK resolution (post-upsert backfill) ----

  /**
   * Configuration for `resolveEntityFKs()`. Setting this enables FK resolution:
   * after the upsert, the factory backfills entity stableIds and display names
   * for the rows that were just inserted/updated.
   */
  fkResolve?: Omit<ResolveEntityFKsOptions, "scopeIds">;

  /**
   * Function to extract the row IDs to scope FK resolution to. Default:
   * `items.map(i => (i as any).id)` if items have an `id` property.
   */
  fkResolveScopeIds?: (items: TItem[]) => string[];

  // ---- Inline verdicts ----

  /**
   * Map an item to a verdict record for `writeInlineVerdicts()`. Setting this
   * enables inline sourcing verdict writing within the same transaction.
   */
  toVerdict?: (item: TItem) => VerdictInput;

  // ---- Claim linking ----

  /**
   * Claim validation + linking. Setting this enables:
   *   - Pre-tx: validateClaimRefs (rejects unknown or non-verified claims)
   *   - Post-tx: linkClaimsToRecords (creates claim_record_links rows)
   *
   * `recordType` is the value used in claim_record_links.record_type.
   * `getClaimIds` returns the claimIds for an item (or [] if none).
   */
  claimSupport?: {
    recordType: string;
    getClaimIds: (item: TItem) => number[];
  };

  // ---- Post-upsert hook ----

  /**
   * Custom post-upsert hook. Runs INSIDE the transaction, AFTER all standard
   * phases (audit, FK resolve, things, verdicts). Use for routes with unique
   * post-processing like personnel.ts's `new:` prefix display-name backfill.
   *
   * Hook contract: receives the same `tx` handle, must only do DB work on it,
   * external side effects forbidden, throwing rolls back the entire sync.
   */
  postUpsert?: (tx: Tx, items: TItem[], rows: Row[]) => Promise<void>;
}

/**
 * Standard response shape returned by factory-built sync handlers. Routes
 * that need additional fields can use a postUpsert hook + custom response,
 * but should keep this baseline.
 */
export interface SyncResponse {
  upserted: number;
  verdictsWritten: number;
  claimsLinked: number;
  claimLinkingError?: string;
}

// ---------------------------------------------------------------------------
// SyncPhaseError — wraps errors with route + phase context for stack traces
// ---------------------------------------------------------------------------

export type SyncPhase =
  | "parse"
  | "validate"
  | "naturalKey"
  | "enforceSourcing"
  | "validateEntityRefs"
  | "validateClaimRefs"
  | "preValidate"
  | "upsert"
  | "audit"
  | "fkResolve"
  | "things"
  | "verdicts"
  | "postUpsert"
  | "linkClaims";

export class SyncPhaseError extends Error {
  constructor(
    public readonly route: string,
    public readonly phase: SyncPhase,
    cause: unknown,
  ) {
    const message =
      cause instanceof Error ? cause.message : String(cause);
    super(`[${route}/${phase}] ${message}`);
    this.name = "SyncPhaseError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Auto-derive ON CONFLICT SET clause from toRow keys + table columns
// ---------------------------------------------------------------------------

/**
 * Auto-derive the SET clause for ON CONFLICT DO UPDATE.
 *
 * For each key in `sampleRow` (the output of `toRow`), look up the
 * corresponding column on the table and emit `excluded.<column_name>`.
 *
 * Skipped keys: `id`, `createdAt` (PK + immutable timestamp).
 * Replaced keys: `syncedAt`, `updatedAt` → `now()`.
 *
 * If a key is in `sampleRow` but not on the table, it's silently skipped.
 * (This shouldn't happen if `toRow` returns valid row shapes.)
 */
function deriveConflictSet<TTable extends PgTable>(
  table: TTable,
  sampleRow: Row,
): Record<string, SQL> {
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  const setClause: Record<string, SQL> = {};

  for (const jsKey of Object.keys(sampleRow)) {
    if (jsKey === "id" || jsKey === "createdAt") continue;
    if (jsKey === "syncedAt" || jsKey === "updatedAt") {
      setClause[jsKey] = sql`now()`;
      continue;
    }
    const col = cols[jsKey];
    if (!col) continue;
    // sql.raw is safe here: col.name comes from the schema definition
    // (developer-controlled), not user input.
    setClause[jsKey] = sql.raw(`excluded.${col.name}`);
  }

  return setClause;
}

// ---------------------------------------------------------------------------
// Compute chunk size based on Postgres parameter limit
// ---------------------------------------------------------------------------

/**
 * Compute the maximum number of rows per chunk based on the Postgres
 * parameter limit (65535) and the column count of the row shape.
 *
 * We use 60000 instead of 65535 to leave headroom for the SET clause's
 * `excluded.*` references and any other parameters in the query.
 *
 * Verified by Phase 0 audit: even the largest table (campaignFinance, 25
 * cols) has 13× headroom on the default 200-row batch.
 */
function computeChunkSize(columnCount: number): number {
  return Math.max(1, Math.floor(60000 / Math.max(1, columnCount)));
}

// ---------------------------------------------------------------------------
// Wrap a phase in a try/catch that adds route + phase context to errors
// ---------------------------------------------------------------------------

async function runPhase<T>(
  route: string,
  phase: SyncPhase,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SyncPhaseError) throw e;
    throw new SyncPhaseError(route, phase, e);
  }
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/**
 * Build a Hono handler function for a TableBase /sync endpoint.
 *
 * Returns `async (c: Context) => Promise<Response>`. Use it inside a Hono
 * method-chain like:
 *
 *     // Minimal (5 lines — for routes where item shape ≈ row shape):
 *     .post("/sync", createSyncHandler({
 *       name: "political-scores",
 *       table: politicalScores,
 *       syncSchema: SyncItemSchema,
 *       entityRefs: ["politicianEntityId", "scorerEntityId"],
 *     }))
 *
 *     // Full (when custom coercion is needed):
 *     .post("/sync", createSyncHandler({
 *       name: "investments",
 *       table: investments,
 *       batchSchema: SyncBatchSchema,
 *       toRow: (item, now) => ({ ...parseRange(item.amount), syncedAt: now }),
 *       entityRefFields: (items) => [...],
 *     }))
 */
export function createSyncHandler<
  TItem extends Record<string, unknown>,
  TTable extends PgTable,
>(config: SyncConfig<TItem, TTable>) {
  return async (c: Context): Promise<Response> => {
    const { name, table } = config;

    // ---- Phase 1: parse ----
    const body = await runPhase(name, "parse", async () => parseJsonBody(c));
    if (!body) return invalidJsonError(c);

    // ---- Phase 2: validate (schema) ----
    const batchSchema = config.batchSchema ?? (config.syncSchema
      ? z.object({ items: z.array(config.syncSchema).min(1).max(500) }) as z.ZodType<{ items: TItem[] }>
      : null);
    if (!batchSchema) {
      throw new SyncPhaseError(name, "validate", new Error("SyncConfig must provide either batchSchema or syncSchema"));
    }
    const parsed = await runPhase(name, "validate", async () =>
      batchSchema.safeParse(body),
    );
    if (!parsed.success) {
      // QUA-952 (Phase 0a-ii): emit structured `code` so callers can
      // dispatch retry-with-feedback on `enum_violation` vs generic `zod`.
      return validationError(c, zodErrorToValidationBody(parsed.error));
    }
    const items: TItem[] = parsed.data.items as TItem[];

    // ---- Phase 2: enforceSourcing ----
    if (config.enforceSourcing) {
      const tableName =
        typeof config.enforceSourcing === "string"
          ? config.enforceSourcing
          : name;
      const err = await runPhase(name, "enforceSourcing", async () =>
        enforceSourcing(c, tableName, items as Array<{ sourcing?: unknown }>),
      );
      if (err) return err;
    }

    // ---- Phase 2: natural key collision ----
    if (config.naturalKey) {
      const seen = new Set<string>();
      for (const item of items) {
        const key = config.naturalKey(item);
        if (seen.has(key)) {
          return validationError(
            c,
            `${config.naturalKeyError ?? "Duplicate natural key in batch"}: ${key}`,
          );
        }
        seen.add(key);
      }
    }

    const db = getDrizzleDb() as unknown as Db; // as-any-ok: schema generic mismatch between getDrizzleDb's return and Db type alias

    // ---- Phase 2: validateEntityRefs ----
    // Support both callback form (entityRefFields) and shorthand (entityRefs: string[])
    const entityRefFieldsFn = config.entityRefFields ?? (config.entityRefs
      ? (items: TItem[]) => config.entityRefs!.map((fieldName) => ({
          fieldName,
          ids: items
            .map((i) => (i as Record<string, unknown>)[fieldName])
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        }))
      : null);
    if (entityRefFieldsFn) {
      const fields = entityRefFieldsFn(items);
      const refError = await runPhase(name, "validateEntityRefs", async () =>
        validateEntityRefs(c, db, fields),
      );
      if (refError) return refError;
    }

    // ---- Phase 2: validateClaimRefs ----
    let allClaimIds: number[] = [];
    if (config.claimSupport) {
      const getClaimIds = config.claimSupport.getClaimIds;
      allClaimIds = items.flatMap((i) => getClaimIds(i) ?? []);
      if (allClaimIds.length > 0) {
        const rawDb = getDb();
        const claimError = await runPhase(name, "validateClaimRefs", async () =>
          validateClaimRefs(rawDb, allClaimIds),
        );
        if (claimError) return validationError(c, claimError);
      }
    }

    // ---- Phase 2: preValidate hook ----
    if (config.preValidate) {
      const preErr = await runPhase(name, "preValidate", async () =>
        config.preValidate!(c, db, items),
      );
      if (preErr) return preErr;
    }

    // ---- Phase 3-6: transaction ----
    const now = new Date();

    // Resolve toRow: either the provided callback or the default identity mapper.
    // The default mapper copies all item fields, applies ?? null for nullable
    // columns, and adds syncedAt/updatedAt if those columns exist on the table.
    const toRowFn = config.toRow ?? ((item: TItem, _now: Date): Row => {
      const cols = getTableColumns(table) as Record<string, PgColumn>;
      const row: Row = {};
      for (const [key, col] of Object.entries(cols)) {
        if (key === "createdAt") continue; // never set on upsert
        if (key === "syncedAt" || key === "updatedAt") {
          row[key] = _now;
          continue;
        }
        const val = (item as Record<string, unknown>)[key];
        // Apply ?? null for nullable columns when value is undefined
        row[key] = val !== undefined ? val : (col.notNull ? undefined : null);
      }
      return row;
    });

    const allVals = items.map((item) => toRowFn(item, now));
    const columnCount = Object.keys(allVals[0] ?? {}).length;
    const chunkSize = computeChunkSize(columnCount);

    let upserted = 0;
    let verdictsResult = { written: 0 };

    const conflictTarget = config.conflictTarget ?? (table as unknown as { id: PgColumn }).id; // as-any-ok: PgTable generic doesn't expose column names; same pattern as deleteBatchHandler
    const conflictSet =
      config.conflictSet ?? deriveConflictSet(table, allVals[0] ?? {});

    await db.transaction(async (tx) => {
      await applyAuditContext(tx, c);

      // ---- Phase 3: upsert (chunked) + Phase 4: audit ----
      for (let offset = 0; offset < allVals.length; offset += chunkSize) {
        const chunk = allVals.slice(offset, offset + chunkSize);
        const chunkItems = items.slice(offset, offset + chunkSize);

        // Pre-fetch existing rows for audit log (single batch query per chunk)
        let existingMap = new Map<string, Row>();
        if (config.auditRecordType) {
          await runPhase(name, "audit", async () => {
            const ids = chunk
              .map((r) => r.id)
              .filter((id): id is string => typeof id === "string");
            if (ids.length === 0) return;
            const idCol = (table as unknown as { id: PgColumn }).id; // as-any-ok: PgTable generic doesn't expose column names; same pattern as deleteBatchHandler
            const existing = await tx
              .select()
              .from(table as PgTable)
              .where(inArray(idCol, ids));
            existingMap = new Map(
              (existing as Row[]).map((r) => [r.id as string, r]),
            );
          });
        }

        await runPhase(name, "upsert", async () => {
          await tx
            .insert(table as PgTable)
            .values(chunk as Row[])
            .onConflictDoUpdate({
              target: conflictTarget,
              set: conflictSet,
            });
        });

        // Write audit log entries for this chunk
        if (config.auditRecordType) {
          await runPhase(name, "audit", async () => {
            const auditEntries = chunk.map((row, i) => {
              const item = chunkItems[i];
              const id = row.id as string;
              const old = existingMap.get(id);
              return {
                recordType: config.auditRecordType!,
                recordId: id,
                operation: old ? ("update" as const) : ("insert" as const),
                oldData: old ? { ...old } : null,
                newData: { ...row },
                sourceUrl: config.auditSourceUrl
                  ? config.auditSourceUrl(item)
                  : (row.source as string | null) ?? (row.sourceUrl as string | null) ?? null,
              };
            });
            await logAuditEntries(tx, auditEntries);
          });
        }

        upserted += chunk.length;
      }

      // ---- Phase 5: FK resolve (after all chunks upserted) ----
      if (config.fkResolve) {
        await runPhase(name, "fkResolve", async () => {
          const scopeIds = config.fkResolveScopeIds
            ? config.fkResolveScopeIds(items)
            : items
                .map((i) => (i as { id?: string }).id)
                .filter((id): id is string => typeof id === "string");
          await resolveEntityFKs(tx, {
            ...config.fkResolve!,
            scopeIds,
          });
        });
      }

      // ---- Phase 6: things sync (QUA-507: pointer-only) ----
      if (config.toThing) {
        await runPhase(name, "things", async () => {
          const thingsRows = items.map((item) => config.toThing!(item));
          await upsertThingsInTx(tx, thingsRows);
        });
      }

      // ---- Phase 7: verdicts ----
      if (config.toVerdict) {
        await runPhase(name, "verdicts", async () => {
          const verdictRecords = items.map((item) => config.toVerdict!(item));
          verdictsResult = await writeInlineVerdicts(tx, verdictRecords);
        });
      }

      // ---- Custom postUpsert hook ----
      if (config.postUpsert) {
        await runPhase(name, "postUpsert", async () => {
          await config.postUpsert!(tx, items, allVals);
        });
      }
    });

    if (config.toVerdict) {
      logSourcingCoverage(`${name}/sync`, items.length, verdictsResult.written);
    }

    // ---- Post-tx: link verified claims to records ----
    let claimsLinked = 0;
    let claimLinkingError: string | undefined;
    if (config.claimSupport && allClaimIds.length > 0) {
      try {
        const rawDb = getDb();
        const recordType = config.claimSupport.recordType;
        const getClaimIds = config.claimSupport.getClaimIds;
        const linkResult = await linkClaimsToRecords(
          rawDb,
          items.map((item) => ({
            recordId: (item as { id?: string }).id ?? "",
            recordType,
            claimIds: getClaimIds(item),
          })),
        );
        claimsLinked = linkResult.linked;
      } catch (e: unknown) {
        // Claim linking is best-effort: records already committed. Surface
        // the error in the response per #4040 contract, but do not roll back.
        const msg = e instanceof Error ? e.message : String(e);
        claimLinkingError = msg;
        logger.warn(
          { route: name, error: msg },
          "claim linking failed (records already committed)",
        );
      }
    }

    const response: SyncResponse = {
      upserted,
      verdictsWritten: verdictsResult.written,
      claimsLinked,
      ...(claimLinkingError ? { claimLinkingError } : {}),
    };
    return c.json(response);
  };
}
