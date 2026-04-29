/**
 * Numeric formatting helpers for the entity-profile Database Records tab.
 * Extracted from entity-profile-viewer.tsx so they're testable in isolation.
 *
 * The viewer's `CellValue` consults these to decide whether a column should
 * render as compact currency (`$450M`), a percentage (`7.0%`), a generic
 * compact number (`1.7B`), or fall through to the string renderer.
 */

/** Columns representing monetary amounts. Drizzle's `numeric()` arrives as a
 *  string in the row, so the formatter must accept either. */
export const CURRENCY_COLUMNS = new Set([
  "amount", "raised", "raised_low", "raised_high",
  "valuation", "valuation_low", "valuation_high",
  "amount_low", "amount_high", "total_budget",
  "usd_equivalent", "cost_usd",
]);

/** Columns storing 0–1 decimal fractions that should render as `X.X%`. */
export const PERCENTAGE_COLUMNS = new Set([
  "stake_low", "stake_high",
]);

/** Visible entity-ref columns that should fall back to a raw legacy text
 *  column (typically also in HIDDEN_COLUMNS) when the FK is null. Avoids
 *  showing em-dash on funding-round rows that only have legacy raw text. */
export const ENTITY_REF_FALLBACKS: Partial<Record<string, string>> = {
  // lead_investor_entity_id renders as the "Lead Investor" column. When the
  // FK is unresolved, fall back to the raw legacy text column.
  lead_investor_entity_id: "leadInvestor",
};

/**
 * Resolve the value for a cell in the entity-profile rendering loop, applying
 * the `ENTITY_REF_FALLBACKS` mapping when the primary value is empty.
 *
 * Returns `{ value, isFallback }` so the caller can visually mark fallback
 * renders — the admin DB Records tab is a debugging surface, and silently
 * substituting legacy text for a null FK could hide data-quality issues if
 * we didn't call it out.
 *
 * Fallback only fires when:
 *   - the column has an entry in `ENTITY_REF_FALLBACKS`,
 *   - the primary value is `null` / `undefined` / empty string,
 *   - the fallback row key resolves to a non-empty *string* (objects /
 *     numbers / booleans are rejected — a column labeled "Lead Investor"
 *     showing a JSON blob would be worse than em-dash).
 */
export function resolveFallbackValue(
  primary: unknown,
  columnName: string,
  row: Record<string, unknown> | undefined,
): { value: unknown; isFallback: boolean } {
  if (primary !== null && primary !== undefined && primary !== "") {
    return { value: primary, isFallback: false };
  }
  const fallbackKey = ENTITY_REF_FALLBACKS[columnName];
  if (!fallbackKey || !row) return { value: primary, isFallback: false };
  const candidate = row[fallbackKey];
  if (typeof candidate !== "string" || candidate === "") {
    return { value: primary, isFallback: false };
  }
  return { value: candidate, isFallback: true };
}

/**
 * Try to parse a value as a finite number. Accepts both `number` (already
 * parsed) and `string` (Drizzle numeric()/bigint encoding). Rejects:
 *   - null / undefined / non-numeric types
 *   - empty / whitespace-only strings
 *   - range strings like "[0.07, 0.15]" or JSON object/array literals
 *   - NaN, Infinity, -Infinity
 */
export function tryParseNumeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("{")) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Format a numeric stake/percentage value. PG stores stakes as 0–1 decimals
 * (`0.07` = 7%), but a few legacy rows already encode them as percent points
 * (`15` = 15%). We disambiguate on `Math.abs(n) > 1`.
 */
export function formatPercentage(n: number): string {
  const pct = Math.abs(n) > 1 ? n : n * 100;
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}
