"use client";

import * as React from "react";
import { Loader2, AlertTriangle, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Canonical empty / loading / error states for data tables.
 *
 * Two flavors:
 *  - `*Row` components — render inside an existing `<tbody>`. They own a `<tr>` + `<td colSpan={N}>`.
 *  - `*Block` components — render outside a table (Suspense fallbacks, "no data" pages, error boundaries).
 *
 * QUA-1008. Anything new outside this module is caught by `crux/validate/validate-table-states.ts`.
 */

// ── Constants ────────────────────────────────────────────────────────────

export const DEFAULT_LOADING_LABEL = "Loading…";
export const DEFAULT_EMPTY_LABEL = "No results.";
export const DEFAULT_ERROR_LABEL = "Failed to load data.";

// Skeleton geometry — pseudo-random row widths via integer indices
// so SSR and client hydration produce identical markup.
const SKELETON_MIN_WIDTH_PCT = 40;
const SKELETON_WIDTH_RANGE_PCT = 50;
const SKELETON_ROW_MULT = 13;
const SKELETON_COL_MULT = 7;

// ── Row variants (render inside <tbody>) ─────────────────────────────────

interface TableRowStateProps {
  colSpan: number;
  className?: string;
}

export function TableLoadingRow({
  colSpan,
  label = DEFAULT_LOADING_LABEL,
  className,
}: TableRowStateProps & { label?: string }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        aria-busy="true"
        className={cn(
          "py-8 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>{label}</span>
        </span>
      </td>
    </tr>
  );
}

export function TableEmptyRow({
  colSpan,
  message = DEFAULT_EMPTY_LABEL,
  className,
}: TableRowStateProps & { message?: string }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className={cn(
          "py-8 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        {message}
      </td>
    </tr>
  );
}

export function TableErrorRow({
  colSpan,
  error,
  className,
}: TableRowStateProps & { error: string | Error }) {
  // Only render caller-supplied non-empty strings verbatim. `Error` instances
  // collapse to the canonical fallback to avoid surfacing internal details
  // (transport stacks, schema names, etc.) to end-users from a generic primitive.
  const message =
    typeof error === "string" && error.trim()
      ? error
      : DEFAULT_ERROR_LABEL;
  return (
    <tr>
      <td
        colSpan={colSpan}
        role="alert"
        className={cn("py-8 text-center text-sm", className)}
      >
        <span className="inline-flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <span>{message}</span>
        </span>
      </td>
    </tr>
  );
}

// ── Block variants (render outside a table) ──────────────────────────────

interface TableBlockStateProps {
  className?: string;
}

/**
 * Skeleton block for Suspense fallbacks. Renders a stripped-down table-like
 * scaffold so the SSR HTML has structure visible to crawlers and screen readers
 * (QUA-916).
 */
export function TableSkeleton({
  rows = 6,
  columns = 4,
  label = DEFAULT_LOADING_LABEL,
  className,
}: TableBlockStateProps & { rows?: number; columns?: number; label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("space-y-3", className)}
    >
      <span className="sr-only">{label}</span>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <table className="w-full text-sm" aria-hidden="true">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              {Array.from({ length: columns }).map((_, i) => (
                <th key={i} scope="col" className="px-4 py-2.5">
                  <div className="h-3 w-24 animate-pulse rounded bg-muted-foreground/20" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {Array.from({ length: rows }).map((_, r) => (
              <tr key={r}>
                {Array.from({ length: columns }).map((_, c) => (
                  <td key={c} className="px-4 py-3">
                    <div
                      className="h-3 animate-pulse rounded bg-muted-foreground/15"
                      style={{
                        width: `${
                          SKELETON_MIN_WIDTH_PCT +
                          ((r * SKELETON_ROW_MULT + c * SKELETON_COL_MULT) %
                            SKELETON_WIDTH_RANGE_PCT)
                        }%`,
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TableEmptyBlock({
  title = DEFAULT_EMPTY_LABEL,
  description,
  action,
  className,
}: TableBlockStateProps & {
  title?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 px-6 py-12 text-center",
        className,
      )}
    >
      <Inbox
        className="mx-auto mb-3 h-6 w-6 text-muted-foreground/60"
        aria-hidden="true"
      />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function TableErrorBlock({
  error,
  retry,
  className,
}: TableBlockStateProps & {
  error: string | Error;
  retry?: () => void;
}) {
  // Only render caller-supplied non-empty strings verbatim. See TableErrorRow.
  const message =
    typeof error === "string" && error.trim()
      ? error
      : DEFAULT_ERROR_LABEL;
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border border-destructive/40 bg-destructive/5 px-6 py-8 text-center",
        className,
      )}
    >
      <AlertTriangle
        className="mx-auto mb-2 h-6 w-6 text-destructive"
        aria-hidden="true"
      />
      <p className="text-sm font-medium text-destructive">{message}</p>
      {retry && (
        <button
          type="button"
          onClick={retry}
          className="mt-3 rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
        >
          Retry
        </button>
      )}
    </div>
  );
}
