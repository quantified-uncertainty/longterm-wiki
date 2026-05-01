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
  type ValidationErrorBody,
} from "../shared/utils.js";
import {
  validateEntityRefs,
  findMissingEntityRefs,
  shouldSkipEntityValidation,
  type EntityRefField,
} from "../shared/validate-entity-refs.js";
import {
  enforceSourcing,
  resolveSourcingRequirement,
  logSourcingSkipped,
} from "../shared/sourcing-enforcement.js";
import {
  validateClaimRefs,
  classifyClaims,
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
   * logging). In best-effort mode (QUA-955) the callback is invoked once
   * over the full batch and then once per item to attribute missing FKs back
   * to their owning item — at most N+1 invocations per request. A callback
   * with side effects will surface them N+1 times in best-effort mode.
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

  // ---- Best-effort partial-success mode (QUA-955) ----

  /**
   * Allow callers to request best-effort partial-success semantics by passing
   * `?mode=best_effort` on the request.
   *
   * **Default `false`** — most routes should remain atomic (any per-item
   * validation failure rejects the whole batch with 400).
   *
   * When `true` AND the request includes `?mode=best_effort`, the factory:
   *   - Runs per-item validation, partitioning into committed / rejected lists
   *   - Upserts only the items that survived validation
   *   - Returns HTTP 200 with `{ committed: [...ids], rejected: [{idx, code, message, ...}] }`
   *     instead of the standard atomic 400-on-first-failure
   *
   * **Server-side guard:** `?mode=best_effort` is silently ignored on routes
   * that don't opt in via this flag — they always run in atomic mode. This
   * prevents a future contributor from flipping a default and silently
   * re-introducing the QUA-941 silent-stakeholder-drop regression on a route
   * that wasn't designed for partial-success.
   *
   * **Per-item partitioning is supported for these phases**: Zod schema
   * (requires `syncSchema`), `enforceSourcing`, `naturalKey`, `entityRefs` /
   * `entityRefFields`, and `claimSupport`. The `preValidate` hook is treated
   * as atomic — if it returns a Response, that Response is returned as-is.
   *
   * No production caller wires this in QUA-955. Phase 2 opts in
   * `policy-stakeholders` for the canary.
   */
  bestEffortAllowed?: boolean;
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

/**
 * One rejected item in a best-effort response (QUA-955). `idx` is the
 * position in the original `items` array — callers can use it to map
 * rejections back to their input.
 *
 * `code` and the optional context fields mirror `ValidationErrorBody` so a
 * caller can distinguish causes structurally without string-matching the
 * `message`.
 */
export interface BestEffortRejected extends ValidationErrorBody {
  idx: number;
}

/**
 * Response shape returned when `bestEffortAllowed: true` AND the request
 * includes `?mode=best_effort`. Distinct from `SyncResponse` — callers should
 * branch on the request flag, not on response shape.
 */
export interface BestEffortSyncResponse {
  /**
   * IDs of items that passed all validation and were upserted. One entry per
   * surviving item; the factory throws a SyncPhaseError if any surviving
   * item lacks a string `id` field (composite-PK routes are not yet
   * supported by best-effort mode).
   */
  committed: string[];
  /** Items that failed pre-upsert validation. Order matches reject-time order. */
  rejected: BestEffortRejected[];
  /** Verdicts written for committed items (mirrors atomic response). */
  verdictsWritten: number;
  /** Claim links created for committed items (mirrors atomic response). */
  claimsLinked: number;
  /** Present only if claim linking failed post-tx (records still committed). */
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

    // ---- QUA-955: best-effort gate ----
    // Best-effort partial-success mode is opt-in per route via `bestEffortAllowed`
    // AND opt-in per request via `?mode=best_effort`. The query param is silently
    // ignored on routes that don't opt in (server-side guard).
    const bestEffort =
      config.bestEffortAllowed === true && c.req.query("mode") === "best_effort";
    const rejected: BestEffortRejected[] = [];

