/**
 * Lightweight client-side error reporter.
 *
 * Sends errors to /api/client-errors which proxies to wiki-server's
 * monitoring/incidents endpoint. Uses navigator.sendBeacon (fire-and-forget,
 * never throws) with fetch fallback.
 *
 * Rate limits: max 5 reports per page load, 1 per unique message.
 * Phase 5 of Discussion #3768.
 */

const MAX_REPORTS_PER_PAGE = 5;
const reported = new Set<string>();
let reportCount = 0;

interface ErrorPayload {
  message: string;
  stack?: string;
  url: string;
  source: "error-boundary" | "window-onerror" | "unhandled-rejection";
  userAgent: string;
  timestamp: string;
}

export function reportClientError(
  message: string,
  opts: { stack?: string; source: ErrorPayload["source"] },
): void {
  try {
    // Rate limit
    if (reportCount >= MAX_REPORTS_PER_PAGE) return;
    // Deduplicate by message
    const key = `${opts.source}:${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    reportCount++;

    const payload: ErrorPayload = {
      message: message.slice(0, 1000),
      stack: opts.stack?.slice(0, 2000),
      url: (() => {
        try { const u = new URL(window.location.href); u.search = ""; return u.toString(); }
        catch { return window.location.pathname; }
      })(),
      source: opts.source,
      userAgent: navigator.userAgent.slice(0, 200),
      timestamp: new Date().toISOString(),
    };

    const body = JSON.stringify(payload);

    // sendBeacon is fire-and-forget and works during page unload
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/client-errors",
        new Blob([body], { type: "application/json" }),
      );
    } else {
      // Fallback for older browsers
      fetch("/api/client-errors", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
      }).catch((e: unknown) => {
        // Intentionally quiet: client error reporting is best-effort.
        void e;
      });
    }
  } catch {
    // Intentionally silent — reporter must never crash the page
  }
}
