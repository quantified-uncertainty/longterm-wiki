/**
 * In-memory incident buffer for the groundskeeper.
 *
 * When the wiki-server is down, incident data cannot be POSTed. This module
 * buffers incidents locally and flushes them once the server recovers. It also
 * tracks outage windows so that a single backfill incident (with detectedAt /
 * resolvedAt) can be created on recovery.
 */

import type { Config } from "./config.js";
import { recordIncident } from "./wiki-server.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ module: "incident-buffer" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BufferedIncident {
  service: string;
  severity: string;
  title: string;
  detail?: string;
  checkSource?: string;
  metadata?: Record<string, unknown>;
  /** ISO timestamp of when this incident was originally detected. */
  timestamp: string;
}

export interface OutageWindow {
  /** ISO timestamp of the first failure in the current streak. */
  detectedAt: string;
  /** Number of consecutive health-check failures (mirrors scheduler state). */
  consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Buffer state (module-level singleton — one per process)
// ---------------------------------------------------------------------------

const MAX_BUFFER_SIZE = 100;

let incidentBuffer: BufferedIncident[] = [];
let currentOutage: OutageWindow | null = null;

// ---------------------------------------------------------------------------
// Outage tracking
// ---------------------------------------------------------------------------

/**
 * Call when a health-check failure occurs. Records the start of an outage
 * window if one is not already in progress.
 */
export function recordFailure(): void {
  if (!currentOutage) {
    currentOutage = {
      detectedAt: new Date().toISOString(),
      consecutiveFailures: 1,
    };
    logger.info(
      { detectedAt: currentOutage.detectedAt },
      "Outage window started"
    );
  } else {
    currentOutage.consecutiveFailures++;
  }
}

/**
 * Returns the current outage window, or null if no outage is in progress.
 */
export function getCurrentOutage(): OutageWindow | null {
  return currentOutage;
}

/**
 * Clear the outage window (called after recovery handling is complete).
 */
export function clearOutage(): void {
  currentOutage = null;
}

// ---------------------------------------------------------------------------
// Incident buffer
// ---------------------------------------------------------------------------

/**
 * Add an incident to the in-memory buffer. Drops oldest entries when the
 * buffer exceeds MAX_BUFFER_SIZE.
 */
export function addToBuffer(incident: BufferedIncident): void {
  incidentBuffer.push(incident);
  if (incidentBuffer.length > MAX_BUFFER_SIZE) {
    const dropped = incidentBuffer.length - MAX_BUFFER_SIZE;
    incidentBuffer = incidentBuffer.slice(-MAX_BUFFER_SIZE);
    logger.warn(
      { dropped, bufferSize: incidentBuffer.length },
      "Buffer overflow — dropped oldest entries"
    );
  }
}

/**
 * Returns the current buffer size.
 */
export function getBufferSize(): number {
  return incidentBuffer.length;
}

/**
 * Returns a snapshot of the current buffer (for testing).
 */
export function getBufferSnapshot(): readonly BufferedIncident[] {
  return [...incidentBuffer];
}

/**
 * Flush all buffered incidents to the wiki-server. Best-effort: incidents
 * that fail to POST are logged and discarded (the server is presumably back
 * up, so transient failures here are unlikely to recur).
 *
 * Returns the number of incidents successfully flushed.
 */
export async function flushBuffer(config: Config): Promise<number> {
  if (incidentBuffer.length === 0) return 0;

  const toFlush = [...incidentBuffer];
  incidentBuffer = [];

  let flushed = 0;
  for (const incident of toFlush) {
    const ok = await recordIncident(config, {
      service: incident.service,
      severity: incident.severity,
      title: incident.title,
      detail: incident.detail,
      checkSource: incident.checkSource,
      metadata: {
        ...incident.metadata,
        buffered: true,
        originalTimestamp: incident.timestamp,
      },
    });
    if (ok) {
      flushed++;
    } else {
      logger.error(
        { title: incident.title, timestamp: incident.timestamp },
        "Failed to flush buffered incident — discarding"
      );
    }
  }

  logger.info(
    { flushed, total: toFlush.length },
    "Buffer flush complete"
  );
  return flushed;
}

/**
 * Backfill an incident record for a completed outage window. Called on
 * recovery when the wiki-server is available again.
 */
export async function backfillOutageIncident(
  config: Config,
  outage: OutageWindow
): Promise<void> {
  const resolvedAt = new Date().toISOString();

  const ok = await recordIncident(config, {
    service: "wiki-server",
    severity: "critical",
    title: "Wiki server outage (backfilled on recovery)",
    detail: [
      `Server was unreachable from ${outage.detectedAt} to ${resolvedAt}.`,
      `Total consecutive failures: ${outage.consecutiveFailures}.`,
      `This incident was recorded retroactively after recovery.`,
    ].join(" "),
    checkSource: "groundskeeper",
    metadata: {
      backfilled: true,
      detectedAt: outage.detectedAt,
      resolvedAt,
      consecutiveFailures: outage.consecutiveFailures,
    },
  });
  if (ok) {
    logger.info(
      { detectedAt: outage.detectedAt, resolvedAt },
      "Outage incident backfilled successfully"
    );
  } else {
    logger.error(
      { detectedAt: outage.detectedAt, resolvedAt },
      "Failed to backfill outage incident"
    );
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Reset all module state. Only intended for use in tests.
 */
export function _resetForTesting(): void {
  incidentBuffer = [];
  currentOutage = null;
}
