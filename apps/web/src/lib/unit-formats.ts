/**
 * UNIT_FORMATS — display format definitions for structured statement values.
 *
 * Referenced by `properties.unit_format_id` in the database. Adding a new
 * display format requires a code PR (not a DB change).
 *
 * Convention: raw values are stored as-is in the database (e.g., 40 for 40%).
 * The format's `divisor` controls how the raw value is scaled for display.
 */

export interface UnitFormat {
  id: string;
  prefix: string;
  suffix: string;
  /** Divide the raw value by this to get the display value. */
  divisor: number;
}

export const UNIT_FORMATS: Record<string, UnitFormat> = {
  "usd-billions": {
    id: "usd-billions",
    prefix: "$",
    suffix: "B",
    divisor: 1e9,
  },
  "usd-millions": {
    id: "usd-millions",
    prefix: "$",
    suffix: "M",
    divisor: 1e6,
  },
  "gbp-billions": { id: "gbp-billions", prefix: "£", suffix: "B", divisor: 1e9 },
  "gbp-millions": { id: "gbp-millions", prefix: "£", suffix: "M", divisor: 1e6 },
  "eur-billions": { id: "eur-billions", prefix: "€", suffix: "B", divisor: 1e9 },
  "eur-millions": { id: "eur-millions", prefix: "€", suffix: "M", divisor: 1e6 },
  "cad-millions": { id: "cad-millions", prefix: "C$", suffix: "M", divisor: 1e6 },
  "jpy-billions": { id: "jpy-billions", prefix: "¥", suffix: "B", divisor: 1e9 },
  percent: { id: "percent", prefix: "", suffix: "%", divisor: 1 },
  count: { id: "count", prefix: "", suffix: "", divisor: 1 },
  tokens: { id: "tokens", prefix: "", suffix: " tokens", divisor: 1 },
  fte: { id: "fte", prefix: "", suffix: " FTE", divisor: 1 },
  flop: { id: "flop", prefix: "", suffix: " FLOP", divisor: 1 },
};

/**
 * Format a numeric value using a UNIT_FORMATS entry.
 *
 * Returns a human-readable string like "$380B", "40%", or "1,200".
 * Falls back to locale-formatted number if formatId is null or unknown.
 */
export function formatWithUnitFormat(
  value: number,
  formatId: string | null | undefined
): string {
  if (!formatId || !(formatId in UNIT_FORMATS)) {
    return value.toLocaleString("en-US");
  }
  const fmt = UNIT_FORMATS[formatId];
  const scaled = value / fmt.divisor;

  // Format scaled value: integer if whole, 1 decimal otherwise
  let formatted: string;
  if (Number.isInteger(scaled)) {
    formatted = scaled.toLocaleString("en-US");
  } else {
    // Use up to 1 decimal, but strip trailing zeros
    formatted = scaled.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    });
  }

  // Handle negative values with prefix: "-$2.8B" not "$-2.8B"
  if (scaled < 0 && fmt.prefix) {
    return `-${fmt.prefix}${formatted.replace("-", "")}${fmt.suffix}`;
  }

  return `${fmt.prefix}${formatted}${fmt.suffix}`;
}
