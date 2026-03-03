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
    case "exactly":
      return "";
    default:
      return `${key} `;
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
