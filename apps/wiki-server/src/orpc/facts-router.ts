/**
 * oRPC Router — Facts Module
 *
 * Implements the facts contract using the shared query service.
 * Both REST and oRPC layers share the same underlying query functions.
 */

import { implement } from "@orpc/server";
import { factsContract } from "./facts-contract.js";
import {
  queryByEntity,
  queryTimeseries,
  queryStale,
  queryList,
  queryStats,
  syncFacts,
} from "../services/facts-queries.js";

// ---------------------------------------------------------------------------
// Implement contract
// ---------------------------------------------------------------------------

const os = implement(factsContract);

const byEntity = os.byEntity.handler(async ({ input }) => {
  return queryByEntity(input);
});

const timeseries = os.timeseries.handler(async ({ input }) => {
  return queryTimeseries(input);
});

const stale = os.stale.handler(async ({ input }) => {
  return queryStale(input);
});

const list = os.list.handler(async ({ input }) => {
  return queryList(input);
});

const statsHandler = os.stats.handler(async () => {
  return queryStats();
});

const sync = os.sync.handler(async ({ input }) => {
  return syncFacts(input.facts);
});

// ---------------------------------------------------------------------------
// Assembled router
// ---------------------------------------------------------------------------

export const factsRouter = os.router({
  byEntity,
  timeseries,
  stale,
  list,
  stats: statsHandler,
  sync,
});

export type FactsRouter = typeof factsRouter;
