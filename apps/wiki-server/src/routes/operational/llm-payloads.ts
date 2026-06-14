/**
 * LLM Call Payloads API (model-swap eval, step 1b).
 *
 * Captures sampled LLM request/response bodies so we can later replay the same
 * prompts through candidate models and compare quality against the Anthropic
 * baseline.
 *
 *   - POST /   — record one captured call
 *   - GET  /   — list captured calls (filter by flow / model) for replay
 *
 * Hand-rolled (not factory-mounted): the surface is small and write-only from
 * the pipeline side, so it doesn't fit the `/sync` batch-upsert contract.
 */

import { Hono } from "hono";
import { eq, desc, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDrizzleDb } from "../../db.js";
import { llmCallPayloads } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  firstOrThrow,
  clampedLimit,
  zv,
} from "../shared/utils.js";
import { RecordLlmPayloadSchema } from "../../api-types.js";

const ListPayloadsQuery = z.object({
  flow: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  limit: clampedLimit(500, 100),
});

const llmPayloadsApp = new Hono()
  // ---- POST / (record a captured call) ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = RecordLlmPayloadSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    const inserted = await db.transaction(async (tx) => {
      // High-volume capture rows — skip the universal audit trigger so we
      // don't write one audit_log row per sampled LLM call (same rationale as
      // pipeline-run heartbeats).
      await tx.execute(sql`SET LOCAL app.audit_skip = 'true'`);
      return tx
        .insert(llmCallPayloads)
        .values({
          runId: d.runId ?? null,
          flow: d.flow ?? null,
          label: d.label ?? null,
          model: d.model,
          viaOpenrouter: d.viaOpenrouter ?? false,
          request: d.request,
          response: d.response,
          tokensInput: d.tokensInput ?? null,
          tokensOutput: d.tokensOutput ?? null,
        })
        .returning({ id: llmCallPayloads.id });
    });

    return c.json(firstOrThrow(inserted, "llm payload insert"), 201);
  })

  // ---- GET / (list captured calls for replay) ----
  .get("/", zv("query", ListPayloadsQuery), async (c) => {
    const { flow, model, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [
      flow ? eq(llmCallPayloads.flow, flow) : undefined,
      model ? eq(llmCallPayloads.model, model) : undefined,
    ].filter((x): x is NonNullable<typeof x> => x !== undefined);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(llmCallPayloads)
      .where(where)
      .orderBy(desc(llmCallPayloads.createdAt))
      .limit(limit);

    return c.json({ payloads: rows, count: rows.length });
  });

export const llmPayloadsRoute = llmPayloadsApp;
export type LlmPayloadsRoute = typeof llmPayloadsApp;