    // ---- Phase 2: validate (schema) ----
    // In best-effort mode with `syncSchema`, we per-item validate so a single
    // malformed item doesn't reject the whole batch. Otherwise, fall through
    // to atomic batch-level validation (existing behavior).
    let items: TItem[];
    let originalIndices: number[]; // maps items[i] back to its position in the request
    if (bestEffort && config.syncSchema) {
      // Permissive envelope so the per-item Zod errors are the partition signal.
      const envelope = z.object({ items: z.array(z.unknown()).min(1).max(500) });
      const envParsed = await runPhase(name, "validate", async () =>
        envelope.safeParse(body),
      );
      if (!envParsed.success) {
        return validationError(c, envParsed.error.message);
      }
      const rawItems = envParsed.data.items;
      const accepted: TItem[] = [];
      const indices: number[] = [];
      for (let idx = 0; idx < rawItems.length; idx++) {
        const r = config.syncSchema.safeParse(rawItems[idx]);
        if (!r.success) {
          rejected.push({
            idx,
            code: "zod",
            message: r.error.message,
          });
        } else {
          accepted.push(r.data as TItem);
          indices.push(idx);
        }
      }
      items = accepted;
      originalIndices = indices;
    } else {
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
        return validationError(c, parsed.error.message);
      }
      items = parsed.data.items as TItem[];
      originalIndices = items.map((_, i) => i);
    }

    /**
     * Drop items at the given local positions (within the current `items` array)
     * and emit one rejection per dropped item with the supplied code/message.
     * `originalIndices` is updated in lockstep so subsequent rejections still
     * refer to the original request position.
     */
    const dropAndReject = (
      drop: Set<number>,
      build: (localIdx: number) => Omit<BestEffortRejected, "idx">,
    ): void => {
      const keptItems: TItem[] = [];
      const keptIndices: number[] = [];
      for (let i = 0; i < items.length; i++) {
        if (drop.has(i)) {
          rejected.push({ idx: originalIndices[i], ...build(i) });
        } else {
          keptItems.push(items[i]);
          keptIndices.push(originalIndices[i]);
        }
      }
      items = keptItems;
      originalIndices = keptIndices;
    };

    // ---- Phase 2: enforceSourcing ----
    if (config.enforceSourcing) {
      const tableName =
        typeof config.enforceSourcing === "string"
          ? config.enforceSourcing
          : name;
      if (bestEffort) {
        // Partition: items missing sourcing get rejected, the rest survive.
        // The `?forceSkipSourcing=true` escape hatch must still emit its audit
        // warning here — otherwise best-effort callers can bypass enforcement
        // silently, defeating the compliance contract.
        await runPhase(name, "enforceSourcing", async () => {
          const req = resolveSourcingRequirement(c, tableName);
          if (req.kind === "skipped") {
            logSourcingSkipped(tableName, items.length, req);
            return;
          }
          if (req.kind === "required") {
            const drop = new Set<number>();
            for (let i = 0; i < items.length; i++) {
              if (!(items[i] as { sourcing?: unknown }).sourcing) drop.add(i);
            }
            if (drop.size > 0) {
              dropAndReject(drop, () => ({
                code: "sourcing_required",
                message:
                  `Source-check required (${req.source}) but record lacks sourcing data. ` +
                  `Run \`pnpm crux tb verify-orchestrate ${tableName}\` to populate ` +
                  `source_check_verdicts before submitting.`,
                field: "sourcing",
              }));
            }
          }
        });
      } else {
        const err = await runPhase(name, "enforceSourcing", async () =>
          enforceSourcing(c, tableName, items as Array<{ sourcing?: unknown }>),
        );
        if (err) return err;
      }
    }

    // ---- Phase 2: natural key collision ----
    if (config.naturalKey) {
      if (bestEffort) {
        // Partition: keep first occurrence, reject duplicates.
        const seen = new Set<string>();
        const drop = new Set<number>();
        const dropKeys = new Map<number, string>();
        for (let i = 0; i < items.length; i++) {
          const key = config.naturalKey(items[i]);
          if (seen.has(key)) {
            drop.add(i);
            dropKeys.set(i, key);
          } else {
            seen.add(key);
          }
        }
        if (drop.size > 0) {
          dropAndReject(drop, (i) => ({
            code: "natural_key",
            message:
              `${config.naturalKeyError ?? "Duplicate natural key in batch"}: ${dropKeys.get(i)}`,
            value: dropKeys.get(i),
          }));
        }
      } else {
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
      if (bestEffort) {
        // Partition: items with missing FKs get rejected, the rest survive.
        // The `?skipEntityValidation=true` bypass still applies (handled inside
        // shouldSkipEntityValidation, called below).
        if (!shouldSkipEntityValidation(c)) {
          await runPhase(name, "validateEntityRefs", async () => {
            const fields = entityRefFieldsFn(items);
            const missing = await findMissingEntityRefs(db, fields);
            if (missing.length === 0) return;
            // Build a per-field set of missing IDs for fast per-item lookup.
            const missingByField = new Map<string, Set<string>>();
            for (const m of missing) {
              missingByField.set(m.fieldName, new Set(m.missingIds));
            }
            // We need to know which item owns each missing ID. The full
            // callback form lets users compute IDs (e.g. prefix transforms),
            // not just read fields, so we can't shortcut via
            // `item[fieldName]` — that would silently misclassify ID-mapping
            // callbacks. Instead, invoke the callback with each `[item]`
            // singleton; this is the only contract-safe partition strategy.
            const drop = new Set<number>();
            const dropDetails = new Map<number, { fieldName: string; id: string }>();
            for (let i = 0; i < items.length; i++) {
              const itemFields = entityRefFieldsFn([items[i]]);
              for (const f of itemFields) {
                const missingSet = missingByField.get(f.fieldName);
                if (!missingSet) continue;
                const badId = f.ids.find((id) => missingSet.has(id));
                if (badId) {
                  drop.add(i);
                  dropDetails.set(i, { fieldName: f.fieldName, id: badId });
                  break;
                }
              }
            }
            if (drop.size > 0) {
              dropAndReject(drop, (i) => {
                const detail = dropDetails.get(i)!;
                return {
                  code: "fk_missing",
                  message: `Entity reference not found: ${detail.fieldName}=${detail.id}`,
                  field: detail.fieldName,
                  value: detail.id,
                };
              });
            }
          });
        }
      } else {
        const fields = entityRefFieldsFn(items);
        const refError = await runPhase(name, "validateEntityRefs", async () =>
          validateEntityRefs(c, db, fields),
        );
        if (refError) return refError;
      }
    }

    // ---- Phase 2: validateClaimRefs ----
    let allClaimIds: number[] = [];
    if (config.claimSupport) {
      const getClaimIds = config.claimSupport.getClaimIds;
      allClaimIds = items.flatMap((i) => getClaimIds(i) ?? []);
      if (allClaimIds.length > 0) {
        const rawDb = getDb();
        if (bestEffort) {
          // Partition: items citing missing/non-verified claims get rejected.
          await runPhase(name, "validateClaimRefs", async () => {
            const status = await classifyClaims(rawDb, allClaimIds);
            if (status.missing.length === 0 && status.nonVerified.length === 0) {
              return;
            }
            const missingSet = new Set(status.missing);
            const nonVerifiedMap = new Map(
              status.nonVerified.map((r) => [r.id, r.status]),
            );
            const drop = new Set<number>();
            const dropDetails = new Map<
              number,
              { claimId: number; reason: string }
            >();
            for (let i = 0; i < items.length; i++) {
              const ids = getClaimIds(items[i]) ?? [];
              for (const cid of ids) {
                if (missingSet.has(cid)) {
                  drop.add(i);
                  dropDetails.set(i, { claimId: cid, reason: "missing" });
                  break;
                }
                const nonVerifiedStatus = nonVerifiedMap.get(cid);
                if (nonVerifiedStatus) {
                  drop.add(i);
                  dropDetails.set(i, {
                    claimId: cid,
                    reason: `not verified (status: ${nonVerifiedStatus})`,
                  });
                  break;
                }
              }
            }
            if (drop.size > 0) {
              dropAndReject(drop, (i) => {
                const d = dropDetails.get(i)!;
                return {
                  code: "claim_invalid",
                  message: `Claim ${d.claimId} ${d.reason}`,
                  field: "claimIds",
                  value: d.claimId,
                };
              });
            }
          });
          // Recompute allClaimIds against the surviving set so post-tx linking
          // doesn't try to link claims for rejected records.
          allClaimIds = items.flatMap((i) => getClaimIds(i) ?? []);
        } else {
          const claimError = await runPhase(name, "validateClaimRefs", async () =>
            validateClaimRefs(rawDb, allClaimIds),
          );
          if (claimError) return validationError(c, claimError);
        }
      }
    }

    // ---- Phase 2: preValidate hook ----
    // Treated as atomic in both modes — the hook is opaque to the factory.
    // If a route needs per-item preValidate behavior in best-effort mode, the
    // hook itself can short-circuit only on items it wants to reject and
    // return null otherwise. We don't try to partition arbitrary user code.
    if (config.preValidate) {
      const preErr = await runPhase(name, "preValidate", async () =>
        config.preValidate!(c, db, items),
      );
      if (preErr) return preErr;
    }

    // If best-effort partitioning ate everything, skip the transaction
    // entirely. Going through the chunk loop with `allVals = []` produces a
    // 0-column-count → degenerate chunkSize, and some Drizzle versions throw
    // on `tx.insert(table).values([])` / `inArray(idCol, [])`. Returning early
    // avoids that whole class of edge-case behavior on the empty input we
    // already know we have nothing to do with.
    if (bestEffort && items.length === 0) {
      const emptyResponse: BestEffortSyncResponse = {
        committed: [],
        rejected,
        verdictsWritten: 0,
        claimsLinked: 0,
      };
      return c.json(emptyResponse);
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

    if (bestEffort) {
      // Build the committed-IDs list. The contract is `committed: string[]` —
      // one entry per surviving item. If an item has no string `id`, we throw
      // rather than silently truncate (that would produce a response shape
      // that disagrees with itself: claimsLinked covers all items, committed
      // is shorter). Fail loudly so a future composite-PK route opting in
      // hits this in dev, not in prod.
      const committed: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const id = (items[i] as { id?: unknown }).id;
        if (typeof id !== "string") {
          throw new SyncPhaseError(
            name,
            "upsert",
            new Error(
              `bestEffortAllowed routes must produce items with a string 'id' field; ` +
                `surviving item at index ${i} (original idx ${originalIndices[i]}) has id=${typeof id}. ` +
                `Composite-PK routes are not yet supported in best-effort mode.`,
            ),
          );
        }
        committed.push(id);
      }
      const beResponse: BestEffortSyncResponse = {
        committed,
        rejected,
        verdictsWritten: verdictsResult.written,
        claimsLinked,
        ...(claimLinkingError ? { claimLinkingError } : {}),
      };
      return c.json(beResponse);
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
