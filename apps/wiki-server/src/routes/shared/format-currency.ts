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
 * Format an amount compactly for display in things.description where
 * readability matters more than precision (e.g. "$1.7B", "70B", "£1.3B").
 *
 * Values below 1,000 are rendered with grouping separators (e.g. "$500") so
 * the output never contains a bare 10+ digit run — critical for the e2e
 * render-audit regression that caught raw numbers like "1700000000" leaking
 * into fact thing descriptions (QUA-673).
 *
 * Accepts number, pure-numeric string ("7e+10", "1700000000", "-0.5"), or
 * nullish. Returns null for nullish / non-finite / non-numeric inputs so the
 * caller can fall back to the raw text.
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

  // Match the client's format-compact.ts precision rules so a fact's
  // server-composed `things.description` and its client-rendered sibling
  // cells render with the same compactness: below 10 of a unit → keep
  // 1 decimal ("$1.7B"), at or above 10 of a unit → drop decimals
  // ("$70B", "$165B"). Without this Intl always keeps 1 decimal, so the
  // Database tab would show "$164.5B" next to "165B" for the same value.
  const abs = Math.abs(n);
  let scaleAbs: number;
  if (abs >= 1e12) scaleAbs = abs / 1e12;
  else if (abs >= 1e9) scaleAbs = abs / 1e9;
  else if (abs >= 1e6) scaleAbs = abs / 1e6;
  else if (abs >= 1e3) scaleAbs = abs / 1e3;
  else scaleAbs = abs;
  const fractionDigits = scaleAbs < 10 && abs >= 1e3 ? 1 : 0;

  const code = currency ? currency.toUpperCase() : null;
  const opts: Intl.NumberFormatOptions = {
    notation: "compact",
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  };
  if (code) {
    opts.style = "currency";
    opts.currency = code;
  }
  try {
    return new Intl.NumberFormat("en-US", opts).format(n);
  } catch {
    // Malformed currency code — fall back to grouped decimal so no bare
    // run of 10+ digits leaks to callers that use this for display.
    return n.toLocaleString("en-US");
  }
}
