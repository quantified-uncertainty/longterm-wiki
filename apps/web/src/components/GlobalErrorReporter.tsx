"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error-reporter";

/**
 * Attaches global window.onerror and onunhandledrejection handlers
 * to catch errors that React error boundaries miss (e.g., errors in
 * event handlers, async code outside components, third-party scripts).
 *
 * Renders nothing — purely a side-effect component.
 */
export function GlobalErrorReporter() {
  useEffect(() => {
    function onError(event: ErrorEvent) {
      reportClientError(event.message || "Uncaught error", {
        stack: event.error?.stack,
        source: "window-onerror",
      });
    }

    function onUnhandledRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "Unhandled promise rejection";
      reportClientError(message, {
        stack: reason instanceof Error ? reason.stack : undefined,
        source: "unhandled-rejection",
      });
    }

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
