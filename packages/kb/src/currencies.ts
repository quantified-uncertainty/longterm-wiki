/**
 * Currency registry for multi-currency KB facts.
 *
 * Maps ISO 4217 currency codes to display information.
 * Used by formatters across the KB package and frontend.
 */

export interface CurrencyFormat {
  /** ISO 4217 code: "USD", "GBP", "EUR" */
  code: string;
  /** Display symbol: "$", "£", "€", "C$" */
  symbol: string;
  /** Full name: "US Dollar", "British Pound" */
  name: string;
  /** Where the symbol goes relative to the number */
  symbolPosition: "prefix" | "suffix";
}

export const CURRENCIES: Record<string, CurrencyFormat> = {
  USD: { code: "USD", symbol: "$", name: "US Dollar", symbolPosition: "prefix" },
  GBP: { code: "GBP", symbol: "£", name: "British Pound", symbolPosition: "prefix" },
  EUR: { code: "EUR", symbol: "€", name: "Euro", symbolPosition: "prefix" },
  CAD: { code: "CAD", symbol: "C$", name: "Canadian Dollar", symbolPosition: "prefix" },
  JPY: { code: "JPY", symbol: "¥", name: "Japanese Yen", symbolPosition: "prefix" },
  CHF: { code: "CHF", symbol: "CHF ", name: "Swiss Franc", symbolPosition: "prefix" },
  AUD: { code: "AUD", symbol: "A$", name: "Australian Dollar", symbolPosition: "prefix" },
  SGD: { code: "SGD", symbol: "S$", name: "Singapore Dollar", symbolPosition: "prefix" },
  CNY: { code: "CNY", symbol: "¥", name: "Chinese Yuan", symbolPosition: "prefix" },
  KRW: { code: "KRW", symbol: "₩", name: "South Korean Won", symbolPosition: "prefix" },
  INR: { code: "INR", symbol: "₹", name: "Indian Rupee", symbolPosition: "prefix" },
  SEK: { code: "SEK", symbol: "kr", name: "Swedish Krona", symbolPosition: "suffix" },
  NOK: { code: "NOK", symbol: "kr", name: "Norwegian Krone", symbolPosition: "suffix" },
};

/**
 * Resolve the effective currency for a fact.
 *
 * Priority: fact-level currency override > property unit > "USD" default.
 * Returns a valid currency code from the CURRENCIES registry.
 */
export function resolveCurrency(
  factCurrency?: string,
  propertyUnit?: string,
): string {
  if (factCurrency && Object.hasOwn(CURRENCIES, factCurrency)) return factCurrency;
  if (propertyUnit && Object.hasOwn(CURRENCIES, propertyUnit)) return propertyUnit;
  return "USD";
}

/**
 * Check if a string is a known currency code.
 */
export function isCurrencyCode(code: string): boolean {
  return Object.hasOwn(CURRENCIES, code);
}
