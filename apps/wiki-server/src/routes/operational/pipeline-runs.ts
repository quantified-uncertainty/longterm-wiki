/**
 * Pipeline Runs API (QUA-954, parent QUA-943).
 *
 * Three-endpoint surface for the `withPipelineRun` lifecycle helper:
 *   - POST   /          — start a run
 *   - PATCH  /:id/heartbeat — bump heartbeat_at while running
 *   - PATCH  /:id/end   — set status / ended_at / error_* / followup_actions
 *
 * Plus two read endpoints for the /internal/pipeline-runs dashboard:
 *   - GET    /          — list runs (filter by status, pipeline_name)
 *   - GET    /stats     — aggregate by status + pipeline_name (last 24h)
 *
 * Hand-rolled (not factory-mounted) — the surface is small and the write
 * shape doesn't fit the `/sync` factory's "batch upsert + things sync"
 * contract.
 */

import { Hono } from "hono";
import { eq, desc, and, sql, gte } from "drizzle-orm";
import { z } from "zod";
import { getDrizzleDb } from "../../db.js";
import { pipelineRuns } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
  clampedLimit,
  notFoundError,
  zv,
} from "../shared/utils.js";
import {
  StartPipelineRunSchema,
  EndPipelineRunSchema,
  PipelineRunStatusSchema,
} from "../../api-types.js";

const ListRunsQuery = z.object({
  status: PipelineRunStatusSchema.optional(),
  pipelineName: z.string().min(1).max(200).optional(),
  limit: clampedLimit(500, 100),
});

const pipelineRunsApp = new Hono()
  // ---- POST / (start a run) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = StartPipelineRunSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    // Caller-minted run_id: if they collide they get 409, not a corrupt
    // overwrite. Pipelines should always mint a unique id (nanoid/uuid)
    // so this is a defensive guard, not a happy-path branch.
    const existing = await db
      .select({ runId: pipelineRuns.runId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.runId, d.runId))
      .limit(1);
    if (existing.length > 0) {
      return c.json(
        { error: "conflict", message: `Pipeline run already exists: ${d.runId}` },
        409,
      );
    }

    const inserted = await db
      .insert(pipelineRuns)
      .values({
        runId: d.runId,
        pipelineName: d.pipelineName,
        agentSessionId: d.agentSessionId ?? null,
        entityId: d.entityId ?? null,
        shape: d.shape ?? null,
        status: "running",
      })
      .returning();

    return c.json(firstOrThrow(inserted, "pipeline run insert"), 201);
  })

  // ---- GET / (list runs) ----
  .get("/", zv("query", ListRunsQuery), async (c) => {
    const { status, pipelineName, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [
      status ? eq(pipelineRuns.status, status) : undefined,
      pipelineName ? eq(pipelineRuns.pipelineName, pipelineName) : undefined,
    ].filter((x): x is NonNullable<typeof x> => x !== undefined);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(where)
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(limit);

    return c.json({ runs: rows, total: rows.length });
  })

  // ---- GET /stats (aggregate by status + pipeline) ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const byStatusRows = await db
      .select({
        status: pipelineRuns.status,
        count: sql<number>`count(*)::int`,
      })
      .from(pipelineRuns)
      .where(gte(pipelineRuns.startedAt, since))
      .groupBy(pipelineRuns.status);

    const byPipelineRows = await db
      .select({
        pipelineName: pipelineRuns.pipelineName,
        status: pipelineRuns.status,
        count: sql<number>`count(*)::int`,
      })
      .from(pipelineRuns)
      .where(gte(pipelineRuns.startedAt, since))
      .groupBy(pipelineRuns.pipelineName, pipelineRuns.status);

    const byFailureReasonRows = await db
      .select({
        failureReason: pipelineRuns.failureReason,
        count: sql<number>`count(*)::int`,
      })
      .from(pipelineRuns)
      .where(
        and(
          gte(pipelineRuns.startedAt, since),
          sql`${pipelineRuns.failureReason} IS NOT NULL`,
        ),
      )
      .groupBy(pipelineRuns.failureReason);

    return c.json({
      since: since.toISOString(),
      byStatus: byStatusRows,
      byPipeline: byPipelineRows,
      byFailureReason: byFailureReasonRows,
    });
  })

  // ---- GET /:id (drilldown) ----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return validationError(c, "Missing run id");

    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.runId, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `No pipeline run with id: ${id}`);
    }

    return c.json(rows[0]);
  })

  // ---- PATCH /:id/heartbeat (bump heartbeat_at) ----
  //
  // Audit-skipped per QUA-954 red-team finding #1: a 30-min run produces
  // ~60 heartbeats × 1 audit row each = ~60 rows of audit log per run.
  // Multiplied by ~700 entities/night that would be ~42K spurious audit
  // rows daily. Heartbeats are not durable history — start, end, and
  // status changes still write to the audit log. See
  // `.claude/rules/audit-log.md` § "Bulk backfills — skip the universal
  // audit trigger" for the same mechanism on bulk migrations.
  .patch("/:id/heartbeat", async (c) => {
    const id = c.req.param("id");
    if (!id) return validationError(c, "Missing run id");

    const db = getDrizzleDb();
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      // SET LOCAL is scoped to the transaction so it never leaks into
      // other writes on this pooled connection.
      await tx.execute(sql`SET LOCAL app.audit_skip = 'true'`);
      return tx
        .update(pipelineRuns)
        .set({ heartbeatAt: now, updatedAt: now })
        .where(
          and(
            eq(pipelineRuns.runId, id),
            // Defensive: only bump heartbeat for running rows. A late
            // heartbeat after `end` shouldn't reanimate a finished run.
            eq(pipelineRuns.status, "running"),
          ),
        )
        .returning({ runId: pipelineRuns.runId, heartbeatAt: pipelineRuns.heartbeatAt });
    });

    if (updated.length === 0) {
      return notFoundError(c, `No running pipeline run with id: ${id}`);
    }

    return c.json({ ok: true, runId: id, heartbeatAt: updated[0].heartbeatAt });
  })

  // ---- PATCH /:id/end (mark run finished) ----
  .patch("/:id/end", async (c) => {
    const id = c.req.param("id");
    if (!id) return validationError(c, "Missing run id");

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = EndPipelineRunSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();
    const now = new Date();

    const updated = await db
      .update(pipelineRuns)
      .set({
        status: d.status,
        endedAt: now,
        updatedAt: now,
        failureReason: d.failureReason ?? null,
        errorCode: d.errorCode ?? null,
        errorPayload: d.errorPayload ?? null,
        snapshotPath: d.snapshotPath ?? null,
        // Only overwrite followup_actions when the caller passed them
        // explicitly; otherwise preserve whatever was set in flight
        // (default '[]' from insert).
        ...(d.followupActions !== undefined
          ? { followupActions: d.followupActions }
          : {}),
      })
      .where(eq(pipelineRuns.runId, id))
      .returning();

    if (updated.length === 0) {
      return notFoundError(c, `No pipeline run with id: ${id}`);
    }

    return c.json(updated[0]);
  });

export const pipelineRunsRoute = pipelineRunsApp;
export type PipelineRunsRoute = typeof pipelineRunsApp;
