/**
 * Display utilities for the Statements system.
 *
 * Provides value formatting (using UNIT_FORMATS), variety badges,
 * and range display for statement values.
 */

import { formatWithUnitFormat } from "./unit-formats";

// ---- Types (local — actual types come from RPC inference) ----

interface StatementLike {
  valueNumeric: number | null;
  valueText: string | null;
  valueDate: string | null;
  valueEntityId: string | null;
  valueSeries: Record<string, unknown> | null;
  qualifierKey: string | null;
}

interface PropertyLike {
  unitFormatId: string | null;
  valueType: string;
}

// ---- Value formatting ----

/**
 * Format a statement's value for display, using the property's unitFormatId.
 *
 * Priority: valueNumeric (formatted) → valueText → valueDate → valueEntityId → "—"
 */
export function formatStatementValue(
  statement: StatementLike,
  property: PropertyLike | null | undefined
): string {
  const qualifier = formatQualifier(statement.qualifierKey);

  if (statement.valueNumeric != null) {
    const formatted = formatWithUnitFormat(
      statement.valueNumeric,
      property?.unitFormatId
    );
    return `${qualifier}${formatted}`;
  }

  if (statement.valueText != null) {
    return `${qualifier}${statement.valueText}`;
  }

  if (statement.valueDate != null) {
    return `${qualifier}${statement.valueDate}`;
  }

  if (statement.valueEntityId != null) {
    return statement.valueEntityId;
  }

  // valueSeries: show range if present
  if (statement.valueSeries != null) {
    return formatRange(statement.valueSeries);
  }

  return "—";
}

/**
 * Format a qualifier key (e.g. "at-least" → "≥ ", "around" → "~").
 * Only known prefix-style qualifiers produce output. All others (context
 * qualifiers like "per-share-tender", "round:series-a") are suppressed
 * since they're shown as parenthetical labels in the Property column.
 */
function formatQualifier(key: string | null): string {
  if (!key) return "";
  switch (key) {
    case "at-least":
      return "≥ ";
    case "at-most":
      return "≤ ";
    case "around":
      return "~ ";
    default:
      // All other qualifiers are context metadata, not value prefixes.
      // They're displayed in the Property column as "(qualifier)" instead.
      return "";
  }
}

/**
 * Format a valueSeries object as a range string.
 * Expects { low: number, high: number } shape.
 */
export function formatRange(
  series: Record<string, unknown> | null
): string {
  if (!series) return "—";
  const low = series.low;
  const high = series.high;
  if (typeof low === "number" && typeof high === "number") {
    return `${low.toLocaleString("en-US")}–${high.toLocaleString("en-US")}`;
  }
  // Fallback: stringify
  return JSON.stringify(series);
}

// ---- Variety badges ----

export interface VarietyBadge {
  label: string;
  className: string;
}

/**
 * Get display label and color class for a statement variety.
 */
export function getVarietyBadge(variety: string): VarietyBadge {
  switch (variety) {
    case "structured":
      return {
        label: "Structured",
        className:
          "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
      };
    case "attributed":
      return {
        label: "Attributed",
        className:
          "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
      };
    default:
      return {
        label: variety,
        className:
          "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300",
      };
  }
}

// ---- Period formatting ----

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format a YYYY-MM or YYYY-MM-DD date string as human-readable (e.g. "Mar 2026").
 * Falls back to the raw string if parsing fails.
 */
function formatDateHuman(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!match) return date;
  const year = match[1];
  const monthIdx = parseInt(match[2], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return date;
  return `${MONTH_NAMES[monthIdx]} ${year}`;
}

/**
 * Format a statement's validity period for display.
 * Uses human-readable dates like "Mar 2026" instead of "2026-03".
 */
export function formatPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return "—";
  if (start && !end) return `since ${formatDateHuman(start)}`;
  if (!start && end) return `until ${formatDateHuman(end)}`;
  return `${formatDateHuman(start!)} → ${formatDateHuman(end!)}`;
}

// ---- Status badges ----

export interface StatusBadge {
  label: string;
  className: string;
}

/**
 * Get display label and color class for a statement status.
 */
export function getStatusBadge(status: string): StatusBadge {
  switch (status) {
    case "active":
      return {
        label: "Active",
        className:
          "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
      };
    case "superseded":
      return {
        label: "Superseded",
        className:
          "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400",
      };
    case "retracted":
      return {
        label: "Retracted",
        className:
          "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
      };
    default:
      return {
        label: status,
        className:
          "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300",
      };
  }
}
