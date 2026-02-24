/**
 * oRPC Contract — Facts Module
 *
 * Contract-first definitions for all facts endpoints.
 * Reuses canonical Zod schemas from api-types.ts where possible
 * and defines output schemas for type-safe responses.
 */

import { oc } from "@orpc/contract";
import { z } from "zod";
import { SyncFactSchema } from "../api-types.js";

// ---------------------------------------------------------------------------
// Constants (shared with REST route)
// ---------------------------------------------------------------------------

const MAX_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Shared output schemas — the single source of truth for response shapes
// ---------------------------------------------------------------------------

export const FactRowSchema = z.object({
  id: z.number(),
  entityId: z.string(),
  factId: z.string(),
  label: z.string().nullable(),
  value: z.string().nullable(),
  numeric: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
  asOf: z.string().nullable(),
  measure: z.string().nullable(),
  subject: z.string().nullable(),
  note: z.string().nullable(),
  source: z.string().nullable(),
  sourceResource: z.string().nullable(),
  format: z.string().nullable(),
  formatDivisor: z.number().nullable(),
  syncedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const StaleFactRowSchema = z.object({
  entityId: z.string(),
  factId: z.string(),
  label: z.string().nullable(),
  asOf: z.string().nullable(),
  measure: z.string().nullable(),
  value: z.string().nullable(),
  numeric: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// Contract definitions
// ---------------------------------------------------------------------------

const byEntity = oc
  .input(
    z.object({
      entityId: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      measure: z.string().max(100).optional(),
    })
  )
  .output(
    z.object({
      entityId: z.string(),
      facts: z.array(FactRowSchema),
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
    })
  );

const timeseries = oc
  .input(
    z.object({
      entityId: z.string().min(1),
      measure: z.string().min(1).max(100),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    })
  )
  .output(
    z.object({
      entityId: z.string(),
      measure: z.string(),
      points: z.array(FactRowSchema),
      total: z.number(),
    })
  );

const stale = oc
  .input(
    z.object({
      olderThan: z.string().max(20).optional(),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    })
  )
  .output(
    z.object({
      facts: z.array(StaleFactRowSchema),
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
    })
  );

const list = oc
  .input(
    z.object({
      limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    })
  )
  .output(
    z.object({
      facts: z.array(FactRowSchema),
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
    })
  );

const stats = oc.output(
  z.object({
    total: z.number(),
    uniqueEntities: z.number(),
    uniqueMeasures: z.number(),
  })
);

const sync = oc
  .input(
    z.object({
      facts: z.array(SyncFactSchema).min(1).max(500),
    })
  )
  .output(
    z.object({
      upserted: z.number(),
    })
  );

// ---------------------------------------------------------------------------
// Router contract
// ---------------------------------------------------------------------------

export const factsContract = {
  byEntity,
  timeseries,
  stale,
  list,
  stats,
  sync,
};
