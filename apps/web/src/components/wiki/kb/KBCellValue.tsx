/**
 * KBCellValue — Shared cell value renderer for KB table components.
 *
 * Used by both KBItemTable and KBItemCollection to render type-aware cell values
 * with consistent formatting. Supports refs, URLs, numbers, dates, and booleans.
 */

import type { FieldDef } from "@longterm-wiki/kb";
import {
  formatKBCellValue,
  formatKBDate,
  formatKBNumber,
  isUrl,
  shortDomain,
} from "./format";
import { KBRefLink } from "./KBRefLink";

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
    return (
      <span className="font-mono text-sm tabular-nums">
        {formatKBNumber(value, fieldDef?.unit)}
      </span>
    );
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
      <span className="text-muted-foreground">
        {value ? "\u2713" : "\u2014"}
      </span>
    );
  }

  // Fallback
  return <>{formatKBCellValue(value, fieldDef)}</>;
}
