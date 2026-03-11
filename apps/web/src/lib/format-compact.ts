/**
 * Client-safe compact formatting utilities for directory pages.
 * No server-only imports — safe for "use client" components.
 */

/** Format a number as compact currency: $1.2T, $850M, $42K */
export function formatCompactCurrency(n: number | null | undefined): string {
  if (n == null) return "";
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

/** Format a number as compact: 1.2T, 850M, 42K (no currency symbol) */
export function formatCompactNumber(n: number | null | undefined): string {
  if (n == null) return "";
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
}
