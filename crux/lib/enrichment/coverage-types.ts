/**
 * Shape of a row returned by `GET /api/enrichment/coverage`. Lives in its own
 * file so test fixtures + the watchdog + the reopener all share one type.
 */
export interface CoverageGap {
  entityId: string;
  recordType: string;
  estimatedTotal: number;
  targetPct: number;
  targetAcceptedCount: number;
  actualAcceptedCount: number;
  gapCount: number;
  gapPct: number;
  meetsTarget: boolean;
}
