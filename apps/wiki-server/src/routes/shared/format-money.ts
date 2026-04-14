/**
 * Format a monetary amount with currency code.
 *
 * Falls back to `${code} 1,234,567` for codes that Intl.NumberFormat doesn't
 * recognize (rare — most ISO 4217 codes are supported in Node's small-icu
 * build). Defaults currency to USD when null/undefined/empty.
 *
 * Used by sync handlers writing to `things.description` and elsewhere a
 * compact monetary string is needed.
 */
export function formatMoney(
  amount: number | string,
  currency: string | null | undefined = "USD",
): string {
  const num = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(num)) return String(amount);

  const code = (currency ?? "USD").trim() || "USD";

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(num);
  } catch {
    return `${code} ${num.toLocaleString("en-US")}`;
  }
}
