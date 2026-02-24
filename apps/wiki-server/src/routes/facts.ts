import { Hono } from "hono";
import { z } from "zod";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "./utils.js";
import { SyncFactsBatchSchema } from "../api-types.js";
import {
  MAX_PAGE_SIZE,
  queryByEntity,
  queryTimeseries,
  queryStale,
  queryList,
  queryStats,
  syncFacts,
} from "../services/facts-queries.js";

export const factsRoute = new Hono();

// ---- Schemas (query-string validation) ----

const ByEntityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  measure: z.string().max(100).optional(),
});

const TimeseriesQuery = z.object({
  measure: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const StalenessQuery = z.object({
  olderThan: z.string().max(20).optional(), // e.g. "2025-01" — facts with asOf before this
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- GET /stats ----

factsRoute.get("/stats", async (c) => {
  return c.json(await queryStats());
});

// ---- GET /list ----

factsRoute.get("/list", async (c) => {
  const parsed = ListQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);
  return c.json(await queryList(parsed.data));
});

// ---- GET /stale ----

factsRoute.get("/stale", async (c) => {
  const parsed = StalenessQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);
  return c.json(await queryStale(parsed.data));
});

// ---- GET /timeseries/:entityId ----

factsRoute.get("/timeseries/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
  if (!entityId) return validationError(c, "Entity ID is required");

  const parsed = TimeseriesQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  return c.json(
    await queryTimeseries({
      entityId,
      measure: parsed.data.measure,
      limit: parsed.data.limit,
    })
  );
});

// ---- GET /by-entity/:entityId ----

factsRoute.get("/by-entity/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
  if (!entityId) return validationError(c, "Entity ID is required");

  const parsed = ByEntityQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  return c.json(
    await queryByEntity({
      entityId,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      measure: parsed.data.measure,
    })
  );
});

// ---- POST /sync ----

factsRoute.post("/sync", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SyncFactsBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  return c.json(await syncFacts(parsed.data.facts));
});
