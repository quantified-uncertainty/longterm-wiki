/**
 * Wiki-server client — Data Quality Snapshots
 *
 * Uses Hono RPC inferred types from the server route.
 */

import { type hc, type InferResponseType } from "hono/client";
import type { DataQualityRoute } from "../../../apps/wiki-server/src/routes/operational/data-quality.js";
import { apiRequest } from "./client.ts";

// ---------------------------------------------------------------------------
// RPC-inferred types
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<DataQualityRoute>>;

/** Shape returned by POST /api/data-quality */
export type CaptureSnapshotResult = InferResponseType<RpcClient["index"]["$post"], 200>;

/** Shape returned by GET /api/data-quality/history */
export type SnapshotHistoryResult = InferResponseType<RpcClient["history"]["$get"], 200>;

/** Shape returned by GET /api/data-quality/latest */
export type SnapshotLatestResult = InferResponseType<RpcClient["latest"]["$get"], 200>;

/** A single snapshot row */
export type DataQualitySnapshot = NonNullable<SnapshotLatestResult["snapshot"]>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Capture a new data quality snapshot by triggering server-side aggregation. */
export async function captureSnapshot() {
  return apiRequest<CaptureSnapshotResult>("POST", "/api/data-quality");
}

/** Fetch snapshot history with pagination. */
export async function getSnapshotHistory(options?: { limit?: number; offset?: number }) {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  const qs = params.toString();
  return apiRequest<SnapshotHistoryResult>("GET", `/api/data-quality/history${qs ? `?${qs}` : ""}`);
}

/** Fetch the most recent snapshot. */
export async function getLatestSnapshot() {
  return apiRequest<SnapshotLatestResult>("GET", "/api/data-quality/latest");
}
