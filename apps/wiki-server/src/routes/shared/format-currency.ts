/**
 * Format a numeric amount with its currency code for display in things.description
 * and similar user-visible strings.
 *
 * Uses `Intl.NumberFormat` with `style: 'currency'` so the output respects the
 * currency's native symbol (USD → $, EUR → €, GBP → £, JPY → ¥, etc.) and
 * locale conventions. Amounts are rendered without cents since domain-table
 * values (grants, funding rounds) are always whole-unit figures.
 *
 * Invalid or unknown currency codes fall back to the numeric-only `toLocaleString`
 * rendering so the formatter can never throw at write time.
 */
export function formatMoney(
  amount: number | string | null | undefined,
  currency: string | null | undefined
): string | null {
  if (amount == null) return null;
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return null;

  const code = (currency ?? "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return n.toLocaleString("en-US");
  }
}

/** Regex matching a pure numeric string (optionally signed, decimal, or in scientific notation). */
const PURE_NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Bounded cache of `Intl.NumberFormat` instances keyed by the (currency,
 * fractionDigits) tuple. A batch fact sync composes hundreds of rows back
 * to back; allocating a new formatter per row dominates the compose cost.
 * Currencies are few (USD/EUR/GBP/…) and fractionDigits is 0 or 1, so the
 * cache stays under ~20 entries.
 */
const FORMATTER_CACHE = new Map<string, Intl.NumberFormat>();

function getCompactFormatter(
  currency: string | null,
  fractionDigits: number,
): Intl.NumberFormat {
  const key = `${currency ?? ""}|${fractionDigits}`;
  const cached = FORMATTER_CACHE.get(key);
  if (cached) return cached;
  const opts: Intl.NumberFormatOptions = {
    notation: "compact",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  };
  if (currency) {
    opts.style = "currency";
    opts.currency = currency;
  }
  const formatter = new Intl.NumberFormat("en-US", opts);
  FORMATTER_CACHE.set(key, formatter);
  return formatter;
}

/**
 * Compact-format an amount for display in things.description
 * (e.g. `"$1.7B"`, `"70B"`, `"£1.3B"`). Accepts number, pure-numeric
 * string (`"7e+10"`, `"1700000000"`, `"-0.5"`), or nullish — returns null
 * for nullish / non-finite / non-numeric so the caller can fall back to
 * the raw text. Output never contains a bare 10+ digit run (every scale
 * branch uses a grouping separator or SI suffix).
 */
export function formatCompactAmount(
  amount: number | string | null | undefined,
  currency?: string | null
): string | null {
  if (amount == null) return null;
  let n: number;
  if (typeof amount === "number") {
    n = amount;
  } else {
    const trimmed = amount.trim();
    if (!PURE_NUMERIC_RE.test(trimmed)) return null;
    n = Number(trimmed);
  }
  if (!Number.isFinite(n)) return null;

  // Precision mirrors apps/web/src/lib/format-compact.ts: below 10 of a
  // unit keep 1 decimal ("$1.7B"); at or above, drop decimals ("$70B").
  // Without this rule Intl always keeps 1 decimal, and the Database tab
  // would show server "$164.5B" next to client "165B" for the same value.
  const abs = Math.abs(n);
  let scaleAbs: number;
  if (abs >= 1e12) scaleAbs = abs / 1e12;
  else if (abs >= 1e9) scaleAbs = abs / 1e9;
  else if (abs >= 1e6) scaleAbs = abs / 1e6;
  else if (abs >= 1e3) scaleAbs = abs / 1e3;
  else scaleAbs = abs;
  const fractionDigits = scaleAbs < 10 && abs >= 1e3 ? 1 : 0;

  const code = currency ? currency.toUpperCase() : null;
  try {
    return getCompactFormatter(code, fractionDigits).format(n);
  } catch {
    // Malformed currency code — fall back to grouped decimal so no bare
    // run of 10+ digits leaks to callers that use this for display.
    return n.toLocaleString("en-US");
  }
}
