/**
 * KBCellValue — Shared cell value renderer for KB table components.
 *
 * Used by both KBRecordTable and KBRecordCollection to render type-aware cell values
 * with consistent formatting. Supports refs, URLs, numbers, dates, and booleans.
 */

import type { FieldDef } from "@longterm-wiki/factbase";
import {
  formatKBCellValue,
  formatKBDate,
  formatKBNumber,
  isUrl,
  shortDomain,
} from "./format";
import { KBRefLink } from "./KBRefLink";

/** Fields that store fractions (0-1) representing percentages. */
const FRACTION_FIELDS = new Set(["stake", "stake_acquired", "pledge"]);

function isFractionField(fieldName: string, fieldDef?: FieldDef): boolean {
  if (FRACTION_FIELDS.has(fieldName)) return true;
  // Check description for "fraction" or "0.8 = 80%" hints
  if (fieldDef?.description?.includes("= 80%")) return true;
  return false;
}

function formatPercent(v: number): string {
  const pct = v * 100;
  // Use up to 1 decimal place, drop trailing zero
  return pct % 1 === 0 ? `${pct}%` : `${pct.toFixed(1)}%`;
}

interface KBCellValueProps {
  value: unknown;
  fieldName: string;
  fieldDef?: FieldDef;
}

export function KBCellValue({ value, fieldName, fieldDef }: KBCellValueProps) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">{"\u2014"}</span>;
  }

  const fieldType = fieldDef?.type;

  // Entity references
  if (fieldType === "ref" && typeof value === "string") {
    return <KBRefLink id={value} />;
  }

  // Source / key-publication URLs
  if (
    (fieldName === "source" ||
      fieldName === "key-publication" ||
      fieldName === "key_publication") &&
    typeof value === "string" &&
    isUrl(value)
  ) {
    return (
      <a
        href={value}
        className="text-primary hover:underline text-xs"
        target="_blank"
        rel="noopener noreferrer"
      >
        {shortDomain(value)}
      </a>
    );
  }

  // Numbers with unit
  if (fieldType === "number" && typeof value === "number") {
    // Fraction fields (0-1 range) display as percentages
    if (isFractionField(fieldName, fieldDef) && value >= 0 && value <= 1) {
      return <span className="tabular-nums">{formatPercent(value)}</span>;
    }
    return (
      <span className="font-mono text-sm tabular-nums">
        {formatKBNumber(value, fieldDef?.unit)}
      </span>
    );
  }

  // Array of numbers (ranges like [0.015, 0.025])
  if (fieldType === "number" && Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number")) {
    if (isFractionField(fieldName, fieldDef)) {
      return <span className="tabular-nums">{formatPercent(value[0])}&ndash;{formatPercent(value[1])}</span>;
    }
    return <span className="tabular-nums">{formatKBNumber(value[0], fieldDef?.unit)}&ndash;{formatKBNumber(value[1], fieldDef?.unit)}</span>;
  }

  // Dates
  if (fieldType === "date" && typeof value === "string") {
    return (
      <span className="whitespace-nowrap text-muted-foreground">
        {formatKBDate(value)}
      </span>
    );
  }

  // Booleans
  if (fieldType === "boolean" || typeof value === "boolean") {
    return (
      <span className="text-muted-foreground" aria-label={value ? "Yes" : "No"}>
        {value ? "\u2713" : "\u2717"}
      </span>
    );
  }

  // Fallback
  return <>{formatKBCellValue(value, fieldDef)}</>;
}
