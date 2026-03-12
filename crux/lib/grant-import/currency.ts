/**
 * Currency conversion utilities for grant import.
 *
 * Uses hardcoded approximate exchange rates — grant amounts are already
 * approximate, so exact real-time rates are unnecessary.
 * Rates are rough averages as of early 2025.
 */

/** Supported currency codes. */
export type CurrencyCode =
  | "USD"
  | "GBP"
  | "EUR"
  | "CHF"
  | "CAD"
  | "AUD"
  | "SEK"
  | "NOK"
  | "DKK";

/**
 * Approximate exchange rates to USD.
 * 1 unit of foreign currency = X USD.
 */
const RATES_TO_USD: Record<CurrencyCode, number> = {
  USD: 1.0,
  GBP: 1.27,
  EUR: 1.08,
  CHF: 1.13,
  CAD: 0.74,
  AUD: 0.65,
  SEK: 0.096,
  NOK: 0.094,
  DKK: 0.145,
};

/** Currency symbols for display. */
const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: "$",
  GBP: "\u00a3",
  EUR: "\u20ac",
  CHF: "CHF\u00a0",
  CAD: "CA$",
  AUD: "A$",
  SEK: "SEK\u00a0",
  NOK: "NOK\u00a0",
  DKK: "DKK\u00a0",
};

const SUPPORTED_CURRENCIES = new Set(Object.keys(RATES_TO_USD));

/** Check whether a string is a supported currency code. */
export function isSupportedCurrency(currency: string): currency is CurrencyCode {
  return SUPPORTED_CURRENCIES.has(currency);
}

/**
 * Convert an amount from any supported currency to USD.
 * Throws if the currency is not recognized.
 */
export function convertToUSD(amount: number, currency: string): number {
  if (!isSupportedCurrency(currency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  const rate = RATES_TO_USD[currency];
  return Math.round(amount * rate * 100) / 100;
}

/**
 * Format a monetary amount with the appropriate currency symbol and
 * human-readable magnitude suffix.
 *
 * Examples:
 *   formatAmount(1_200_000, "USD") => "$1.2M"
 *   formatAmount(500_000, "GBP")   => "£500K"
 *   formatAmount(300_000, "EUR")   => "€300K"
 *   formatAmount(1_500, "USD")     => "$1,500"
 */
export function formatAmount(amount: number, currency: string): string {
  const symbol = isSupportedCurrency(currency)
    ? CURRENCY_SYMBOLS[currency]
    : `${currency}\u00a0`;

  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";

  if (abs >= 1_000_000) {
    const millions = abs / 1_000_000;
    // Show one decimal if not a round number of millions
    const formatted = millions % 1 === 0
      ? millions.toFixed(0)
      : millions.toFixed(1);
    return `${sign}${symbol}${formatted}M`;
  }

  if (abs >= 10_000) {
    const thousands = abs / 1_000;
    const formatted = thousands % 1 === 0
      ? thousands.toFixed(0)
      : thousands.toFixed(1);
    return `${sign}${symbol}${formatted}K`;
  }

  return `${sign}${symbol}${abs.toLocaleString("en-US")}`;
}

/**
 * Get the exchange rate for a currency to USD.
 * Returns null if the currency is not supported.
 */
export function getRate(currency: string): number | null {
  if (!isSupportedCurrency(currency)) return null;
  return RATES_TO_USD[currency];
}
