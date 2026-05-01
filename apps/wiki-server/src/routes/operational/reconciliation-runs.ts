/**
 * reconciliation_runs route — heartbeat record for the daily PG-vs-YAML
 * reconciliation cron (QUA-958, parent QUA-943).
 *
 * Three endpoints:
 *   POST /start    — open a new run row (returns runId)
 *   POST /complete — close it with diff counts + details
 *   GET  /summary  — current state for the health-gate sentinel
 *   GET  /list     — recent runs for the dashboard
 *
 * The heartbeat-on-broken-cron problem (QUA-31): zero Linear comments is
 * ambiguous between "0 diffs" and "cron is broken". `/summary` returns
 * `lastRunAt` so the health-gate evaluator can detect the broken case.
 */

import { Hono } from "hono";
import { z } from "zod";
import { and, eq, desc, sql, gte } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { reconciliationRuns } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";

const VALID_TRIGGERS = ["scheduled", "manual"] as const;
const VALID_DOMAINS = ["policy_stakeholders"] as const;

// ---- Schemas ----

const StartSchema = z.object({
  domain: z.enum(VALID_DOMAINS),
  trigger: z.enum(VALID_TRIGGERS),
  startedAt: z.string().datetime().optional(),
});

const CompleteSchema = z.object({
  id: z.number().int().positive(),
  entitiesScanned: z.number().int().min(0),
  entitiesNonEmpty: z.number().int().min(0),
  diffsDetected: z.number().int().min(0),
  nonEmptyDiffsObserved: z.number().int().min(0),
  detailsJson: z.record(z.unknown()).optional(),
  errorCode: z.string().max(200).nullable().optional(),
  errorMessage: z.string().max(5000).nullable().optional(),
});

const ListQuery = z.object({
  domain: z.enum(VALID_DOMAINS).optional(),
  limit: clampedLimit(200, 50),
});

const SummaryQuery = z.object({
  domain: z.enum(VALID_DOMAINS).default("policy_stakeholders"),
  /** Rolling window in days for `nonEmptyDiffsObservedTotal`. Default 30. */
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
});

// ---- Route ----

const reconciliationRunsApp = new Hono()

  // POST /start — open a new run row
  .post("/start", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);
    const parsed = StartSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();
    const startedAt = d.startedAt ? new Date(d.startedAt) : new Date();

    const [row] = await db
      .insert(reconciliationRuns)
      .values({
        domain: d.domain,
        trigger: d.trigger,
        startedAt,
      })
      .returning({
        id: reconciliationRuns.id,
        domain: reconciliationRuns.domain,
        startedAt: reconciliationRuns.startedAt,
      });

    return c.json({ id: row.id, domain: row.domain, startedAt: row.startedAt });
  })

  // POST /complete — close the run with diff counts
  .post("/complete", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);
    const parsed = CompleteSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    const [row] = await db
      .update(reconciliationRuns)
      .set({
        completedAt: new Date(),
        entitiesScanned: d.entitiesScanned,
        entitiesNonEmpty: d.entitiesNonEmpty,
        diffsDetected: d.diffsDetected,
        nonEmptyDiffsObserved: d.nonEmptyDiffsObserved,
        detailsJson: d.detailsJson ?? null,
        errorCode: d.errorCode ?? null,
        errorMessage: d.errorMessage ?? null,
      })
      .where(eq(reconciliationRuns.id, d.id))
      .returning({
        id: reconciliationRuns.id,
        completedAt: reconciliationRuns.completedAt,
        diffsDetected: reconciliationRuns.diffsDetected,
        nonEmptyDiffsObserved: reconciliationRuns.nonEmptyDiffsObserved,
      });

    if (!row) {
      return c.json({ error: "not_found", message: `run ${d.id} not found` }, 404);
    }

    return c.json(row);
  })

  // GET /summary — health-gate sentinel + Phase 4 precondition
  .get("/summary", zv("query", SummaryQuery), async (c) => {
    const { domain, windowDays } = c.req.valid("query");
    const db = getDrizzleDb();

    // Latest completed run for this domain — drives "is the cron alive?" + "is
    // there divergence right now?".
    const [latest] = await db
      .select()
      .from(reconciliationRuns)
      .where(
        and(
          eq(reconciliationRuns.domain, domain),
          sql`${reconciliationRuns.completedAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(reconciliationRuns.startedAt))
      .limit(1);

    // Rolling-window count of non-empty diffs observed across runs. Phase 4
    // (QUA-960) cutover is gated on >=10. Includes failed runs zeroed-out so
    // a broken cron doesn't accidentally trip the precondition.
    const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const [windowRollup] = await db
      .select({
        runs: sql<number>`count(*)::int`,
        nonEmptyDiffsObservedTotal: sql<number>`coalesce(sum(${reconciliationRuns.nonEmptyDiffsObserved}), 0)::int`,
        runsWithNonEmptyDiff: sql<number>`count(*) FILTER (WHERE ${reconciliationRuns.nonEmptyDiffsObserved} > 0)::int`,
      })
      .from(reconciliationRuns)
      .where(
        and(
          eq(reconciliationRuns.domain, domain),
          gte(reconciliationRuns.startedAt, windowStart),
          sql`${reconciliationRuns.completedAt} IS NOT NULL`,
          sql`${reconciliationRuns.errorCode} IS NULL`,
        ),
      );

    return c.json({
      domain,
      latestRun: latest
        ? {
            id: latest.id,
            startedAt: latest.startedAt,
            completedAt: latest.completedAt,
            entitiesScanned: latest.entitiesScanned,
            entitiesNonEmpty: latest.entitiesNonEmpty,
            diffsDetected: latest.diffsDetected,
            nonEmptyDiffsObserved: latest.nonEmptyDiffsObserved,
            errorCode: latest.errorCode,
          }
        : null,
      window: {
        days: windowDays,
        runs: windowRollup?.runs ?? 0,
        nonEmptyDiffsObservedTotal: windowRollup?.nonEmptyDiffsObservedTotal ?? 0,
        runsWithNonEmptyDiff: windowRollup?.runsWithNonEmptyDiff ?? 0,
      },
    });
  })

  // GET /list — dashboard listing
  .get("/list", zv("query", ListQuery), async (c) => {
    const { domain, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(reconciliationRuns)
      .where(domain ? eq(reconciliationRuns.domain, domain) : undefined)
      .orderBy(desc(reconciliationRuns.startedAt))
      .limit(limit);

    return c.json({ runs: rows });
  });

export const reconciliationRunsRoute = reconciliationRunsApp;
export type ReconciliationRunsRoute = typeof reconciliationRunsApp;
