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
