import { NextResponse } from "next/server";
import { getStrictFailStats, getTypedEntities } from "@/data/tablebase";

/**
 * GET /api/internal/strict-fail-stats
 *
 * Returns a counter of TypedEntitySchema.safeParse fall-throughs in
 * getTypedEntities(). See QUA-953 (Phase 0b of QUA-943): we need a
 * prod-visible signal of how often the strict per-type schemas miss
 * entities, before Phase 6 can delete GenericEntityPassthroughSchema.
 *
 * The counter is process-local and is populated on the first call to
 * getTypedEntities(). This handler triggers that population if it has
 * not happened yet, so the endpoint is meaningful even on a cold process.
 */
export const dynamic = "force-dynamic";

export function GET() {
  // Force population if this process hasn't loaded entities yet.
  getTypedEntities();
  return NextResponse.json(getStrictFailStats());
}
